package app.rockfrog.chattering

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.webkit.JavascriptInterface
import android.webkit.WebView
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Direct dictation for the Chattering compose box.
 *
 * Android captures raw speech without opening the keyboard. A WebSocket sends
 * live previews after pauses. On stop, one whole-recording HTTP request creates
 * the final transcript, which gives Parakeet the full context.
 */
class SpeechBridge(
    private val activity: MainActivity,
    private val web: WebView,
) {
    companion object {
        private const val TARGET_RATE = 16000
        private const val MAX_BYTES = TARGET_RATE * 2 * 600
    }

    private val audioExecutor = Executors.newSingleThreadExecutor()
    // Speech goes through the chattering server's own relay (/api/speech/*),
    // so it reaches the GPU stage from wherever the page itself is reachable
    // instead of needing a second, LAN-only address.
    private var clientBase = ""
    private var cachedClient: OkHttpClient? = null
    private val client: OkHttpClient
        get() {
            val base = activity.serverBase
            return cachedClient?.takeIf { clientBase == base }
                ?: ServerReach.httpClient(base).also { cachedClient = it; clientBase = base }
        }

    private fun authed(builder: Request.Builder): Request.Builder {
        val token = activity.serverToken
        return if (token.isEmpty()) builder else builder.header("Authorization", "Bearer $token")
    }

    @Volatile private var recording = false
    @Volatile private var streamReady = false
    @Volatile private var socket: WebSocket? = null
    private var audioRecord: AudioRecord? = null
    private var captureRate = TARGET_RATE

    @JavascriptInterface
    fun isRecording(): Boolean = recording

    @JavascriptInterface
    fun toggle() {
        activity.runOnUiThread {
            if (recording) stop() else requestStart()
        }
    }

    private fun requestStart() {
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            emit("permission", message = "Allow microphone access to start dictation.")
            activity.requestSpeechPermission()
            return
        }
        start()
    }

    fun onPermissionResult(granted: Boolean) {
        if (granted) start()
        else emit("error", message = "Microphone access was not allowed.")
    }

    @SuppressLint("MissingPermission")
    private fun start() {
        if (recording || audioRecord != null) return
        try {
            val record = openAudioRecord()
            audioRecord = record
            recording = true
            openStream()
            record.startRecording()
            emit("recording")
            audioExecutor.execute { recordLoop(record, captureRate) }
        } catch (error: Exception) {
            recording = false
            audioRecord?.release()
            audioRecord = null
            emit("error", message = "Microphone error: ${error.message ?: "unknown error"}")
        }
    }

    private fun stop() {
        if (!recording) return
        recording = false
        emit("transcribing")
        // The audio thread drains the hardware buffer before it stops the
        // AudioRecord. This keeps the last words spoken before the stop tap.
    }

    private fun openAudioRecord(): AudioRecord {
        val record = Microphone.open(intArrayOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC))
        captureRate = record.sampleRate
        return record
    }

    private fun openStream() {
        closeStream()
        streamReady = false
        val request = authed(Request.Builder()
            .url(ServerReach.webSocketBase(activity.serverBase) + "/api/speech/stream")).build()
        lateinit var opened: WebSocket
        opened = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== socket) return
                try {
                    val json = JSONObject(text)
                    when (json.optString("type")) {
                        "ready" -> streamReady = true
                        "preview" -> {
                            val transcript = listOf(
                                json.optString("committed"),
                                json.optString("stable"),
                                json.optString("volatile"),
                            ).filter { it.isNotBlank() }.joinToString(" ")
                            if (recording && transcript.isNotBlank()) {
                                emit("preview", text = transcript)
                            }
                        }
                        "error" -> emit("notice", message = "Live preview is unavailable; recording continues.")
                    }
                } catch (_: Exception) {
                }
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                if (webSocket !== socket) return
                streamReady = false
                socket = null
                if (recording) emit("notice", message = "Live preview is unavailable; recording continues.")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket === socket) {
                    streamReady = false
                    socket = null
                }
            }
        })
        socket = opened
    }

    private fun closeStream() {
        val old = socket
        socket = null
        streamReady = false
        old?.close(1000, "done")
    }

    private fun recordLoop(record: AudioRecord, rate: Int) {
        val complete = ByteArrayOutputStream()
        val backlog = ByteArrayOutputStream()
        val readBuffer = ByteArray((rate / 10) * 2)
        val downsampler = if (rate == TARGET_RATE) null else Downsampler(rate)
        try {
            while (recording && complete.size() < MAX_BYTES) {
                val read = record.read(readBuffer, 0, readBuffer.size)
                if (read < 0) throw IllegalStateException("AudioRecord returned $read")
                if (read == 0) continue
                val chunk = downsampler?.process(readBuffer, read)
                    ?: readBuffer.copyOf(read)
                if (chunk.isEmpty()) continue
                complete.write(chunk)
                sendOrQueue(chunk, backlog)
            }
            if (recording) {
                // The ten-minute safety cap acts like a stop tap.
                recording = false
                emit("transcribing")
            }

            // Read all samples already captured when the user pressed stop.
            while (complete.size() < MAX_BYTES) {
                val read = record.read(
                    readBuffer, 0, readBuffer.size, AudioRecord.READ_NON_BLOCKING)
                if (read <= 0) break
                val chunk = downsampler?.process(readBuffer, read)
                    ?: readBuffer.copyOf(read)
                if (chunk.isEmpty()) continue
                complete.write(chunk)
                sendOrQueue(chunk, backlog)
            }
            try { record.stop() } catch (_: IllegalStateException) {}
        } catch (error: Exception) {
            recording = false
            emit("error", message = "Recording error: ${error.message ?: "unknown error"}")
        } finally {
            record.release()
            if (audioRecord === record) audioRecord = null
        }

        closeStream()
        val pcm = complete.toByteArray()
        if (pcm.size < 3200) {
            emit("error", message = "Recording was too short.")
            return
        }
        transcribe(pcm)
    }

    private fun sendOrQueue(chunk: ByteArray, backlog: ByteArrayOutputStream) {
        val current = socket
        if (current != null && streamReady) {
            if (backlog.size() > 0) {
                current.send(ByteString.of(*backlog.toByteArray()))
                backlog.reset()
            }
            current.send(ByteString.of(*chunk))
        } else if (backlog.size() < 2 * 1024 * 1024) {
            backlog.write(chunk)
        }
    }

    private fun transcribe(pcm: ByteArray) {
        try {
            val timeout = 60000L + pcm.size / 128L
            val finalClient = client.newBuilder()
                .readTimeout(timeout, TimeUnit.MILLISECONDS)
                .build()
            val media = MediaType.parse("audio/L16;rate=16000;channels=1")
            val body = RequestBody.create(media, pcm)
            val request = authed(Request.Builder()
                .url(activity.serverBase + "/api/speech/transcribe")
                .post(body))
                .build()
            finalClient.newCall(request).execute().use { response ->
                val text = response.body()?.string()?.trim().orEmpty()
                if (!response.isSuccessful) {
                    throw IllegalStateException(text.ifBlank { "speech service returned ${response.code()}" })
                }
                if (text.isBlank()) throw IllegalStateException("No speech was recognized")
                emit("final", text = text)
            }
        } catch (error: Exception) {
            emit("error", message = "Speech error: ${error.message ?: "unknown error"}")
        }
    }

    fun destroy() {
        recording = false
        try { audioRecord?.stop() } catch (_: Exception) {}
        audioRecord?.release()
        audioRecord = null
        closeStream()
        audioExecutor.shutdownNow()
        cachedClient?.let {
            it.dispatcher().executorService().shutdownNow()
            it.connectionPool().evictAll()
        }
        cachedClient = null
    }

    private fun emit(type: String, text: String? = null, message: String? = null) {
        val event = JSONObject().put("type", type)
        if (text != null) event.put("text", text)
        if (message != null) event.put("message", message)
        val quoted = JSONObject.quote(event.toString())
        PageCall.run(web, "w.agentSpeechEvent&&w.agentSpeechEvent($quoted)")
    }

    /** Chunk-stable boxcar downsampler copied from the proven IME path. */
    internal class Downsampler(captureRate: Int) {
        private val step = captureRate / TARGET_RATE.toDouble()
        private var position = 0.0
        private var pending = ShortArray(0)

        fun process(pcm: ByteArray, count: Int): ByteArray {
            val input = count / 2
            val samples = ShortArray(pending.size + input)
            pending.copyInto(samples)
            for (i in 0 until input) {
                samples[pending.size + i] =
                    ((pcm[2 * i].toInt() and 0xff) or (pcm[2 * i + 1].toInt() shl 8)).toShort()
            }
            val output = ByteArrayOutputStream()
            while (position + step <= samples.size) {
                val from = position.toInt()
                var to = (position + step).toInt()
                if (to <= from) to = from + 1
                var sum = 0L
                for (i in from until to) sum += samples[i]
                val value = kotlin.math.round(sum / (to - from).toDouble()).toInt()
                output.write(value and 0xff)
                output.write((value shr 8) and 0xff)
                position += step
            }
            val consumed = position.toInt()
            pending = samples.copyOfRange(consumed, samples.size)
            position -= consumed
            return output.toByteArray()
        }
    }
}
