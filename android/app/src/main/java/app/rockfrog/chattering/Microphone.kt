package app.rockfrog.chattering

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord

/** Opens the device's microphone as mono 16-bit PCM: at 16 kHz when the
 *  hardware offers it, else at 48 or 44.1 kHz (callers downsample with
 *  SpeechBridge.Downsampler). [sources] in order of preference. */
object Microphone {
    const val RATE = 16000

    @SuppressLint("MissingPermission")
    fun open(sources: IntArray): AudioRecord {
        for (rate in intArrayOf(RATE, 48000, 44100)) {
            val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (minimum <= 0) continue
            for (source in sources) {
                var candidate: AudioRecord? = null
                try {
                    candidate = AudioRecord(source, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, rate * 2) * 2)
                    if (candidate.state == AudioRecord.STATE_INITIALIZED) return candidate
                } catch (_: Exception) {}
                candidate?.release()
            }
        }
        throw IllegalStateException("the microphone could not be opened")
    }
}
