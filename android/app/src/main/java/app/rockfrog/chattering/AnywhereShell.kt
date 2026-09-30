package app.rockfrog.chattering

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

/**
 * Chattering Anywhere inside the app (design/85, design/86): the phone's page
 * comes from this APK, never from the relay.
 *
 * The WebView opens the relay's address (https://encrypted-link-to-your-devices.rockfrog.ai/…),
 * so the page keeps the origin it pairs under and the relay's WebSocket
 * introductions work as on the web. But every page, script and style for
 * that address is answered here, from assets/anywhere/ (copied from the
 * repository's anywhere/ at build time): shouldInterceptRequest for the
 * page, the service worker's client for the worker's own fetches. Nothing
 * for that origin is ever fetched from the network, except the WebSocket
 * (/signal), which WebView does not route through interception and which
 * carries only introductions. So the relay cannot replace the code that
 * holds this phone's keys: it is the code signed into the app.
 *
 * The same routing as anywhere/relay.js: /sw.js → the worker; /_anywhere/<file>
 * → the shell's files; any other page → the shell (the app's routes are
 * the phone's too).
 */
class AnywhereShell(private val context: Context) {
    companion object {
        const val DEFAULT_RELAY = "https://encrypted-link-to-your-devices.rockfrog.ai"
        private val NAME = Regex("^[a-z0-9-]+\\.[a-z]+$")
        private val TYPES = mapOf(
            "html" to "text/html", "js" to "text/javascript", "css" to "text/css",
            "webmanifest" to "application/manifest+json", "json" to "application/json",
            "png" to "image/png", "svg" to "image/svg+xml",
        )
        private const val SHELL_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
            "connect-src 'self' wss: ws:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    }

    private val prefs = context.getSharedPreferences("chattering", Context.MODE_PRIVATE)

    /** The relays this app answers for: Rockfrog's, and any a pairing link named. */
    fun relays(): Set<String> =
        (prefs.getStringSet("relays", emptySet()) ?: emptySet()) + Uri.parse(DEFAULT_RELAY).host!!

    fun remember(uri: Uri) {
        val host = uri.host ?: return
        if (uri.scheme != "https" || host in relays()) return
        prefs.edit().putStringSet("relays", (prefs.getStringSet("relays", emptySet()) ?: emptySet()) + host).apply()
    }

    fun isRelay(uri: Uri?): Boolean = uri != null && uri.scheme == "https" && uri.host != null && uri.host in relays()

    /** A pairing link (…/#pair=…) for a relay. */
    fun isPairingLink(uri: Uri?): Boolean =
        uri != null && uri.scheme == "https" && (uri.fragment ?: "").contains("pair=")

    fun intercept(request: WebResourceRequest?): WebResourceResponse? {
        val uri = request?.url ?: return null
        if (!isRelay(uri)) return null
        val path = uri.path ?: "/"
        val name = when {
            path == "/sw.js" -> "sw.js"
            path.startsWith("/_anywhere/") -> path.removePrefix("/_anywhere/")
            // A page before the service worker took over: the shell for the
            // top level; never the shell inside itself.
            request.isForMainFrame -> "shell.html"
            else -> return oneMoment()
        }
        if (!NAME.matches(name)) return notFound()
        val bytes = try {
            context.assets.open("anywhere/$name").use { it.readBytes() }
        } catch (_: Exception) {
            return notFound()
        }
        val ext = name.substringAfterLast('.')
        val headers = mutableMapOf(
            "Cache-Control" to "no-cache",
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "no-referrer",
            "Cross-Origin-Opener-Policy" to "same-origin",
        )
        if (name == "sw.js") headers["Service-Worker-Allowed"] = "/"
        if (name == "shell.html") headers["Content-Security-Policy"] = SHELL_CSP
        val type = TYPES[ext] ?: "application/octet-stream"
        val text = type.startsWith("text/") || type.endsWith("json") || type.endsWith("xml")
        return WebResourceResponse(type, if (text) "utf-8" else null, 200, "OK", headers, ByteArrayInputStream(bytes))
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
        mapOf("Cache-Control" to "no-store"), ByteArrayInputStream("not found\n".toByteArray()))

    private fun oneMoment() = WebResourceResponse("text/html", "utf-8", 503, "Service Unavailable",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream("<!doctype html><meta charset=utf-8><body style=\"font:16px system-ui;padding:2em\">One moment…".toByteArray()))
}
