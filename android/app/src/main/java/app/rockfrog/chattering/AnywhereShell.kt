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
 *
 * Previews (design/67) have their own site, previews.<relay>: there only
 * the worker and the carrier (carrier.html, carrier.js) come from here;
 * every other request of that site goes through the carrier and the tunnel
 * to the person's computer, never to the network, and never the shell.
 */
class AnywhereShell(private val context: Context) {
    companion object {
        const val DEFAULT_RELAY = "https://encrypted-link-to-your-devices.rockfrog.ai"
        /** The browser hands a pairing code to this app on this scheme. */
        const val HANDOFF_SCHEME = "chattering"
        private val NAME = Regex("^[a-z0-9-]+\\.[a-z]+$")
        private val TYPES = mapOf(
            "html" to "text/html", "js" to "text/javascript", "css" to "text/css",
            "webmanifest" to "application/manifest+json", "json" to "application/json",
            "png" to "image/png", "svg" to "image/svg+xml",
        )
        private const val PREVIEW_LABEL = "previews."
        private val CARRIER = setOf("carrier.html", "carrier.js")
        private fun shellCsp(host: String) = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
            "connect-src 'self' wss: ws:; frame-src 'self' $PREVIEW_LABEL$host; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        private fun carrierCsp(relayHost: String) =
            "default-src 'none'; script-src 'self'; frame-ancestors $relayHost; base-uri 'none'; form-action 'none'"
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

    /** The relay a preview address belongs to (previews.<relay> → <relay>), or null. */
    private fun relayOfPreview(uri: Uri?): String? {
        if (uri == null || uri.scheme != "https") return null
        val host = uri.host ?: return null
        if (!host.startsWith(PREVIEW_LABEL)) return null
        return host.removePrefix(PREVIEW_LABEL).takeIf { it in relays() }
    }

    /** A pairing link: …/#pair=… (a scanned code), or …/pair/<code> (handed
     *  over by the browser's "Use the Android app" button, as an intent URL,
     *  which cannot carry a # of its own). */
    fun isPairingLink(uri: Uri?): Boolean =
        uri != null && (
            (uri.scheme == "https" && ((uri.fragment ?: "").contains("pair=") || (uri.path ?: "").startsWith("/pair/"))) ||
            (uri.scheme == HANDOFF_SCHEME && uri.host == "pair"))

    /** The link as the page reads it: the code after #, where it never
     *  leaves the phone. */
    fun normalize(uri: Uri): Uri {
        val path = uri.path ?: return uri
        // chattering://pair/<code>?n=<name>&r=<relay host>: from the browser's
        // "Use the Android app" button. Only a relay this app already knows
        // (Rockfrog's, or one used before): a web page cannot send this app
        // to a relay of its choosing.
        val handoff = uri.scheme == HANDOFF_SCHEME && uri.host == "pair"
        if (!handoff && !path.startsWith("/pair/")) return uri
        val authority = if (handoff) {
            val r = uri.getQueryParameter("r") ?: Uri.parse(DEFAULT_RELAY).host!!
            if (r !in relays()) return Uri.parse(DEFAULT_RELAY + "/")
            r
        } else uri.authority
        val code = path.removePrefix("/").removePrefix("pair/")
        if (!Regex("^[A-Za-z0-9_-]{8,64}\\.[A-Za-z0-9_-]{8,64}\\.[A-Za-z0-9_-]{8,64}$").matches(code)) return uri
        val name = uri.getQueryParameter("n")?.take(60)
        val expires = uri.getQueryParameter("e")?.takeIf { Regex("^\\d{9,11}$").matches(it) }
        val fragment = "pair=$code" + (if (name.isNullOrEmpty()) "" else "&n=" + Uri.encode(name)) + (if (expires == null) "" else "&e=$expires")
        return Uri.Builder().scheme("https").authority(authority).path("/").encodedFragment(fragment).build()
    }

    fun intercept(request: WebResourceRequest?): WebResourceResponse? {
        val uri = request?.url ?: return null
        val previewOf = relayOfPreview(uri)
        if (previewOf != null) return interceptPreview(uri, previewOf)
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
        // The carrier is the preview address's alone.
        if (!NAME.matches(name) || name in CARRIER) return notFound()
        val bytes = try {
            context.assets.open("anywhere/$name").use { it.readBytes() }
        } catch (_: Exception) {
            return notFound()
        }
        val headers = mutableMapOf(
            "Cache-Control" to "no-cache",
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "no-referrer",
            "Cross-Origin-Opener-Policy" to "same-origin",
        )
        if (name == "sw.js") headers["Service-Worker-Allowed"] = "/"
        if (name == "shell.html") headers["Content-Security-Policy"] = shellCsp(uri.host!!)
        return asset(name, bytes, headers)
    }

    /** previews.<relay>: the worker and the carrier from this app; any other
     *  address there reached here only because the worker was not ready,
     *  and gets a plain line, never the network. */
    private fun interceptPreview(uri: Uri, relayHost: String): WebResourceResponse {
        val path = uri.path ?: "/"
        val name = when {
            path == "/sw.js" -> "sw.js"
            path.startsWith("/_anywhere/") && path.removePrefix("/_anywhere/") in CARRIER -> path.removePrefix("/_anywhere/")
            else -> return WebResourceResponse("text/html", "utf-8", 404, "Not Found",
                mapOf("Cache-Control" to "no-store", "Content-Security-Policy" to "default-src 'none'; style-src 'unsafe-inline'"),
                ByteArrayInputStream("<!doctype html><meta charset=utf-8><body style=\"font:15px/1.5 system-ui,sans-serif;padding:1em;color:#888\">This preview is not connected to your computer. Close it and open it again.".toByteArray()))
        }
        val bytes = try {
            context.assets.open("anywhere/$name").use { it.readBytes() }
        } catch (_: Exception) {
            return notFound()
        }
        val headers = mutableMapOf(
            "Cache-Control" to "no-cache",
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "no-referrer",
        )
        if (name == "sw.js") headers["Service-Worker-Allowed"] = "/"
        if (name == "carrier.html") headers["Content-Security-Policy"] = carrierCsp(relayHost)
        return asset(name, bytes, headers)
    }

    private fun asset(name: String, bytes: ByteArray, headers: Map<String, String>): WebResourceResponse {
        val type = TYPES[name.substringAfterLast('.')] ?: "application/octet-stream"
        val text = type.startsWith("text/") || type.endsWith("json") || type.endsWith("xml")
        return WebResourceResponse(type, if (text) "utf-8" else null, 200, "OK", headers, ByteArrayInputStream(bytes))
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
        mapOf("Cache-Control" to "no-store"), ByteArrayInputStream("not found\n".toByteArray()))

    private fun oneMoment() = WebResourceResponse("text/html", "utf-8", 503, "Service Unavailable",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream("<!doctype html><meta charset=utf-8><body style=\"font:16px system-ui;padding:2em\">One moment…".toByteArray()))
}
