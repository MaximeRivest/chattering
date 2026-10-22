package app.rockfrog.chattering

import android.app.PendingIntent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** A quick-settings tile, "Call the frog": one swipe down and a tap, from
 *  any app, with the phone locked too. It opens Chattering on the frog with
 *  Talk on; with a call on, it hangs up. Add it from the quick-settings
 *  panel's edit button. */
class FrogCallTile : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val t = qsTile ?: return
        t.state = if (FrogCallService.onCall) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.label = if (FrogCallService.onCall) "Hang up the frog" else "Call the frog"
        if (Build.VERSION.SDK_INT >= 29) t.subtitle = if (FrogCallService.onCall) "talking" else "Chattering"
        t.updateTile()
    }

    override fun onClick() {
        super.onClick()
        if (FrogCallService.onCall) { FrogCallService.hangUp(this); return }
        val intent = FrogCallService.openIntent(this, "start")
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 19, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
