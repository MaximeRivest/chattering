package app.rockfrog.chattering

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.view.KeyEvent

/** The headset's button (play/pause, or the hook) when no call is on:
 *  Android sends it here once the frog's call made this app the last one
 *  to play (FrogCallService, mediaStart). One press starts a call with the
 *  frog. Pressed with a call on, the button never reaches here: the call
 *  system has it (hang up). */
class FrogCallButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MEDIA_BUTTON) return
        @Suppress("DEPRECATION")
        val key = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return
        if (key.action != KeyEvent.ACTION_DOWN || key.repeatCount != 0) return
        when (key.keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> {
                if (FrogCallService.onCall) FrogCallService.hangUp(context) else FrogCallService.start(context)
            }
        }
    }
}
