package app.rockfrog.chattering

import android.webkit.ValueCallback
import android.webkit.WebView

/**
 * Calls a hook of Chattering's page from the app (dictation events, picked
 * pictures, pen ink, notification state).
 *
 * Connected by address, the WebView's page is Chattering itself. Through the
 * encrypted link it is the relay's shell (anywhere/public/shell.js), and
 * Chattering runs in a frame inside it: a call made on the top window lands
 * in the shell, which has none of the app's hooks, and is dropped without a
 * word. That is how dictation and attached pictures did nothing on a paired
 * phone. The shell names the app's window (window.__anywhere.app()); the
 * script binds `w` to it, or to the top window when there is no shell.
 *
 * test/anywhere-browser.test.js reads OPEN and CLOSE from this file and runs
 * them against the real shell: keep them plain strings, without quotes.
 */
object PageCall {
    const val OPEN = "(function(){var w=window;try{var h=window.__anywhere,a=h&&h.app&&h.app();if(a)w=a}catch(e){}"
    const val CLOSE = "})()"

    /** [body] wrapped to run with `w` bound to the app's window. */
    fun script(body: String): String = OPEN + body + CLOSE

    /** Runs [body] in the app's window; callable from any thread. */
    fun run(web: WebView, body: String, result: ValueCallback<String>? = null) {
        web.post { web.evaluateJavascript(script(body), result) }
    }
}
