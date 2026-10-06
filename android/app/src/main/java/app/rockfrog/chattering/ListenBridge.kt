package app.rockfrog.chattering

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.webkit.JavascriptInterface
import android.webkit.WebView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.Executors

/** The phone's microphone for always-listening voice commands.
 *
 * A page on plain http gets no microphone from the WebView (browsers give it
 * only to secure pages), and the app loads the server over http on the LAN.
 * The app has the microphone permission itself, so it does the listening:
 * it streams 16 kHz mono PCM to the server's /api/voice/listen, exactly what
 * the page would send, and hands every event the server sends back to the
 * page (window.voiceNativeEvent), which then works as in a browser.
 *
 * Listening pauses while the app is not on screen (Android gives no
 * microphone to an app in the background without a foreground service, and
 * a room should not be heard with the screen off) and resumes when it is.
 *
 * Page API (ChatteringListen): start(windowSeconds), stop(), setWindow(s),
 * isListening(). Events to the page: the server's own JSON, plus
 * {type:'native', state:'open'|'paused'|'closed'|'error', message}.
 */
class ListenBridge(
    private val activity: MainActivity,
    private val web: WebView,
) {
    companion object {
        private const val TARGET_RATE = 16000
    }

    private val audioExecutor = Executors.newSingleThreadExecutor()
    private var clientBase = ""
    private var cachedClient: OkHttpClient? = null
    private val client: OkHttpClient
        get() {
            val base = activity.serverBase
            return cachedClient?.takeIf { clientBase == base }
                ?: ServerReach.httpClient(base).also { cachedClient = it; clientBase = base }
        }

    @Volatile private var wanted = false      // the page asked to listen
    @Volatile private var capturing = false   // the microphone is open
    @Volatile private var socket: WebSocket? = null
    @Volatile private var windowSeconds = 60
    private var audioRecord: AudioRecord? = null

    @JavascriptInterface
    fun isListening(): Boolean = wanted

    @JavascriptInterface
    fun start(seconds: Int) {
        windowSeconds = seconds
        activity.runOnUiThread {
            wanted = true
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
                emitNative("error", "Allow microphone access for voice commands.")
                activity.requestListenPermission()
                return@runOnUiThread
            }
            open()
        }
    }

    @JavascriptInterface
    fun stop() {
        activity.runOnUiThread {
            wanted = false
            // The server hands on the last words, then closes.
            socket?.send("{\"type\":\"stop\"}")
            close(sayStop = false)
            emitNative("closed", null)
        }
    }

    @JavascriptInterface
    fun setWindow(seconds: Int) {
        windowSeconds = seconds
        socket?.send(JSONObject().put("type", "window").put("seconds", seconds).toString())
    }

    fun onPermissionResult(granted: Boolean) {
        if (!wanted) return
        if (granted) open()
        else { wanted = false; emitNative("error", "Microphone access was not allowed.") }
    }

    /** The app left the screen: stop hearing the room, keep the wish. */
    fun onPause() {
        if (!wanted || !capturing) return
        close(sayStop = true)
        emitNative("paused", "paused while the app is in the background")
    }

    fun onResume() {
        if (wanted && !capturing &&
            activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) open()
    }

    private fun open() {
        if (capturing) return
        val token = activity.serverToken
        val builder = Request.Builder()
            .url(ServerReach.webSocketBase(activity.serverBase) + "/api/voice/listen?window=" + windowSeconds)
        if (token.isNotEmpty()) builder.header("Authorization", "Bearer $token")
        lateinit var opened: WebSocket
        opened = client.newWebSocket(builder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== socket) return
                activity.runOnUiThread { startCapture(webSocket) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket === socket) emitRaw(text)
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                if (webSocket !== socket) return
                val why = when (response?.code()) {
                    401, 403 -> "the server refused voice commands here"
                    503 -> "no speech-to-text server is set"
                    else -> error.message ?: "the connection failed"
                }
                activity.runOnUiThread { close(sayStop = false); emitNative("error", why) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== socket) return
                activity.runOnUiThread { close(sayStop = false); if (wanted) emitNative("error", "the server closed the connection") }
            }
        })
        socket = opened
    }

    @SuppressLint("MissingPermission")
    private fun startCapture(ws: WebSocket) {
        if (capturing || socket !== ws) return
        val record = try { openAudioRecord() } catch (e: Exception) {
            close(sayStop = false)
            emitNative("error", "Microphone error: ${e.message ?: "unknown"}")
            return
        }
        audioRecord = record
        capturing = true
        record.startRecording()
        emitNative("open", null)
        audioExecutor.execute { captureLoop(record, ws) }
    }

    private fun captureLoop(record: AudioRecord, ws: WebSocket) {
        val rate = record.sampleRate
        val buffer = ByteArray((rate / 10) * 2)
        val down = if (rate == TARGET_RATE) null else SpeechBridge.Downsampler(rate)
        try {
            while (capturing && socket === ws) {
                val read = record.read(buffer, 0, buffer.size)
                if (read < 0) throw IllegalStateException("AudioRecord returned $read")
                if (read == 0) continue
                val chunk = down?.process(buffer, read) ?: buffer.copyOf(read)
                if (chunk.isNotEmpty()) ws.send(ByteString.of(*chunk))
            }
        } catch (e: Exception) {
            activity.runOnUiThread { close(sayStop = false); emitNative("error", "Recording error: ${e.message ?: "unknown"}") }
        } finally {
            try { record.stop() } catch (_: Exception) {}
            record.release()
        }
    }

    // Close the microphone and the connection. sayStop: ask the server to
    // hand on the last words first.
    private fun close(sayStop: Boolean) {
        capturing = false
        audioRecord = null   // released by the capture loop
        val old = socket
        socket = null
        if (old != null) {
            if (sayStop) old.send("{\"type\":\"stop\"}")
            old.close(1000, "done")
        }
    }

    // Plain microphone: the page asks for no noise suppression or gain
    // either (they hurt recognition). VOICE_RECOGNITION as the fallback.
    private fun openAudioRecord(): AudioRecord =
        Microphone.open(intArrayOf(MediaRecorder.AudioSource.MIC, MediaRecorder.AudioSource.VOICE_RECOGNITION))

    fun destroy() {
        wanted = false
        close(sayStop = false)
        audioExecutor.shutdownNow()
        cachedClient?.let { it.dispatcher().executorService().shutdownNow(); it.connectionPool().evictAll() }
        cachedClient = null
    }

    private fun emitRaw(json: String) {
        val quoted = JSONObject.quote(json)
        PageCall.run(web, "w.voiceNativeEvent&&w.voiceNativeEvent(JSON.parse($quoted))")
    }

    private fun emitNative(state: String, message: String?) {
        val event = JSONObject().put("type", "native").put("state", state)
        if (message != null) event.put("message", message)
        emitRaw(event.toString())
    }
}
