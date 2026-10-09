package app.rockfrog.chattering

import android.annotation.SuppressLint
import android.Manifest
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.WebResourceResponse
import android.webkit.ValueCallback
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    companion object {
        private const val SPEECH_PERMISSION_REQUEST = 4107
        private const val LISTEN_PERMISSION_REQUEST = 4110
        private const val FILE_CHOOSER_REQUEST = 4108
        private const val NOTIFY_PERMISSION_REQUEST = 4109
        private const val MIC_PERMISSION_REQUEST = 4111
        private const val WEB_MIC_PERMISSION_REQUEST = 4112
    }

    // Settings page toggle for reply notifications. On Android 13+ the
    // notification permission is asked first; the service starts once the
    // user answers yes, and the page is told the final state either way.
    inner class NotifyBridge {
        @JavascriptInterface
        fun isEnabled(): Boolean = NotifyService.isEnabled(this@MainActivity)

        @JavascriptInterface
        fun setEnabled(on: Boolean) {
            runOnUiThread {
                if (!on) { NotifyService.setEnabled(this@MainActivity, false); tellPageNotify(false); return@runOnUiThread }
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFY_PERMISSION_REQUEST)
                    return@runOnUiThread
                }
                NotifyService.setEnabled(this@MainActivity, true)
                tellPageNotify(true)
            }
        }
    }

    private fun tellPageNotify(on: Boolean) {
        PageCall.run(web, "w.nativeNotifyChanged&&w.nativeNotifyChanged($on)")
    }

    // The pending <input type=file> callback. The WebView contract: answer
    // exactly once, with null on cancel, or the page never opens a picker again.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    // A page's own microphone request (getUserMedia) waiting for Android's answer.
    private var pendingWebMic: PermissionRequest? = null
    // True when the input accepts only images: the picked files are then
    // decoded here (see ImageIngest) instead of being handed to the page.
    private var fileChooserWantsImages = false
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var visibleBarsBeforeFullscreen = 0
    private var barsBehaviorBeforeFullscreen = 0

    inner class InkBridge {
        @JavascriptInterface
        fun setEnabled(on: Boolean) {
            runOnUiThread {
                ink.visibility = if (on) View.VISIBLE else View.GONE
                if (!on) ink.clearAll()
            }
        }
        @JavascriptInterface
        fun setErase(on: Boolean) {
            runOnUiThread { ink.erase = on }
        }
        @JavascriptInterface
        fun clearLive() {
            runOnUiThread { ink.clearLive() }
        }
        @JavascriptInterface
        fun clearAll() {
            runOnUiThread { ink.clearAll() }
        }
    }
    private lateinit var web: WebView
    private lateinit var anywhere: AnywhereShell
    // "anywhere": paired computers through the encrypted link (design/85);
    // "server": one server by address (Tailscale, home network).
    private var mode = "anywhere"
    private lateinit var speech: SpeechBridge
    private lateinit var listen: ListenBridge
    private lateinit var mic: MicBridge
    private lateinit var ink: InkOverlay
    private lateinit var setup: View
    private lateinit var error: TextView
    private lateinit var status: TextView

    /** Where the page is (being) loaded from; SpeechBridge reuses it. */
    @Volatile var serverBase: String = ""; private set
    @Volatile var serverToken: String = ""; private set

    // Connection state machine. Each openServer() bumps the generation so a
    // slow probe from an earlier attempt cannot flip the screen afterwards.
    private enum class Conn { IDLE, CONNECTING, LOADED, FAILED }
    private var conn = Conn.IDLE
    private var connectGeneration = 0
    private var pendingKey: String? = null
    private var pageOk = false
    private var lastAutoRetryMs = 0L
    private val main = Handler(Looper.getMainLooper())
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val isEinkDevice: Boolean
        get() = Build.MANUFACTURER.contains("iflytek", ignoreCase = true)
                || Build.MODEL.startsWith("XF-T5", ignoreCase = true)

    private val isPhone: Boolean
        get() = !isEinkDevice && resources.configuration.smallestScreenWidthDp < 600

    private fun deviceScript(): String = when {
        isEinkDevice -> "try{localStorage.setItem('chattering.theme','eink');document.documentElement.dataset.theme='eink';document.documentElement.dataset.form='eink'}catch(e){}"
        isPhone -> "try{let t=localStorage.getItem('chattering.theme');if(!t||t==='eink'){t='rockfrog';localStorage.setItem('chattering.theme',t)}if(t==='auto')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=t;document.documentElement.dataset.form='phone'}catch(e){}"
        else -> "try{document.documentElement.dataset.form='tablet'}catch(e){}"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        ink = findViewById(R.id.ink)
        setup = findViewById(R.id.setup)
        error = findViewById(R.id.error)
        status = findViewById(R.id.status)
        val server = findViewById<EditText>(R.id.server)
        val token = findViewById<EditText>(R.id.token)
        val prefs = getSharedPreferences("chattering", Context.MODE_PRIVATE)
        server.setText(prefs.getString("server", ""))
        token.setText(prefs.getString("token", ""))
        findViewById<Button>(R.id.connect).setOnClickListener {
            val url = ServerReach.normalizeBase(server.text.toString())
            val pin = token.text.toString().trim()
            if (url.isEmpty()) {
                showError("Enter the server address.")
                return@setOnClickListener
            }
            prefs.edit().putString("server", url).putString("token", pin).putString("mode", "server").apply()
            mode = "server"
            openServer(url, pin)
        }
        findViewById<Button>(R.id.pairInstead).setOnClickListener { openAnywhere(null) }
        configureInk()
        anywhere = AnywhereShell(this)
        speech = SpeechBridge(this, web)
        listen = ListenBridge(this, web)
        mic = MicBridge(this, web)
        configureWebView()
        val saved = prefs.getString("server", "") ?: ""
        val link = intent?.data
        when {
            // A pairing code scanned with the camera, or a relay link tapped.
            anywhere.isRelay(link) || anywhere.isPairingLink(link) -> openAnywhere(link.toString())
            prefs.getString("mode", null) == "anywhere" -> openAnywhere(null)
            saved.isNotEmpty() && prefs.contains("token") -> {
                mode = "server"
                openServer(saved, prefs.getString("token", "") ?: "", intent?.getStringExtra(NotifyService.EXTRA_KEY))
            }
            else -> openAnywhere(null)
        }
        NotifyService.startIfEnabled(this)
    }

    // A tapped notification lands here (singleTask): jump the loaded page to
    // that conversation instead of reloading everything.
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val link = intent?.data
        if (anywhere.isRelay(link) || anywhere.isPairingLink(link)) { openAnywhere(link.toString()); return }
        val key = intent?.getStringExtra(NotifyService.EXTRA_KEY) ?: return
        if (web.visibility != View.VISIBLE) return
        val encoded = Uri.encode(key)
        PageCall.run(web, "w.location.hash='#$encoded'")
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && mode == "anywhere" && ::web.isInitialized) web.evaluateJavascript("window.anywhereAppFocus&&window.anywhereAppFocus()", null)
    }

    override fun onResume() {
        super.onResume()
        NotifyService.appOnScreen = true
        if (::web.isInitialized) web.onResume()
        if (::listen.isInitialized) listen.onResume()
        if (::mic.isInitialized) mic.onResume()
        // Coming back to a failed screen: the user may have fixed Wi-Fi or
        // Tailscale in the meantime, so try again without being asked.
        if (conn == Conn.FAILED) autoRetry()
    }

    override fun onPause() {
        NotifyService.appOnScreen = false
        if (::listen.isInitialized) listen.onPause()
        if (::mic.isInitialized) mic.onPause()
        if (::web.isInitialized) {
            PageCall.run(web, "w.document.querySelectorAll('video').forEach(v=>v.pause())")
            web.onPause()
        }
        super.onPause()
    }

    // A network change (Wi-Fi joined, mobile data, Tailscale up) is the
    // moment a failed connection becomes possible again. Only failures are
    // retried: a loaded page keeps its own event stream alive.
    override fun onStart() {
        super.onStart()
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post { if (conn == Conn.FAILED) autoRetry() }
            }
        }
        try { cm.registerDefaultNetworkCallback(cb); networkCallback = cb } catch (_: Exception) {}
    }

    override fun onStop() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        networkCallback?.let { try { cm?.unregisterNetworkCallback(it) } catch (_: Exception) {} }
        networkCallback = null
        super.onStop()
    }

    /** Retries the last connection at most once every few seconds. */
    private fun autoRetry(): Boolean {
        val now = SystemClock.uptimeMillis()
        if (now - lastAutoRetryMs < 3000 || serverBase.isEmpty()) return false
        lastAutoRetryMs = now
        openServer(serverBase, serverToken, pendingKey)
        return true
    }

    private fun showSetup() {
        hideFullscreenVideo()
        status.visibility = View.GONE
        setup.visibility = View.VISIBLE
        web.visibility = View.GONE
    }

    private fun showError(message: String) {
        error.visibility = View.VISIBLE
        error.text = message
    }

    private fun showStatus(message: String) {
        status.text = message
        status.visibility = View.VISIBLE
    }

    private fun configureInk() {
        ink.listener = InkOverlay.Listener { packed, erase ->
            val safe = packed.replace("'", "")
            PageCall.run(web, "w.fileInkAcceptPacked&&w.fileInkAcceptPacked('$safe',$erase)")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // Phones must honor the viewport meta tag. Desktop overview mode
            // shrinks the complete Gantt into an unreadable 980 px canvas.
            loadWithOverviewMode = !isPhone
            useWideViewPort = !isPhone
            textZoom = 100
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        web.addJavascriptInterface(InkBridge(), "ChatteringInk")
        web.addJavascriptInterface(speech, "ChatteringSpeech")
        web.addJavascriptInterface(listen, "ChatteringListen")
        web.addJavascriptInterface(mic, "ChatteringMic")
        web.addJavascriptInterface(NotifyBridge(), "ChatteringNotify")
        web.addJavascriptInterface(AppBridge(), "ChatteringApp")
        web.setDownloadListener { url, userAgent, disposition, mime, _ ->
            downloadMedia(url, userAgent, disposition, mime)
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (view == null || fullscreenView != null) { callback?.onCustomViewHidden(); return }
                val controller = WindowCompat.getInsetsController(window, window.decorView)
                val insets = ViewCompat.getRootWindowInsets(window.decorView)
                visibleBarsBeforeFullscreen = 0
                for (bar in intArrayOf(WindowInsetsCompat.Type.statusBars(), WindowInsetsCompat.Type.navigationBars())) {
                    if (insets?.isVisible(bar) != false) visibleBarsBeforeFullscreen = visibleBarsBeforeFullscreen or bar
                }
                barsBehaviorBeforeFullscreen = controller.systemBarsBehavior
                fullscreenView = view; fullscreenCallback = callback
                view.setBackgroundColor(android.graphics.Color.BLACK)
                findViewById<FrameLayout>(android.R.id.content).addView(view,
                    FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
                web.visibility = View.INVISIBLE
                controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(WindowInsetsCompat.Type.systemBars())
            }

            override fun onHideCustomView() { hideFullscreenVideo() }

            // A page asking for the microphone itself (getUserMedia). The
            // WebView denies every such request unless the app answers it,
            // whatever Android's settings say: dictation and voice commands
            // that record in the page said "Permission denied" with the
            // microphone allowed. Only the microphone, and only for the page
            // Chattering shows (the address it loaded: the server, or the
            // relay's page and the app inside it), never for the other
            // origins it frames (what agents make, at their own address).
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                    val others = request.resources.any { it != PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                    if (!wantsMic || others || !sameOrigin(request.origin, web.url)) { request.deny(); return@runOnUiThread }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else {
                        pendingWebMic?.deny()
                        pendingWebMic = request
                        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), WEB_MIC_PERMISSION_REQUEST)
                    }
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingWebMic === request) pendingWebMic = null
            }


            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                val accepts = params?.acceptTypes?.filter { it.isNotBlank() } ?: emptyList()
                fileChooserWantsImages = accepts.isNotEmpty() && accepts.all { it.trim().startsWith("image/") }
                val intent = try {
                    params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                } catch (_: Exception) {
                    Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                }
                if (params?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try {
                    startActivityForResult(Intent.createChooser(intent, "Choose"), FILE_CHOOSER_REQUEST)
                    true
                } catch (_: Exception) {
                    fileChooserCallback = null
                    callback?.onReceiveValue(null)
                    false
                }
            }
        }
        // The relay's pages come from this app, never the network (AnywhereShell):
        // for the page itself, and for the service worker's own fetches.
        ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
            override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? = anywhere.intercept(request)
        })
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
                anywhere.intercept(request)

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                view?.evaluateJavascript(deviceScript(), null)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                view?.evaluateJavascript(deviceScript(), null)
            }

            // Self-signed certificates are the norm for a personal server on
            // the home LAN or the tailnet; anywhere else they stay an error.
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                val host = ServerReach.host(error?.url ?: "")
                if (ServerReach.isPrivateHost(host)) handler?.proceed() else handler?.cancel()
            }

            override fun onPageCommitVisible(view: WebView?, url: String?) {
                pageOk = true
                if (conn == Conn.CONNECTING) { conn = Conn.LOADED; status.visibility = View.GONE }
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame != true) return
                // The encrypted link's page comes from the app itself; its own
                // screens say when the computer cannot be reached.
                if (mode == "anywhere") return
                // The page itself failed (server went away, network switched
                // mid-load). Go through the same connect path: it starts
                // Tailscale when that is what is missing, and otherwise
                // explains the failure instead of leaving a white page.
                conn = Conn.FAILED
                pageOk = false
                if (!autoRetry()) fail(reachFailureText(ServerReach.host(serverBase), error?.description?.toString()))
            }

            // The page routes links to other sites through ChatteringApp
            // .openExternal (it knows a link from the machine switcher; this
            // side does not). Here only non-web schemes (mailto:, tel:,
            // intent:) are handed out: the WebView cannot show them and
            // would replace Chattering with an error page.
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                val scheme = url.scheme?.lowercase() ?: return false
                if (scheme == "http" || scheme == "https" || scheme == "file" || scheme == "about" || scheme == "javascript") return false
                return openOutside(url)
            }
        }
    }

    private fun hideFullscreenVideo() {
        val view = fullscreenView ?: return
        fullscreenView = null
        (view.parent as? android.view.ViewGroup)?.removeView(view)
        web.visibility = View.VISIBLE
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior = barsBehaviorBeforeFullscreen
        controller.show(visibleBarsBeforeFullscreen)
        val callback = fullscreenCallback; fullscreenCallback = null
        callback?.onCustomViewHidden()
    }

    private fun downloadMedia(url: String, userAgent: String?, disposition: String?, mime: String?) {
        try {
            val uri = Uri.parse(url)
            val server = Uri.parse(serverBase)
            // Never forward session cookies to a different origin or an arbitrary
            // redirecting endpoint. The media endpoint streams the authorized file.
            val port: (Uri) -> Int = { if (it.port != -1) it.port else if (it.scheme == "https") 443 else 80 }
            require(uri.scheme in listOf("https", "http") && uri.scheme == server.scheme &&
                uri.host == server.host && port(uri) == port(server) && uri.path == "/api/file/media")
            // WebView may call DownloadListener before exposing the response's
            // Content-Disposition (notably for <a download>). Our authorized
            // endpoint already carries the original filename in its path query.
            val originalName = uri.getQueryParameter("path")?.substringAfterLast('/')
                ?.takeIf { it.isNotBlank() && it != "." && it != ".." }
            val name = (originalName ?: URLUtil.guessFileName(url, disposition, mime))
                .replace(Regex("[\\\\/\\p{Cntrl}]"), "_")
            val request = DownloadManager.Request(uri)
                .setTitle(name).setMimeType(mime ?: "application/octet-stream")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
            userAgent?.let { request.addRequestHeader("User-Agent", it) }
            if (Build.VERSION.SDK_INT >= 29) request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            else request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name)
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            Toast.makeText(this, "Downloading $name — see Downloads", Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            val why = if (mode == "anywhere") "Downloads do not go through the encrypted link yet." else "Could not start this download. Try opening Chattering in your browser."
            Toast.makeText(this, why, Toast.LENGTH_LONG).show()
        }
    }

    fun requestListenPermission() {
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), LISTEN_PERMISSION_REQUEST)
    }

    fun requestMicPermission() {
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MIC_PERMISSION_REQUEST)
    }

    fun requestSpeechPermission() {
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), SPEECH_PERMISSION_REQUEST)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_CHOOSER_REQUEST) return
        val cb = fileChooserCallback ?: return
        fileChooserCallback = null
        val wantsImages = fileChooserWantsImages
        fileChooserWantsImages = false
        val uris = mutableListOf<Uri>()
        if (resultCode == RESULT_OK && data != null) {
            data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
        }
        if (!wantsImages || uris.isEmpty()) {
            cb.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
            return
        }
        // Pictures never reach the page as files. The WebView would decode a
        // 30 MB camera shot in full (and cannot read HEIC at all); the app
        // decodes each one at a sampled size and attaches a small JPEG
        // through the same hook that pasted images use. The input itself
        // sees a cancel, which is the answer the WebView contract allows.
        cb.onReceiveValue(null)
        ingestPickedImages(uris)
    }

    private fun ingestPickedImages(uris: List<Uri>) {
        Thread({
            var failed = 0
            for (uri in uris) {
                val jpeg = try { ImageIngest.toJpeg(this, uri) } catch (_: Throwable) { null }
                if (jpeg == null) { failed++; continue }
                val name = (ImageIngest.displayName(this, uri) ?: "photo").substringBeforeLast('.') + ".jpg"
                ImageIngest.inject(web, jpeg, name)
            }
            if (failed > 0) runOnUiThread {
                val what = if (uris.size == 1) "that picture" else "$failed of ${uris.size} pictures"
                Toast.makeText(this, "Could not read $what.", Toast.LENGTH_LONG).show()
            }
        }, "chattering-pick").start()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == LISTEN_PERMISSION_REQUEST) {
            listen.onPermissionResult(grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
        } else if (requestCode == SPEECH_PERMISSION_REQUEST) {
            speech.onPermissionResult(
                grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
        } else if (requestCode == MIC_PERMISSION_REQUEST) {
            mic.onPermissionResult(grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
        } else if (requestCode == WEB_MIC_PERMISSION_REQUEST) {
            val request = pendingWebMic ?: return
            pendingWebMic = null
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            else request.deny()
        } else if (requestCode == NOTIFY_PERMISSION_REQUEST) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            NotifyService.setEnabled(this, granted)
            tellPageNotify(granted)
        }
    }

    // Same scheme, host and port: the page asking is the page Chattering shows.
    private fun sameOrigin(origin: Uri?, url: String?): Boolean {
        if (origin == null || url.isNullOrEmpty()) return false
        val top = Uri.parse(url)
        fun port(u: Uri) = if (u.port != -1) u.port else if (u.scheme == "https") 443 else if (u.scheme == "http") 80 else -1
        return origin.scheme.equals(top.scheme, true) && origin.host.equals(top.host, true) && port(origin) == port(top)
    }

    // Hand a URL to whatever app handles it (browser, mail, maps). Returns
    // true when something took it; false lets the WebView load it as the
    // last resort on a device with no handler at all.
    private fun openOutside(url: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: Exception) {
            false
        }
    }

    // Page-side bridge: a link to another site leaves for the device
    // browser instead of replacing Chattering inside this WebView (which has no
    // way back on a device without a navigation bar). Never fall back to
    // loading an untrusted site in the WebView that exposes native bridges.
    inner class AppBridge {
        /** This app's version (from 0.3.6; older apps have no version()).
         *  The page compares it with the one its computer knows and offers
         *  the update: the app is not on a store that would update it. */
        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        /** The page's paste field: a pairing link, opened here. */
        @JavascriptInterface
        fun openLink(url: String) {
            runOnUiThread {
                val parsed = try { Uri.parse(url) } catch (_: Exception) { null } ?: return@runOnUiThread
                if (anywhere.isPairingLink(parsed)) openAnywhere(parsed.toString())
            }
        }

        /** "Scan the pairing code": Google's scanner; a pairing link opens here. */
        @JavascriptInterface
        fun scanCode() {
            runOnUiThread {
                try {
                    val options = com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder()
                        .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE)
                        .build()
                    com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(this@MainActivity, options).startScan()
                        .addOnSuccessListener { code ->
                            val text = code.rawValue ?: ""
                            val uri = try { Uri.parse(text) } catch (_: Exception) { null }
                            if (anywhere.isPairingLink(uri)) openAnywhere(text)
                            else Toast.makeText(this@MainActivity, "That is not a Chattering pairing code.", Toast.LENGTH_LONG).show()
                        }
                        .addOnFailureListener {
                            Toast.makeText(this@MainActivity, "The scanner is not available here: scan the code with your camera app instead.", Toast.LENGTH_LONG).show()
                        }
                } catch (_: Throwable) {
                    Toast.makeText(this@MainActivity, "The scanner is not available here: scan the code with your camera app instead.", Toast.LENGTH_LONG).show()
                }
            }
        }

        /** A pairing link on the clipboard (the browser's "Use the Android app"
         *  copies it before the download): offered, never used unasked. */
        @JavascriptInterface
        fun clipboardPairingLink(): String {
            return try {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString()?.trim() ?: ""
                val uri = try { Uri.parse(text) } catch (_: Exception) { null }
                if (text.length < 400 && anywhere.isPairingLink(uri) && uri?.scheme == "https" && anywhere.isRelay(uri)) text else ""
            } catch (_: Exception) { "" }
        }

        /** Forget the clipboard's link once used or declined. */
        @JavascriptInterface
        fun clearClipboardLink() {
            runOnUiThread {
                try {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip()
                } catch (_: Exception) {}
            }
        }

        /** "Use a server address instead": the form for one server by address. */
        @JavascriptInterface
        fun useServerAddress() {
            runOnUiThread {
                mode = "server"
                getSharedPreferences("chattering", Context.MODE_PRIVATE).edit().putString("mode", "server").apply()
                connectGeneration++
                conn = Conn.IDLE
                showSetup()
            }
        }

        @JavascriptInterface
        fun openExternal(url: String) {
            runOnUiThread {
                val parsed = try { Uri.parse(url) } catch (_: Exception) { null } ?: return@runOnUiThread
                if (!openOutside(parsed)) Toast.makeText(this@MainActivity, "No application can open this link.", Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * Connects in three steps, each explained on screen: make sure a route
     * exists (start Tailscale if the address needs it), check that the server
     * answers with this token, then load the page. Each failure lands on the
     * setup screen with the actual reason; the network callback and onResume
     * retry it on their own once conditions change.
     */
    private fun openServer(rawBase: String, pin: String, conversationKey: String? = null) {
        val base = ServerReach.normalizeBase(rawBase)
        if (base.isEmpty()) { showSetup(); return }
        serverBase = base
        serverToken = pin
        pendingKey = conversationKey
        val generation = ++connectGeneration
        conn = Conn.CONNECTING
        error.visibility = View.GONE
        setup.visibility = View.GONE
        val host = ServerReach.host(base)
        // An already loaded page stays on screen while a retry runs behind it.
        if (web.visibility != View.VISIBLE) {
            web.visibility = View.VISIBLE
            showStatus(if (ServerReach.needsTailscale(this, base)) "Starting Tailscale…" else "Connecting to $host…")
        }
        ServerReach.ensure(this, base) { routeOk, note ->
            if (generation != connectGeneration) return@ensure
            if (!routeOk) { fail(note ?: "No route to $host."); return@ensure }
            if (status.visibility == View.VISIBLE) showStatus("Connecting to $host…")
            ServerReach.probe(base, pin) { probe ->
                if (generation != connectGeneration) return@probe
                when (probe.status) {
                    200 -> {
                        val hash = if (conversationKey != null) "#" + Uri.encode(conversationKey) else ""
                        val target = if (pin.isEmpty()) "$base/$hash" else "$base/?token=$pin$hash"
                        web.loadUrl(target)
                    }
                    401, 403 -> fail("$host answered, but the token is wrong. It is in ~/.cache/chattering/lan-token on the server.")
                    null -> fail(reachFailureText(host, probe.error))
                    else -> fail("$host answered with HTTP ${probe.status}.")
                }
            }
        }
    }

    /**
     * Chattering through the encrypted link: the relay's address, with the
     * page served from this app (AnywhereShell). A link (a scanned code) is
     * loaded as is; otherwise the relay this phone last used.
     */
    private fun openAnywhere(link: String?) {
        val prefs = getSharedPreferences("chattering", Context.MODE_PRIVATE)
        val uri = link?.let { try { anywhere.normalize(Uri.parse(it)) } catch (_: Exception) { null } }
        if (uri != null && uri.scheme == "https" && uri.host != null) {
            anywhere.remember(uri)
            prefs.edit().putString("relay", "https://${uri.host}").apply()
        }
        mode = "anywhere"
        prefs.edit().putString("mode", "anywhere").apply()
        connectGeneration++
        serverBase = ""
        conn = Conn.LOADED
        pageOk = true
        hideFullscreenVideo()
        setup.visibility = View.GONE
        status.visibility = View.GONE
        error.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.loadUrl(uri?.toString() ?: ((prefs.getString("relay", null) ?: AnywhereShell.DEFAULT_RELAY) + "/"))
    }

    private fun reachFailureText(host: String, detail: String?): String {
        val where = when {
            ServerReach.isTailnetHost(host) && !ServerReach.hasVpn(this) -> "Tailscale is off, so $host cannot be reached."
            ServerReach.isTailnetHost(host) -> "Tailscale is on but $host does not answer. Is Chattering running there?"
            else -> "$host does not answer on this network. Is Chattering running, and is this device on the same network?"
        }
        return if (detail.isNullOrBlank()) where else "$where ($detail)"
    }

    private fun fail(message: String) {
        conn = Conn.FAILED
        // A page that is still showing stays; a broken or never-loaded one
        // gives way to the setup screen with the reason.
        if (pageOk) status.visibility = View.GONE
        else { showSetup(); showError(message) }
    }

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
        if (ink.visibility == View.VISIBLE && InkOverlay.isStylusTool(ev.getToolType(ev.actionIndex))) {
            ink.markStylus()
        }
        return super.dispatchGenericMotionEvent(ev)
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ink.visibility != View.VISIBLE) return super.dispatchTouchEvent(ev)
        var stylus = false
        for (i in 0 until ev.pointerCount) {
            if (InkOverlay.isStylusTool(ev.getToolType(i))) {
                stylus = true
                break
            }
        }
        if (stylus) {
            ink.requestUnbufferedDispatch(ev)
            ink.feed(ev)
            return true
        }
        if (ink.isDrawing()) {
            ink.feed(ev)
            return true
        }
        val finger = ev.getToolType(ev.actionIndex) == MotionEvent.TOOL_TYPE_FINGER
                || ev.getToolType(ev.actionIndex) == MotionEvent.TOOL_TYPE_UNKNOWN
        if (finger && SystemClock.uptimeMillis() - ink.lastStylusMs < 800) {
            return true
        }
        return super.dispatchTouchEvent(ev)
    }

    override fun onDestroy() {
        hideFullscreenVideo()
        if (::speech.isInitialized) speech.destroy()
        if (::listen.isInitialized) listen.destroy()
        if (::mic.isInitialized) mic.destroy()
        super.onDestroy()
    }

    override fun onBackPressed() {
        when {
            fullscreenView != null -> hideFullscreenVideo()
            setup.visibility == View.VISIBLE && mode == "server" && getSharedPreferences("chattering", Context.MODE_PRIVATE).getString("server", "").isNullOrEmpty() -> openAnywhere(null)
            setup.visibility == View.VISIBLE -> super.onBackPressed()
            // The page goes first (design/58): a sheet, a menu, a picker or a
            // dialog closes; only with nothing open does history move.
            else -> web.evaluateJavascript("!!(window.chatteringBack&&window.chatteringBack())") { handled ->
                if (handled == "true") return@evaluateJavascript
                when {
                    web.canGoBack() -> web.goBack()
                    mode == "anywhere" -> moveTaskToBack(true)
                    else -> { connectGeneration++; conn = Conn.IDLE; showSetup() }
                }
            }
        }
    }
}
