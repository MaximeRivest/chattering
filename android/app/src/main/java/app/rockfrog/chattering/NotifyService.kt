package app.rockfrog.chattering

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Notifications on this phone (design/100).
 *
 * The page inside the WebView is frozen as soon as the app leaves the
 * screen, and a WebView has no push service of its own (nor does an e-ink
 * tablet without Google's services). So this service keeps one WebSocket
 * to the relay's mailbox (anywhere/mailbox.js): each of the person's
 * computers posts its notifications there, encrypted to keys made here
 * (WebPushCrypto), and they arrive whether the phone is home, out, paired
 * through the encrypted link or connected by address.
 *
 * The computer decides what is worth a buzz (push-policy.js: not while the
 * person uses Chattering on another screen, never about the conversation
 * they look at); this side shows what arrives, one notification per
 * conversation, and clears those read elsewhere.
 *
 * Android requires a persistent "running" notification for any service
 * that outlives the app; it is posted on a silent, minimum-importance
 * channel the person can hide in Android's settings.
 */
class NotifyService : Service() {
    companion object {
        private const val CHANNEL_RUNNING = "running"
        private const val CHANNEL_REPLIES = "replies"
        private const val CHANNEL_ATTENTION = "attention"
        private const val CHANNEL_QUIET = "quiet"
        private const val RUNNING_ID = 1
        private const val PREF_ENABLED = "notify"
        const val EXTRA_KEY = "conversationKey"
        const val EXTRA_URL = "conversationUrl"
        const val EXTRA_HOME = "homeId"

        /** True while MainActivity is resumed. */
        @Volatile var appOnScreen = false

        private fun prefs(ctx: Context) = ctx.getSharedPreferences("chattering", Context.MODE_PRIVATE)

        fun isEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(PREF_ENABLED, false)

        fun setEnabled(ctx: Context, on: Boolean) {
            prefs(ctx).edit().putBoolean(PREF_ENABLED, on).apply()
            val intent = Intent(ctx, NotifyService::class.java)
            if (on) { keys(ctx); ctx.startForegroundService(intent) } else ctx.stopService(intent)
        }

        /** Start the service if the person turned notifications on earlier. */
        fun startIfEnabled(ctx: Context) {
            if (isEnabled(ctx)) try { ctx.startForegroundService(Intent(ctx, NotifyService::class.java)) } catch (_: Exception) {}
        }

        /** This phone's notification keys and mailbox secret, made once. */
        @Synchronized
        fun keys(ctx: Context): Pair<WebPushCrypto.Keys, String> {
            val p = prefs(ctx)
            val pub = p.getString("push_pub", null)
            val d = p.getString("push_d", null)
            val auth = p.getString("push_auth", null)
            val secret = p.getString("push_secret", null)
            if (pub != null && d != null && auth != null && secret != null) {
                return WebPushCrypto.Keys(WebPushCrypto.unb64u(pub), WebPushCrypto.unb64u(d), WebPushCrypto.unb64u(auth)) to secret
            }
            val k = WebPushCrypto.generate()
            val s = WebPushCrypto.b64u(ByteArray(32).also { SecureRandom().nextBytes(it) })
            p.edit().putString("push_pub", WebPushCrypto.b64u(k.publicRaw)).putString("push_d", WebPushCrypto.b64u(k.privateD))
                .putString("push_auth", WebPushCrypto.b64u(k.auth)).putString("push_secret", s).apply()
            return k to s
        }

        /** The relay this phone's mailbox lives at: the one it uses for the
         *  encrypted link, else Rockfrog's. */
        fun relay(ctx: Context): String = (prefs(ctx).getString("relay", null) ?: AnywhereShell.DEFAULT_RELAY).trimEnd('/')

        /** The subscription a computer stores (the Web Push shape). */
        fun subscription(ctx: Context): JSONObject {
            val (k, secret) = keys(ctx)
            return JSONObject()
                .put("endpoint", relay(ctx) + "/_push/" + WebPushCrypto.mailboxId(secret))
                .put("keys", JSONObject().put("p256dh", WebPushCrypto.b64u(k.publicRaw)).put("auth", WebPushCrypto.b64u(k.auth)))
        }
    }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    @Volatile private var running = false
    @Volatile private var socket: WebSocket? = null
    private var worker: Thread? = null
    private val wake = Object()
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val listening = NotificationCompat.Builder(this, CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_stat_rockfrog)
            .setContentTitle("Chattering is listening for replies")
            .setContentText("Hide this notice: long-press it → turn off “Background listener”.")
            .setContentIntent(openAppIntent(null, null, null))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(RUNNING_ID, listening, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(RUNNING_ID, listening)
        if (worker == null) {
            running = true
            worker = thread(name = "chattering-mailbox", isDaemon = true) { listenLoop() }
            watchNetwork()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        socket?.cancel()
        synchronized(wake) { wake.notifyAll() }
        worker?.interrupt()
        worker = null
        netCallback?.let { try { (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } catch (_: Exception) {} }
        super.onDestroy()
    }

    // A network that comes back (out of a tunnel, Wi-Fi joined) is the
    // moment to reconnect, not the end of the current wait.
    private fun watchNetwork() {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            private var last: Network? = null
            override fun onAvailable(network: Network) {
                // Another network than the one the socket was opened on: that
                // socket is likely dead without knowing it, start over now.
                val moved = last != null && last != network
                last = network
                if (moved) socket?.cancel()
                synchronized(wake) { wake.notifyAll() }
            }
        }
        try { cm.registerDefaultNetworkCallback(cb); netCallback = cb } catch (_: Exception) {}
    }

    /** What one connection knows about itself, shared with its callbacks. */
    private class Conn {
        @Volatile var opened = false
        @Volatile var closed = false
        @Volatile var heard = System.currentTimeMillis()
        val lock = Object()
        fun end() { closed = true; synchronized(lock) { lock.notifyAll() } }
    }

    /** One connection at a time; on any end, wait and connect again. The
     *  wait grows to five minutes so an unreachable relay costs no battery. */
    private fun listenLoop() {
        var backoffMs = 2000L
        while (running) {
            val (keys, secret) = keys(this)
            val url = relay(this).replaceFirst(Regex("^http"), "ws") + "/_push/listen"
            val c = Conn()
            val listener = object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    c.opened = true
                    c.heard = System.currentTimeMillis()
                    ws.send(JSONObject().put("t", "listen").put("secret", secret).toString())
                }
                override fun onMessage(ws: WebSocket, text: String) {
                    c.heard = System.currentTimeMillis()
                    val m = try { JSONObject(text) } catch (_: Exception) { return }
                    when (m.optString("t")) {
                        "hi" -> ws.send("{\"t\":\"hi\"}")
                        "push" -> {
                            // Acknowledged whatever happens: a message this
                            // app cannot open will not open later either.
                            ws.send(JSONObject().put("t", "ack").put("id", m.optString("id")).toString())
                            try {
                                val body = android.util.Base64.decode(m.optString("body"), android.util.Base64.DEFAULT)
                                show(JSONObject(String(WebPushCrypto.decrypt(body, keys))))
                            } catch (_: Exception) { /* not for this phone, or not a message */ }
                        }
                    }
                }
                override fun onClosed(ws: WebSocket, code: Int, reason: String) { c.end() }
                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { c.end() }
            }
            val ws = client.newWebSocket(Request.Builder().url(url).build(), listener)
            socket = ws
            // Until it ends. One that hears nothing for five and a half
            // minutes (the relay says hi every two) is dead without knowing.
            while (running && !c.closed) {
                synchronized(c.lock) { try { c.lock.wait(30_000) } catch (_: InterruptedException) { running = false } }
                if (System.currentTimeMillis() - c.heard > 330_000) break
            }
            ws.cancel()
            socket = null
            if (!running) return
            backoffMs = if (c.opened) 2000L else (backoffMs * 2).coerceAtMost(300_000L)
            synchronized(wake) { try { wake.wait(backoffMs) } catch (_: InterruptedException) { running = false } }
        }
    }

    private fun nm() = getSystemService(NOTIFICATION_SERVICE) as NotificationManager

    /** One message from a computer (push-policy.js messageFor). */
    private fun show(m: JSONObject) {
        if (m.optInt("v") != 1) return
        val kind = m.optString("kind")
        val home = m.optJSONObject("home")?.optString("id") ?: ""
        val tag = m.optString("tag").ifEmpty { "chattering" }
        val key = m.optString("key").ifEmpty { null }
        val url = m.optString("url").takeIf { it.startsWith("/") } ?: "/"
        val title = m.optString("title").ifEmpty { "Chattering" }
        val body = m.optString("body")
        // Read meanwhile on another device: those notifications go.
        m.optJSONArray("open")?.let { open ->
            val keep = HashSet<String>().apply { add(tag); for (i in 0 until open.length()) add(open.optString(i)) }
            try {
                for (sbn in nm().activeNotifications) {
                    val t = sbn.tag ?: continue
                    val parts = t.split('|')
                    if (parts.size == 3 && parts[0] == "c" && parts[1] == home && parts[2] !in keep) nm().cancel(t, sbn.id)
                }
            } catch (_: Exception) {}
        }
        val channel = when (kind) {
            "question", "failed" -> CHANNEL_ATTENTION
            "quiet" -> CHANNEL_QUIET
            else -> CHANNEL_REPLIES
        }
        val n = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_rockfrog)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSubText(m.optJSONObject("home")?.optString("name")?.takeIf { it.isNotEmpty() })
            .setWhen(m.optLong("at", System.currentTimeMillis()))
            .setShowWhen(true)
            .setContentIntent(openAppIntent(key, url, home))
            .setAutoCancel(true)
            .setOnlyAlertOnce(!m.optBoolean("renotify", true))
            .setPriority(if (channel == CHANNEL_ATTENTION) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(if (kind == "quiet") NotificationCompat.CATEGORY_STATUS else NotificationCompat.CATEGORY_MESSAGE)
            .apply { if (m.has("badge")) setNumber(m.optInt("badge")) }
            .build()
        try { nm().notify("c|$home|$tag", 2, n) } catch (_: SecurityException) { /* permission revoked since */ }
    }

    private fun openAppIntent(key: String?, url: String?, home: String?): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            if (key != null) putExtra(EXTRA_KEY, key)
            if (url != null) putExtra(EXTRA_URL, url)
            if (!home.isNullOrEmpty()) putExtra(EXTRA_HOME, home)
        }
        val reqCode = ((home ?: "") + "|" + (key ?: "")).hashCode()
        return PendingIntent.getActivity(this, reqCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun createChannels() {
        val nm = nm()
        nm.createNotificationChannel(NotificationChannel(
            CHANNEL_RUNNING, "Background listener", NotificationManager.IMPORTANCE_MIN,
        ).apply { description = "Shown while Chattering waits for replies. Turn this one off to hide it; replies still arrive."; setShowBadge(false) })
        nm.createNotificationChannel(NotificationChannel(
            CHANNEL_REPLIES, "Replies", NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = "A conversation has a new reply" })
        nm.createNotificationChannel(NotificationChannel(
            CHANNEL_ATTENTION, "Needs you", NotificationManager.IMPORTANCE_HIGH,
        ).apply { description = "An agent waits for your answer, or a run failed" })
        nm.createNotificationChannel(NotificationChannel(
            CHANNEL_QUIET, "Quiet work", NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = "Running work has had no news for a while" })
        // The channel of the app before 0.3.11 ("Agent replies" under the same id) keeps its settings.
    }
}
