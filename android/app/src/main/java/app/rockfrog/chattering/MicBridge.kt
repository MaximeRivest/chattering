package app.rockfrog.chattering

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** The app's microphone, lent to the page: through the encrypted link.
 *
 * Connected by address, SpeechBridge and ListenBridge record and send the
 * audio to the server themselves. Through the encrypted link they cannot:
 * the app has no address for the computer, only the tunnel the page holds
 * (design/85). And the page cannot record for itself: the WebView's audio
 * graph never delivers a sample on the e-ink tablet. So here the app only
 * records, and hands the page 16 kHz mono PCM; the page sends it through
 * the tunnel, as a browser sends its own recording (app.html, appMicrophone).
 *
 * Page API (ChatteringMic): start() → session number, stop(session).
 * Events (window.chatteringMicEvent), each with its session:
 *   started  the microphone is open (again, after a pause)
 *   pcm      data: base64 of 16-bit little-endian samples, about 0.2 s
 *   paused   the app left the screen: the room is not heard in the
 *            background; recording resumes ('started') when it is back
 *   ended    after stop(), once the last samples were sent; or replaced
 *            by a newer session
 *   error    message: the microphone could not be used
 */
class MicBridge(
    private val activity: MainActivity,
    private val web: WebView,
) {
    companion object {
        private const val CHUNK_MS = 200
        private const val MAX_SECONDS = 600
    }

    // One recording at a time, on one thread: a new one opens the
    // microphone only after the previous one has released it.
    private val executor = Executors.newSingleThreadExecutor()
    private val sessions = AtomicInteger(0)
    @Volatile private var current = 0          // the session the page wants, 0: none
    @Volatile private var inBackground = false
    @Volatile private var resumeSession = 0    // paused by the background, to reopen
    @Volatile private var awaitingPermission = 0

    @JavascriptInterface
    fun start(): Int {
        val id = sessions.incrementAndGet()
        current = id
        activity.runOnUiThread {
            if (current != id) return@runOnUiThread
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                awaitingPermission = id
                activity.requestMicPermission()
            } else executor.execute { record(id) }
        }
        return id
    }

    @JavascriptInterface
    fun stop(session: Int) {
        if (current == session) current = 0
        if (awaitingPermission == session) { awaitingPermission = 0; emit(session, "ended") }
        if (resumeSession == session) { resumeSession = 0; emit(session, "ended") }
    }

    fun onPermissionResult(granted: Boolean) {
        val id = awaitingPermission
        awaitingPermission = 0
        if (id == 0) return
        if (!granted) { if (current == id) current = 0; emit(id, "error", "Microphone access was not allowed."); return }
        if (current == id) executor.execute { record(id) } else emit(id, "ended")
    }

    fun onPause() { inBackground = true }

    fun onResume() {
        inBackground = false
        val id = resumeSession
        if (id != 0 && id == current) { resumeSession = 0; executor.execute { record(id) } }
    }

    fun destroy() {
        current = 0
        executor.shutdownNow()
    }

    private fun record(id: Int) {
        if (current != id) { emit(id, "ended"); return }
        if (inBackground) { resumeSession = id; emit(id, "paused"); return }
        val record = try {
            Microphone.open(intArrayOf(MediaRecorder.AudioSource.MIC, MediaRecorder.AudioSource.VOICE_RECOGNITION))
        } catch (e: Exception) {
            if (current == id) current = 0
            emit(id, "error", "Microphone error: ${e.message ?: "unknown error"}")
            return
        }
        try {
            record.startRecording()
            emit(id, "started")
            val rate = record.sampleRate
            val buffer = ByteArray(rate * 2 * CHUNK_MS / 1000)
            val down = if (rate == Microphone.RATE) null else SpeechBridge.Downsampler(rate)
            var sent = 0L
            val cap = Microphone.RATE * 2L * MAX_SECONDS
            while (current == id && !inBackground && sent < cap) {
                val read = record.read(buffer, 0, buffer.size)
                if (read < 0) throw IllegalStateException("AudioRecord returned $read")
                if (read > 0) sent += send(id, down?.process(buffer, read) ?: buffer.copyOf(read))
            }
            // What was captured before the stop tap is part of the recording.
            while (true) {
                val read = record.read(buffer, 0, buffer.size, AudioRecord.READ_NON_BLOCKING)
                if (read <= 0) break
                send(id, down?.process(buffer, read) ?: buffer.copyOf(read))
            }
            try { record.stop() } catch (_: IllegalStateException) {}
        } catch (e: Exception) {
            if (current == id) current = 0
            emit(id, "error", "Recording error: ${e.message ?: "unknown error"}")
            return
        } finally {
            record.release()
        }
        if (current == id && inBackground) { resumeSession = id; emit(id, "paused") }
        else { if (current == id) current = 0; emit(id, "ended") }
    }

    private fun send(id: Int, chunk: ByteArray): Int {
        if (chunk.isEmpty()) return 0
        emit(id, "pcm", data = Base64.encodeToString(chunk, Base64.NO_WRAP))
        return chunk.size
    }

    private fun emit(id: Int, type: String, message: String? = null, data: String? = null) {
        val event = JSONObject().put("session", id).put("type", type)
        if (message != null) event.put("message", message)
        if (data != null) event.put("data", data)
        PageCall.run(web, "w.chatteringMicEvent&&w.chatteringMicEvent($event)")
    }
}
