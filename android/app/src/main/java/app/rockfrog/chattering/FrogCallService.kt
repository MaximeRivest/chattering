package app.rockfrog.chattering

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.telecom.DisconnectCause
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Talking with the frog as a call (design/102, part 4).
 *
 * The frog's walkie-talkie runs in the page: the microphone and the voice
 * are the page's. Android lets neither go on once the screen is off or the
 * app is behind another one: the microphone closes, the page is paused, the
 * process may be stopped. A call may go on. So while the person talks with
 * the frog, the app holds a call in Android's own call system (a
 * self-managed call, through Jetpack Core-Telecom): the system sends the
 * sound to the Bluetooth headset as for any call and takes its microphone,
 * the headset's button hangs up (and answers when the frog calls), other
 * apps' music pauses, and this service, a foreground service of the
 * phone-call and microphone kinds, keeps the page, its microphone and its
 * voice running with the screen off, holding a wake lock and a Wi-Fi lock.
 *
 * Three ways in: the page turns Talk on (START: an outgoing call, active
 * at once); a `call` notification from the person's computer (RING: an
 * incoming call, the phone and the headset ring until it is answered,
 * declined or 45 s pass); the headset's button or the quick-settings tile
 * when no call is on (START through MainActivity, which opens the frog).
 *
 * What the page hears (window.chatteringCallEvent): active, held (a real
 * phone call took over), ended {reason}, endpoint {name}, tick (every 30 s,
 * because a hidden page's own timers run once a minute at best).
 */
class FrogCallService : Service() {
    companion object {
        private const val TAG = "FrogCall"
        const val ACTION_START = "app.rockfrog.chattering.call.START"
        const val ACTION_RING = "app.rockfrog.chattering.call.RING"
        const val ACTION_ANSWER = "app.rockfrog.chattering.call.ANSWER"
        const val ACTION_DECLINE = "app.rockfrog.chattering.call.DECLINE"
        const val ACTION_HANGUP = "app.rockfrog.chattering.call.HANGUP"
        const val ACTION_FROG_PAUSE = "app.rockfrog.chattering.call.FROG_PAUSE"
        const val ACTION_FROG_RESUME = "app.rockfrog.chattering.call.FROG_RESUME"
        /** MainActivity opened for a call: "start" (place one), "answered" (go on with the one ringing). */
        const val ACTION_OPEN = "app.rockfrog.chattering.FROG_CALL"
        const val EXTRA_HOW = "how"
        const val EXTRA_TITLE = "title"
        const val EXTRA_BODY = "body"
        const val EXTRA_HOME = "home"
        private const val CHANNEL_CALL = "call"
        private const val CHANNEL_RING = "ring"
        private const val CALL_ID = 3
        private const val MISSED_ID = 4
        private const val RING_MS = 45_000L
        private const val TICK_MS = 30_000L
        const val NAME = "The frog"

        /** idle, ringing or active; read by the activity and the bridges. */
        @Volatile var state: String = "idle"
            private set(value) { field = value; val ws = watchers.toList(); Handler(Looper.getMainLooper()).post { for (w in ws) w(value) } }
        val active: Boolean get() = state == "active"
        val onCall: Boolean get() = state != "idle"
        private val watchers = java.util.concurrent.CopyOnWriteArrayList<(String) -> Unit>()
        fun watch(w: (String) -> Unit) { watchers.add(w) }
        fun unwatch(w: (String) -> Unit) { watchers.remove(w) }

        fun start(ctx: Context) = send(ctx, ACTION_START)
        fun hangUp(ctx: Context) { if (onCall) send(ctx, ACTION_HANGUP) }
        fun answer(ctx: Context) { if (state == "ringing") send(ctx, ACTION_ANSWER) }
        fun decline(ctx: Context) { if (state == "ringing") send(ctx, ACTION_DECLINE) }
        /** What the frog's voice is doing, from the page: speaking, paused or
         *  quiet. The call's notification and the lock screen's media
         *  controls follow it (Pause / Go on). */
        @Volatile var frogVoice: String = "quiet"; private set
        fun frogVoiceIs(ctx: Context, v: String) {
            val next = if (v == "speaking" || v == "paused") v else "quiet"
            if (next == frogVoice) return
            frogVoice = next
            if (active) send(ctx, ACTION_REFRESH)
        }
        /** The app is on screen: a call that began with the screen off (the
         *  frog's ring on a locked phone, the tile over the lock screen) could
         *  not claim the microphone then; Android allows it now. */
        fun onScreen(ctx: Context) { if (active && !micClaimed) send(ctx, ACTION_REFRESH) }
        @Volatile var micClaimed = false; private set
        const val ACTION_REFRESH = "app.rockfrog.chattering.call.REFRESH"
        fun ring(ctx: Context, title: String, body: String, home: String?) =
            send(ctx, ACTION_RING, Intent().putExtra(EXTRA_TITLE, title).putExtra(EXTRA_BODY, body).putExtra(EXTRA_HOME, home ?: ""))

        private fun send(ctx: Context, action: String, extras: Intent? = null) {
            val i = Intent(ctx, FrogCallService::class.java).setAction(action)
            if (extras != null) i.putExtras(extras)
            try { ctx.startForegroundService(i) } catch (e: Exception) { Log.w(TAG, "could not start: $e") }
        }

        /** The page is told; `type` as the page's chatteringCallEvent knows them. */
        private fun tell(type: String, vararg kv: Pair<String, String?>) {
            val event = JSONObject().put("type", type)
            for ((k, v) in kv) if (v != null) event.put(k, v)
            MainActivity.current?.pageCall("w.chatteringCallEvent&&w.chatteringCallEvent($event)")
        }

        /** Only one process, one call: the service is that process. */
        fun openIntent(ctx: Context, how: String): Intent =
            Intent(ctx, MainActivity::class.java).setAction(ACTION_OPEN).putExtra(EXTRA_HOW, how)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var calls: CallsManager? = null
    private var session: Job? = null
    private var control: CallControlScope? = null
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var ringtone: Ringtone? = null
    private var ringTimeout: Runnable? = null
    private var ticker: Runnable? = null
    private var home: String? = null
    private var ringTitle: String? = null
    private var ringBody: String? = null
    private var ending = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        // Every start of a foreground service must call startForeground at
        // once, whatever it is asked, or Android stops the app.
        when (action) {
            ACTION_RING -> {
                if (state != "idle") { foreground(if (state == "ringing") ringing(ringTitle, ringBody) else ongoing()); return START_NOT_STICKY }
                home = intent.getStringExtra(EXTRA_HOME)?.takeIf { it.isNotEmpty() }
                ringTitle = intent.getStringExtra(EXTRA_TITLE); ringBody = intent.getStringExtra(EXTRA_BODY)
                foreground(ringing(ringTitle, ringBody))
                place(incoming = true)
            }
            ACTION_START -> {
                foreground(ongoing())
                when (state) {
                    "idle" -> place(incoming = false)
                    "ringing" -> answerHere()
                    else -> tell("active")
                }
            }
            ACTION_ANSWER -> { foreground(ongoing()); if (state == "ringing") answerHere() else if (state == "idle") stopNow() }
            ACTION_DECLINE -> { foreground(if (state == "ringing") ringing(ringTitle, ringBody) else ongoing()); end(DisconnectCause(DisconnectCause.REJECTED), "declined") }
            ACTION_HANGUP -> { foreground(ongoing()); end(DisconnectCause(DisconnectCause.LOCAL), "hung up") }
            // The notification's or the lock screen's Pause / Go on.
            ACTION_FROG_PAUSE -> { foreground(ongoing()); if (state == "idle") stopNow() else tell("pause") }
            ACTION_FROG_RESUME -> { foreground(ongoing()); if (state == "idle") stopNow() else tell("resume") }
            ACTION_REFRESH -> { foreground(if (state == "ringing") ringing(ringTitle, ringBody) else ongoing()); mediaState(); if (state == "idle") stopNow() else if (!micClaimed) MainActivity.current?.micCallChanged() }
            else -> { foreground(ongoing()); if (state == "idle") stopNow() }
        }
        return START_NOT_STICKY
    }

    private fun foreground(n: Notification) {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                startForeground(CALL_ID, n, types)
                micClaimed = types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE != 0
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(CALL_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else startForeground(CALL_ID, n)
        } catch (e: Exception) {
            // The microphone kind refused (the app was not on screen when
            // the call began): the call kind alone, the page's microphone
            // then works as long as the system treats the call as one.
            Log.w(TAG, "foreground: $e")
            micClaimed = false
            try { if (Build.VERSION.SDK_INT >= 29) startForeground(CALL_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL) else startForeground(CALL_ID, n) } catch (e2: Exception) { Log.w(TAG, "foreground again: $e2") }
        }
    }

    // ---- the call itself ----

    private fun place(incoming: Boolean) {
        val cm = calls ?: CallsManager(this).also {
            try { it.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE) } catch (e: Exception) { Log.w(TAG, "register: $e") }
            calls = it
        }
        ending = false
        state = if (incoming) "ringing" else "active"
        if (incoming) startRinging() else began()
        val attrs = CallAttributesCompat(
            displayName = NAME,
            address = Uri.parse("chattering://frog"),
            direction = if (incoming) CallAttributesCompat.DIRECTION_INCOMING else CallAttributesCompat.DIRECTION_OUTGOING,
            callType = CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
            callCapabilities = CallAttributesCompat.SUPPORTS_SET_INACTIVE,
        )
        session = scope.launch {
            try {
                cm.addCall(
                    attrs,
                    // The headset's button, the car, a watch: answer.
                    onAnswer = { answered("the headset") },
                    // The headset's button, or the system: hang up.
                    onDisconnect = { cause -> finished(reasonOf(cause)) },
                    // A real phone call taken meanwhile ended: the frog's goes on.
                    onSetActive = { tell("active") },
                    // A real phone call was answered: the frog's call waits.
                    onSetInactive = { tell("held") },
                ) {
                    control = this
                    launch { currentCallEndpoint.collect { tell("endpoint", "name" to it.name.toString(), "kind" to kindOf(it.type)); main.postDelayed({ mirrorVolume() }, 1200) } }
                    launch { availableEndpoints.collect { prefer(it) } }
                    if (!incoming) launch {
                        setActive()
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e // the service stopping: not a failure
            } catch (e: Exception) {
                // The system refused the call (another app's call, no call
                // system): the page goes on without one, as before.
                Log.w(TAG, "call failed: $e")
                if (state == "active" && !ending) tell("nocall", "reason" to (e.message ?: e.toString()))
            } finally {
                control = null
                finished(null)
            }
        }
    }

    /** Where the call's sound goes: the headset when there is one (the call
     *  system picks it by itself, and one that connects mid-call), else the
     *  speaker, never the earpiece: nobody holds a page to their ear. */
    private var currentType = -1
    private fun prefer(available: List<CallEndpointCompat>) {
        val c = control ?: return
        val best = available.firstOrNull { it.type == CallEndpointCompat.TYPE_BLUETOOTH }
            ?: available.firstOrNull { it.type == CallEndpointCompat.TYPE_WIRED_HEADSET }
            ?: available.firstOrNull { it.type == CallEndpointCompat.TYPE_SPEAKER }
            ?: return
        if (best.type == currentType) return
        // The speaker only instead of the earpiece: a route the person chose stays.
        if (best.type == CallEndpointCompat.TYPE_SPEAKER && currentType != CallEndpointCompat.TYPE_EARPIECE && currentType != -1) return
        scope.launch { try { c.requestEndpointChange(best) } catch (e: Exception) { Log.w(TAG, "endpoint: $e") } }
    }

    private fun kindOf(type: Int): String {
        currentType = type
        return when (type) {
            CallEndpointCompat.TYPE_BLUETOOTH -> "bluetooth"
            CallEndpointCompat.TYPE_WIRED_HEADSET -> "wired"
            CallEndpointCompat.TYPE_SPEAKER -> "speaker"
            CallEndpointCompat.TYPE_EARPIECE -> "earpiece"
            else -> "other"
        }
    }

    private fun reasonOf(cause: DisconnectCause): String = when (cause.code) {
        DisconnectCause.REJECTED -> "declined"
        DisconnectCause.MISSED -> "missed"
        DisconnectCause.BUSY -> "busy"
        DisconnectCause.ERROR -> "error"
        else -> "hung up"
    }

    /** Answered from this phone (the notification, the page). */
    private fun answerHere() {
        val c = control
        if (c == null) { answered("the phone"); return }
        scope.launch {
            try { c.answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL) } catch (e: Exception) { Log.w(TAG, "answer: $e") }
            answered("the phone")
        }
    }

    private fun answered(by: String) {
        if (state != "ringing") return
        stopRinging()
        state = "active"
        foreground(ongoing())
        began()
        // The page turns Talk on. It may not be there: the app behind
        // other apps, or closed. Then it is opened on the frog; when Android
        // refuses (a service may not open a screen from behind), the call's
        // own notification is the way in, and the page is told on arrival.
        val activity = MainActivity.current
        if (activity != null && activity.pageLoaded) tell("answered", "by" to by)
        else try { startActivity(openIntent(this, "answered")) } catch (e: Exception) { Log.w(TAG, "open: $e") }
    }

    /** The call is on: the phone stays awake and on the network. The page
     *  does the talking; with no app screen at all after 45 s (the app
     *  closed, and Android would not let a service open it) the call ends,
     *  and a notification offers the way in. */
    private var noPage: Runnable? = null
    private fun began() {
        if (noPage == null) {
            val r = Runnable {
                noPage = null
                if (state == "active" && MainActivity.current == null) { end(DisconnectCause(DisconnectCause.LOCAL), "no page"); openOffer() }
            }
            noPage = r
            main.postDelayed(r, 45_000)
        }
        if (wake == null) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chattering:frog-call").also { it.acquire(4 * 3600 * 1000L) }
        }
        if (wifi == null) {
            val wm = applicationContext.getSystemService(WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            wifi = wm?.createWifiLock(if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF, "chattering:frog-call")?.also { it.acquire() }
        }
        if (ticker == null) {
            val t = object : Runnable { override fun run() { if (state == "active") { tell("tick"); main.postDelayed(this, TICK_MS) } } }
            ticker = t
            main.postDelayed(t, TICK_MS)
        }
        mediaStart()
        volumeFollow()
        MainActivity.current?.micCallChanged()
        tell("active")
    }

    // ---- the frog's voice at the call's volume ----
    // The frog speaks through the page, as media. In a call, the volume
    // buttons set the call's volume, and Android keeps a separate media
    // volume for the headset's call connection, which those buttons never
    // reach: at its default the frog was quiet with phone and headset at
    // maximum. So while the call lasts, that media volume follows the call
    // volume (same fraction of its range). Only when media goes to a
    // call-only device (the headset's call connection): the speaker's and
    // the music headset's volumes are never touched.
    private var volumeReceiver: BroadcastReceiver? = null
    private fun mirrorVolume() {
        if (state != "active") return
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        try {
            // Where the call's sound goes (the call's own device: media
            // follows it during a call). Asking where media goes directly
            // (getAudioDevicesForAttributes) answers nothing on a Samsung S21.
            if (Build.VERSION.SDK_INT < 31) return
            val dev = am.communicationDevice?.type
            val callOnly = dev == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || dev == AudioDeviceInfo.TYPE_BLE_HEADSET
            if (!callOnly) { Log.i(TAG, "volume: the call is on device type $dev, not a headset's call connection: left alone"); return }
            // The call's volume: on a Bluetooth call some phones (Samsung)
            // keep it on the Bluetooth-call stream (6), not the call stream,
            // which then reads its own unrelated level (measured on an S21:
            // Bluetooth call 15/15, call stream 5/8, and the frog set to
            // 9/15). The louder of the two fractions is the one in use.
            fun fraction(stream: Int): Float = try {
                val max = am.getStreamMaxVolume(stream); if (max > 0) am.getStreamVolume(stream).toFloat() / max else 0f
            } catch (_: Exception) { 0f }
            val call = maxOf(fraction(AudioManager.STREAM_VOICE_CALL), fraction(6 /* bluetooth call */))
            val mMax = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            if (call <= 0f || mMax <= 0) return
            val want = Math.round(call * mMax).coerceIn(1, mMax)
            Log.i(TAG, "volume: call at ${"%.2f".format(call)}, media ${am.getStreamVolume(AudioManager.STREAM_MUSIC)} \u2192 $want of $mMax")
            if (am.getStreamVolume(AudioManager.STREAM_MUSIC) != want) am.setStreamVolume(AudioManager.STREAM_MUSIC, want, 0)
        } catch (e: Exception) { Log.w(TAG, "volume: $e") }
    }
    private fun volumeFollow() {
        if (volumeReceiver == null) {
            val r = object : BroadcastReceiver() {
                override fun onReceive(c: Context, i: Intent) {
                    val stream = i.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1)
                    if (stream == AudioManager.STREAM_VOICE_CALL || stream == 6 /* bluetooth call */) mirrorVolume()
                }
            }
            val f = IntentFilter("android.media.VOLUME_CHANGED_ACTION")
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(r, f, RECEIVER_EXPORTED) else registerReceiver(r, f)
            volumeReceiver = r
        }
        // The headset's call connection takes a moment to come up.
        for (ms in longArrayOf(800, 2500, 6000)) main.postDelayed({ mirrorVolume() }, ms)
    }
    private fun volumeStop() {
        volumeReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        volumeReceiver = null
    }

    // ---- the headset's button when no call is on ----
    // In a call, the headset's button goes to the call system (hang up).
    // Out of one, it is a play/pause button, sent to the app that played
    // last. A media session, playing while the frog's call is on, makes
    // this app that one, and names the receiver Android keeps for its button
    // after the session is gone (FrogCallButtonReceiver): the next press, if
    // nothing else played since, starts a call with the frog.
    private var media: MediaSession? = null
    private fun mediaStart() {
        if (media != null) return
        try {
            val s = MediaSession(this, "frog-call")
            val receiver = ComponentName(this, FrogCallButtonReceiver::class.java)
            if (Build.VERSION.SDK_INT >= 31) s.setMediaButtonBroadcastReceiver(receiver)
            else @Suppress("DEPRECATION") s.setMediaButtonReceiver(PendingIntent.getBroadcast(this, 18, Intent(Intent.ACTION_MEDIA_BUTTON).setComponent(receiver), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            s.setCallback(object : MediaSession.Callback() {
                override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean = true // in a call: the call system has the button
                // The lock screen's and the shade's media controls: pause and go on.
                override fun onPause() { if (state == "active") tell("pause") }
                override fun onPlay() { if (state == "active") tell("resume") }
            })
            s.setPlaybackState(PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP)
                .setState(PlaybackState.STATE_PLAYING, 0, 1f).build())
            s.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, "Talking with the frog").putString(MediaMetadata.METADATA_KEY_ARTIST, "Chattering").build())
            s.isActive = true
            media = s
        } catch (e: Exception) { Log.w(TAG, "media session: $e") }
    }
    /** The media controls show what the frog's voice does: playing while it
     *  speaks (pause offered), paused while it waits (play offered). */
    private fun mediaState() {
        val s = media ?: return
        val playing = frogVoice != "paused"
        try {
            s.setPlaybackState(PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE)
                .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, 0, if (playing) 1f else 0f).build())
            s.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, when (frogVoice) { "speaking" -> "The frog is speaking"; "paused" -> "The frog waits"; else -> "Talking with the frog" })
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "Chattering").build())
        } catch (_: Exception) {}
    }
    private fun mediaRelease() {
        val s = media ?: return
        media = null
        try {
            s.setPlaybackState(PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PLAY_PAUSE).setState(PlaybackState.STATE_STOPPED, 0, 0f).build())
            s.isActive = false
            s.release()
        } catch (_: Exception) {}
    }

    /** Hang up from this side: the page (Talk off), the notification, a decline. */
    private fun end(cause: DisconnectCause, reason: String) {
        if (state == "idle") { stopNow(); return }
        ending = true
        val c = control
        if (c == null) { finished(reason); return }
        scope.launch {
            try { c.disconnect(cause) } catch (e: Exception) { Log.w(TAG, "disconnect: $e") }
            finished(reason)
        }
    }

    /** The call is over, whoever ended it. Idempotent. */
    private fun finished(reason: String?) {
        if (state == "idle") return
        val wasRinging = state == "ringing"
        state = "idle"
        stopRinging()
        ticker?.let { main.removeCallbacks(it) }; ticker = null
        noPage?.let { main.removeCallbacks(it) }; noPage = null
        mediaRelease()
        volumeStop()
        frogVoice = "quiet"
        MainActivity.current?.micCallChanged()
        try { wake?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        wake = null
        try { wifi?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        wifi = null
        if (wasRinging && (reason == "missed" || reason == null)) missed()
        tell("ended", "reason" to (reason ?: "ended"))
        MainActivity.current?.callEnded()
        stopNow()
    }

    private fun stopNow() {
        session?.cancel(); session = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        if (state != "idle") finished("ended")
        scope.cancel()
        super.onDestroy()
    }

    // ---- ringing ----

    private fun startRinging() {
        ringTimeout = Runnable { if (state == "ringing") end(DisconnectCause(DisconnectCause.MISSED), "missed") }.also { main.postDelayed(it, RING_MS) }
        // The headset rings by itself (in-band ringing is the call system's);
        // the phone rings with the person's own ringtone, if the phone is
        // not silent, and buzzes.
        try {
            val r = RingtoneManager.getRingtone(this, Settings.System.DEFAULT_RINGTONE_URI)
            r.audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
            if (Build.VERSION.SDK_INT >= 28) r.isLooping = true
            r.play()
            ringtone = r
        } catch (e: Exception) { Log.w(TAG, "ringtone: $e") }
        try {
            val v = if (Build.VERSION.SDK_INT >= 31) (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator else @Suppress("DEPRECATION") (getSystemService(VIBRATOR_SERVICE) as Vibrator)
            v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 800), 0), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
        } catch (_: Exception) {}
        tell("ringing")
    }

    private fun stopRinging() {
        ringTimeout?.let { main.removeCallbacks(it) }; ringTimeout = null
        try { ringtone?.stop() } catch (_: Exception) {}
        ringtone = null
        try {
            val v = if (Build.VERSION.SDK_INT >= 31) (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator else @Suppress("DEPRECATION") (getSystemService(VIBRATOR_SERVICE) as Vibrator)
            v.cancel()
        } catch (_: Exception) {}
    }

    // ---- notifications ----

    private fun nm() = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    private fun person() = Person.Builder().setName(NAME).setImportant(true).setIcon(IconCompat.createWithResource(this, R.mipmap.ic_launcher)).build()
    private fun serviceIntent(action: String, code: Int): PendingIntent =
        PendingIntent.getForegroundService(this, code, Intent(this, FrogCallService::class.java).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun activityIntent(how: String, code: Int): PendingIntent =
        PendingIntent.getActivity(this, code, openIntent(this, how), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun ringIntent(title: String?, body: String?): PendingIntent =
        PendingIntent.getActivity(this, 15, Intent(this, FrogRingActivity::class.java).putExtra(EXTRA_TITLE, title ?: "").putExtra(EXTRA_BODY, body ?: "")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** The call in progress: hang up, pause or resume the frog's voice, or open the frog. */
    private fun ongoing(): Notification =
        NotificationCompat.Builder(this, CHANNEL_CALL)
            .setSmallIcon(R.drawable.ic_stat_rockfrog)
            .setContentTitle(when (frogVoice) { "speaking" -> "The frog is speaking"; "paused" -> "The frog waits"; else -> "Talking with the frog" })
            .setContentText(when (frogVoice) {
                "speaking" -> "Pause it here, or say \u201cfrog, wait\u201d."
                "paused" -> "Go on here, or say \u201cfrog, go on\u201d."
                else -> "Say \u201cover\u201d to send. The headset\u2019s button hangs up."
            })
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person(), serviceIntent(ACTION_HANGUP, 11)))
            .apply {
                if (frogVoice == "speaking") addAction(NotificationCompat.Action.Builder(android.R.drawable.ic_media_pause, "Pause the frog", serviceIntent(ACTION_FROG_PAUSE, 20)).build())
                if (frogVoice == "paused") addAction(NotificationCompat.Action.Builder(android.R.drawable.ic_media_play, "Go on", serviceIntent(ACTION_FROG_RESUME, 21)).build())
            }
            .setContentIntent(activityIntent("answered", 12))
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

    /** The frog calls: answer or decline; shown full-screen when the phone is locked. */
    private fun ringing(title: String? = null, body: String? = null): Notification =
        NotificationCompat.Builder(this, CHANNEL_RING)
            .setSmallIcon(R.drawable.ic_stat_rockfrog)
            .setContentTitle(title?.takeIf { it.isNotBlank() } ?: "The frog is calling")
            .setContentText(body?.takeIf { it.isNotBlank() } ?: "Answer to talk with it")
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person(), serviceIntent(ACTION_DECLINE, 13), serviceIntent(ACTION_ANSWER, 14)))
            .setFullScreenIntent(ringIntent(title, body), true)
            .setContentIntent(ringIntent(title, body))
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            // Not setSilent: that puts it in a silent group, and Android then
            // never launches its full-screen page. The channel itself is silent.
            .build()

    /** A call began with no page to carry it (the headset's button with the app closed). */
    private fun openOffer() {
        val n = NotificationCompat.Builder(this, CHANNEL_RING)
            .setSmallIcon(R.drawable.ic_stat_rockfrog)
            .setContentTitle("Talk with the frog")
            .setContentText("Tap to open Chattering and start talking")
            .setContentIntent(activityIntent("start", 17))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()
        try { nm().notify(MISSED_ID, n) } catch (_: SecurityException) {}
    }

    private fun missed() {
        val n = NotificationCompat.Builder(this, CHANNEL_RING)
            .setSmallIcon(R.drawable.ic_stat_rockfrog)
            .setContentTitle("Missed call from the frog")
            .setContentText("Tap to call it back")
            .setContentIntent(activityIntent("start", 16))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .build()
        try { nm().notify(MISSED_ID, n) } catch (_: SecurityException) {}
    }

    private fun channels() {
        val nm = nm()
        nm.createNotificationChannel(NotificationChannel(CHANNEL_CALL, "Talking with the frog", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Shown while you talk with the frog, with its hang-up button"; setSound(null, null); enableVibration(false); setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_RING, "The frog calls", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "The frog calling you, and calls you missed"; setSound(null, null); enableVibration(false)
        })
    }
}
