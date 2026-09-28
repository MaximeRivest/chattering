package app.rockfrog.chattering

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Reply notifications for the phone.
 *
 * The web page inside the WebView is frozen as soon as the app leaves the
 * screen, so it cannot hear the laptop's event stream. This service keeps
 * its own connection to /api/events and turns each finished run into a
 * system notification. While the app is on screen the in-app unread panel
 * already shows the same thing, so the service stays quiet then.
 *
 * Android requires a persistent "running" notification for any service
 * that outlives the app; it is posted on a silent, minimum-importance
 * channel so it stays out of the way.
 */
class NotifyService : Service() {
    companion object {
        private const val CHANNEL_RUNNING = "running"
        private const val CHANNEL_REPLIES = "replies"
        private const val CHANNEL_QUIET = "quiet"
        private const val RUNNING_ID = 1
        private const val PREF_ENABLED = "notify"
        const val EXTRA_KEY = "conversationKey"

        /** True while MainActivity is resumed; the service stays quiet then. */
        @Volatile var appOnScreen = false

        fun isEnabled(ctx: Context): Boolean =
            ctx.getSharedPreferences("chattering", Context.MODE_PRIVATE).getBoolean(PREF_ENABLED, false)

        fun setEnabled(ctx: Context, on: Boolean) {
            ctx.getSharedPreferences("chattering", Context.MODE_PRIVATE).edit().putBoolean(PREF_ENABLED, on).apply()
            val intent = Intent(ctx, NotifyService::class.java)
            if (on) ctx.startForegroundService(intent) else ctx.stopService(intent)
        }

        /** Start the service if the user turned notifications on earlier. */
        fun startIfEnabled(ctx: Context) {
            if (isEnabled(ctx)) ctx.startForegroundService(Intent(ctx, NotifyService::class.java))
        }
    }

    // Built per server address: a self-signed certificate is accepted on
    // private and tailnet addresses only (see ServerReach.httpClient).
    private var clientBase = ""
    private var client: OkHttpClient = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    @Volatile private var running = false
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val running = NotificationCompat.Builder(this, CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_stat_rockfrog)
            .setContentTitle("Chattering is listening for replies")
            .setContentIntent(openAppIntent(null))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(RUNNING_ID, running, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(RUNNING_ID, running)
        }
        if (worker == null) {
            this.running = true
            worker = thread(name = "chattering-events", isDaemon = true) { listenLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        worker = null
        super.onDestroy()
    }

    private fun prefs() = getSharedPreferences("chattering", Context.MODE_PRIVATE)

    /** One long-lived request; on any failure wait and reconnect. Backoff
     *  grows to a minute so a laptop that is off does not drain the battery. */
    private fun listenLoop() {
        var backoffMs = 2000L
        while (running) {
            val base = ServerReach.normalizeBase(prefs().getString("server", "") ?: "")
            val token = prefs().getString("token", "") ?: ""
            if (base.isEmpty()) { sleep(backoffMs); continue }
            // Deliberately no Tailscale start here: this runs in the
            // background and must not undo a user turning the VPN off.
            if (base != clientBase) { client = ServerReach.httpClient(base); clientBase = base }
            try {
                val req = Request.Builder().url("$base/api/events")
                    .header("Accept", "text/event-stream")
                    .apply { if (token.isNotEmpty()) header("Authorization", "Bearer $token") }
                    .build()
                client.newCall(req).execute().use { res ->
                    if (!res.isSuccessful) throw IllegalStateException("HTTP ${res.code()}")
                    backoffMs = 2000L
                    val source = res.body()?.source() ?: throw IllegalStateException("no body")
                    val data = StringBuilder()
                    while (running) {
                        val line = source.readUtf8Line() ?: break
                        when {
                            line.startsWith("data:") -> data.append(line.substring(5).trim())
                            line.isEmpty() -> {
                                if (data.isNotEmpty()) handleEvent(data.toString())
                                data.setLength(0)
                            }
                        }
                    }
                }
            } catch (_: InterruptedException) {
                return
            } catch (_: Exception) {
                // connection dropped or laptop unreachable: fall through to retry
            }
            if (!running) return
            sleep(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
        }
    }

    private fun sleep(ms: Long) {
        try { Thread.sleep(ms) } catch (_: InterruptedException) { running = false }
    }

    private fun handleEvent(raw: String) {
        val ev = try { JSONObject(raw) } catch (_: Exception) { return }
        if (ev.optString("type") == "attention") { handleQuiet(ev); return }
        if (ev.optString("type") != "run-event" || !ev.optBoolean("final")) return
        if (appOnScreen) return
        // Parallel-model runs all report under one root conversation; one
        // notification per conversation, replaced as siblings finish.
        val key = ev.optString("fanoutRootKey").ifEmpty { ev.optString("key") }
        if (key.isEmpty()) return
        val title = ev.optString("title").ifEmpty { "an untitled conversation" }
        val status = ev.optString("status")
        val head = when (status) {
            "done" -> "Reply ready: $title"
            "error" -> "Failed: $title"
            else -> "Stopped: $title"
        }
        val body = ev.optString("excerpt").ifEmpty { ev.optString("statusText") }
        val n = NotificationCompat.Builder(this, CHANNEL_REPLIES)
            .setSmallIcon(R.drawable.ic_stat_rockfrog)
            .setContentTitle(head)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openAppIntent(key))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        try {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(key.hashCode(), n)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS was revoked after enabling; nothing to show
        }
    }

    /** Running work went quiet and no agent could be told (design/29). Its
     *  own channel, so a person can silence these without losing replies;
     *  one notification per conversation, replaced by the next reminder. */
    private fun handleQuiet(ev: JSONObject) {
        if (appOnScreen || ev.optString("kind") != "quiet") return
        val key = ev.optString("key")
        val title = ev.optString("title").ifEmpty { "running work" }
        val body = ev.optString("text")
        val n = NotificationCompat.Builder(this, CHANNEL_QUIET)
            .setSmallIcon(R.drawable.ic_stat_rockfrog)
            .setContentTitle("Quiet: $title")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openAppIntent(key.ifEmpty { null }))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        try {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(("quiet:" + key).hashCode(), n)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS was revoked after enabling; nothing to show
        }
    }

    private fun openAppIntent(key: String?): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            if (key != null) putExtra(EXTRA_KEY, key)
        }
        val reqCode = key?.hashCode() ?: 0
        return PendingIntent.getActivity(
            this, reqCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun createChannels() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(
            CHANNEL_RUNNING, "Background listener", NotificationManager.IMPORTANCE_MIN,
        ).apply { description = "Shown while Chattering waits for replies"; setShowBadge(false) })
        nm.createNotificationChannel(NotificationChannel(
            CHANNEL_REPLIES, "Agent replies", NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = "A conversation has a new reply" })
        nm.createNotificationChannel(NotificationChannel(
            CHANNEL_QUIET, "Quiet work", NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = "Running work has had no new output for a while and no agent could be told" })
    }
}
