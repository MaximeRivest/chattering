package app.rockfrog.chattering

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Notifications keep coming after the phone restarts or the app updates
 *  (design/100): the listener starts again if the person had it on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            NotifyService.startIfEnabled(context)
        }
    }
}
