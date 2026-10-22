package app.rockfrog.chattering

import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** The frog is calling (FrogCallService, design/102 part 4): a plain
 *  full-screen page over the lock screen, the screen turned on, with
 *  Decline and Answer. Answering opens Chattering on the frog with Talk on
 *  (the headset's button answers too; then this page just goes). Declared
 *  showWhenLocked and turnScreenOn in the manifest: only this page is, so
 *  the workspace itself never shows on a locked phone. */
class FrogRingActivity : AppCompatActivity() {
    private val watcher: (String) -> Unit = { state -> if (state != "ringing") finish() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        else @Suppress("DEPRECATION") window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (FrogCallService.state != "ringing") { finish(); return }
        val d = resources.displayMetrics.density
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#1F3D2B"))
            setPadding((32 * d).toInt(), (32 * d).toInt(), (32 * d).toInt(), (32 * d).toInt())
        }
        root.addView(ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher)
            layoutParams = LinearLayout.LayoutParams((120 * d).toInt(), (120 * d).toInt()).apply { bottomMargin = (24 * d).toInt() }
        })
        root.addView(TextView(this).apply {
            text = intent.getStringExtra(FrogCallService.EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: "The frog is calling"
            setTextColor(Color.WHITE); textSize = 28f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
        })
        root.addView(TextView(this).apply {
            text = intent.getStringExtra(FrogCallService.EXTRA_BODY)?.takeIf { it.isNotBlank() } ?: "Chattering"
            setTextColor(Color.parseColor("#CFE3D6")); textSize = 18f; gravity = Gravity.CENTER
            setPadding(0, (12 * d).toInt(), 0, (48 * d).toInt())
        })
        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        fun button(label: String, color: String, onClick: () -> Unit) = Button(this).apply {
            text = label; textSize = 18f; setTextColor(Color.WHITE); setBackgroundColor(Color.parseColor(color)); isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(0, (64 * d).toInt(), 1f).apply { marginStart = (8 * d).toInt(); marginEnd = (8 * d).toInt() }
            setOnClickListener { onClick() }
        }
        buttons.addView(button("Decline", "#B3261E") { FrogCallService.decline(this); finish() })
        buttons.addView(button("Answer", "#2E7D4F") {
            FrogCallService.answer(this)
            startActivity(FrogCallService.openIntent(this, "answered"))
            finish()
        })
        root.addView(buttons, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        setContentView(root)
        root.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    override fun onStart() { super.onStart(); FrogCallService.watch(watcher); if (FrogCallService.state != "ringing") finish() }
    override fun onStop() { FrogCallService.unwatch(watcher); super.onStop() }
}
