package app.rockfrog.chattering

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * The pen's live line over a handwritten note (design/98).
 *
 * The page asks for it (ChatteringInk.setEnabled) and says where the pen
 * writes (setRegion, in css pixels): only there does the pen draw here;
 * elsewhere it stays a pointer for the page. While the pen moves, the line
 * is drawn as fast as this device can:
 *   - on an e-ink panel with a Rockchip overlay (/dev/ebc: the AINOTE 2),
 *     straight onto the panel's overlay (EbcNib, the handwriting keyboard's
 *     nib): a few pixels in one small rectangle on the fast waveform,
 *     bypassing the compositor and the panel's slow full-frame update;
 *   - elsewhere, on this view, with unbuffered input.
 * When the pen lifts, the line goes to the page (Listener) with its pressure
 * and timing; the page settles it, paints it and says so (strokeDrawn). This
 * copy is wiped only once the pen has rested a moment (WIPE_MS), so while
 * writing nothing blinks, and afterwards the panel shows one copy of a line.
 */
class InkOverlay @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    fun interface Listener {
        /** pen: the pen the line was drawn with ("lasso": a selection loop, not ink). */
        fun onStroke(packed: String, erase: Boolean, pen: String)
    }

    var listener: Listener? = null
    var erase = false
    /**
     * Where the pen writes, in the page's css pixels (= dp), as the page
     * says (ChatteringInk.setRegion). Outside it the pen is a pointer again:
     * the toolbar, menus and links under it take its taps. Null: everywhere
     * (an older page that never set one).
     */
    var region: RectF? = null
    /**
     * Parts of the writing area the page has covered (its menus, a
     * selection and its buttons, a panel over the note), in the same css
     * pixels: a pen landing there is the page's, as if this layer were not
     * there (ChatteringInk.setHoles, design/99).
     */
    var holes: List<RectF> = emptyList()
    var lastStylusMs = 0L
        private set

    private val density = resources.displayMetrics.density
    /**
     * One css pixel of the page, in this view's pixels: the page's own
     * devicePixelRatio (setPixelRatio), which is the screen's density only
     * while the WebView is not zoomed. Region and lines both use it.
     */
    var cssPx = density
    private var widthCss = 2.3f
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.BLACK
        isDither = false
    }

    // The stroke being drawn, in this view's pixels.
    private var xs = FloatArray(1024)
    private var ys = FloatArray(1024)
    private var ps = FloatArray(1024)
    private var ts = LongArray(1024)
    private var rs = FloatArray(1024)
    private var n = 0
    private var t0 = 0L
    private var drawing = false
    private var stylusId = MotionEvent.INVALID_POINTER_ID
    private var pSmooth = -1f
    private val minDist2 = 0.6f * 0.6f // a sample under 0.6 px from the last adds nothing

    // Lines drawn on this view (when there is no panel overlay), kept until the wipe.
    private val segX0 = ArrayList<Float>(4096)
    private val segY0 = ArrayList<Float>(4096)
    private val segX1 = ArrayList<Float>(4096)
    private val segY1 = ArrayList<Float>(4096)
    private val segW = ArrayList<Float>(4096)

    // The panel overlay: its handle, and the screen rectangle and rotation it
    // was made for (the clip is fixed at creation: rebuilt when they change).
    private var nib = 0L
    private var nibL = 0; private var nibT = 0; private var nibR = 0; private var nibB = 0; private var nibRot = -1
    private var nibFailed = false
    private var nibDirty = false
    private val at = IntArray(2)
    private var ox = 0f
    private var oy = 0f
    private var bx = FloatArray(64)
    private var by = FloatArray(64)
    private var br = FloatArray(64)

    private val wipe = Runnable { wipeNow() }

    // A pen that lifts and lands again within JOIN_MS, within JOIN_DP, never
    // left (light pressure makes the digitiser flicker): the line goes on.
    private var pendingUp = false
    private var pendingErase = false
    private var upAt = 0L
    private val send = Runnable { sendPending() }

    /**
     * This pen's typical pressure, which counts as 0.5: the AINOTE's reports
     * about 0.1 for ordinary writing. The page learns it and tells this view
     * (setPressureTypical); until then it is learned here from each line.
     */
    var typicalP = 0f

    /**
     * The pen in hand (the page's setPen, design/99): its width curve, its
     * tone on the e-ink overlay (sixteenths of the pixels, + 256 for a
     * pencil's grain; -1 no live line), and its colour where this view draws.
     */
    private var penId = "ballpoint"
    private var strokePen = "ballpoint"
    private var tone = 0
    private var strokeTone = 0
    fun setPen(id: String, tone: Int, argb: Int) {
        penId = id
        this.tone = tone
        paint.color = argb
    }
    // The direction of travel, low-passed (a flat nib's width follows it).
    private var dirX = 1f
    private var dirY = 0f

    init {
        setBackgroundColor(Color.TRANSPARENT)
        isClickable = false
        isFocusable = false
        visibility = GONE
    }

    fun isDrawing() = drawing

    /** Is the panel's own overlay drawing the line (diagnostics). */
    fun fastNib() = nib != 0L

    /** Is this point (overlay pixels) where the page lets the pen write? */
    fun inRegion(x: Float, y: Float): Boolean {
        val r = region ?: return holes.none { x / cssPx in it.left..it.right && y / cssPx in it.top..it.bottom }
        val cx = x / cssPx
        val cy = y / cssPx
        if (holes.any { cx >= it.left && cx <= it.right && cy >= it.top && cy <= it.bottom }) return false
        return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom
    }

    /** The page's line width, in css pixels, so the live line matches it. */
    fun setWidthCss(w: Float) {
        if (w > 0f && w < 40f) widthCss = w
    }

    fun markStylus() {
        lastStylusMs = SystemClock.uptimeMillis()
    }

    /** The page has painted the last line: wipe this copy once the pen rests. */
    fun strokeDrawn() {
        removeCallbacks(wipe)
        if (!drawing) postDelayed(wipe, WIPE_MS)
    }

    /** Everything this layer shows goes, now (a finger scrolls, the page changes). */
    fun wipeNow() {
        removeCallbacks(wipe)
        if (drawing || pendingUp) return
        if (nib != 0L && nibDirty) EbcNib.clear(nib)
        nibDirty = false
        if (segW.isNotEmpty()) {
            segX0.clear(); segY0.clear(); segX1.clear(); segY1.clear(); segW.clear()
            invalidate()
        }
    }

    fun clearLive() = wipeNow()

    /** Off: the overlay is cleared and handed back (focus lost, page gone). */
    fun clearAll() {
        if (pendingUp) sendPending()
        drawing = false
        stylusId = MotionEvent.INVALID_POINTER_ID
        n = 0
        wipeNow()
        stopNib()
    }

    fun stopNib() {
        val h = nib
        nib = 0L
        nibRot = -1
        nibDirty = false
        if (h != 0L) EbcNib.destroy(h)
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (visibility != VISIBLE) stopNib()
    }

    override fun onDetachedFromWindow() {
        stopNib()
        super.onDetachedFromWindow()
    }

    override fun dispatchTouchEvent(event: MotionEvent) = false

    override fun onHoverEvent(event: MotionEvent): Boolean {
        if (isStylusTool(event.getToolType(event.actionIndex))) markStylus()
        return false
    }

    // The overlay for the writing area as it is now on screen. Checked on
    // every pen-down: the window moves without telling a view.
    @Suppress("DEPRECATION")
    private fun syncNib() {
        getLocationOnScreen(at)
        ox = at[0].toFloat()
        oy = at[1].toFloat()
        if (nibFailed || !EbcNib.loaded) return
        val r = region
        val l = at[0] + (if (r != null) max(0f, r.left * cssPx) else 0f).roundToInt()
        val t = at[1] + (if (r != null) max(0f, r.top * cssPx) else 0f).roundToInt()
        val rr = at[0] + (if (r != null) min(width.toFloat(), r.right * cssPx) else width.toFloat()).roundToInt()
        val b = at[1] + (if (r != null) min(height.toFloat(), r.bottom * cssPx) else height.toFloat()).roundToInt()
        val rot = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.rotation
        if (nib != 0L && l == nibL && t == nibT && rr == nibR && b == nibB && rot == nibRot) return
        stopNib()
        if (rr <= l || b <= t) return
        val h = try { EbcNib.create(l, t, rr, b, rot) } catch (e: Throwable) { 0L }
        if (h == 0L) { nibFailed = true; return }
        nib = h; nibL = l; nibT = t; nibR = rr; nibB = b; nibRot = rot
    }

    fun feed(event: MotionEvent): Boolean {
        val stylusIndex = indexOfStylus(event)
        if (stylusIndex >= 0) markStylus()
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                if (stylusIndex < 0 || drawing) return drawing
                val x0 = event.getX(stylusIndex)
                val y0 = event.getY(stylusIndex)
                if (pendingUp && n > 0 && event.eventTime - upAt < JOIN_MS &&
                    Math.hypot((x0 - xs[n - 1]).toDouble(), (y0 - ys[n - 1]).toDouble()) < JOIN_DP * density) {
                    removeCallbacks(send)
                    pendingUp = false
                    stylusId = event.getPointerId(stylusIndex)
                    drawing = true
                    val from = n - 1
                    add(x0, y0, event.getPressure(stylusIndex), event.eventTime)
                    draw(from, pendingErase)
                    return true
                }
                if (pendingUp) sendPending()
                if (!inRegion(x0, y0)) return false
                removeCallbacks(wipe)
                syncNib()
                stylusId = event.getPointerId(stylusIndex)
                drawing = true
                n = 0
                pSmooth = -1f
                strokePen = penId
                strokeTone = tone
                t0 = event.eventTime
                val erasing = erase || event.getToolType(stylusIndex) == MotionEvent.TOOL_TYPE_ERASER
                // The eraser's work is the page's; lines still shown here go first.
                if (erasing && nibDirty) { EbcNib.clear(nib); nibDirty = false }
                add(event.getX(stylusIndex), event.getY(stylusIndex), event.getPressure(stylusIndex), event.eventTime)
                draw(0, erasing)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!drawing) return false
                val index = event.findPointerIndex(stylusId)
                if (index < 0) return true
                val from = max(0, n - 1)
                for (h in 0 until event.historySize) {
                    add(event.getHistoricalX(index, h), event.getHistoricalY(index, h), event.getHistoricalPressure(index, h), event.getHistoricalEventTime(h))
                }
                add(event.getX(index), event.getY(index), event.getPressure(index), event.eventTime)
                draw(from, erase || event.getToolType(index) == MotionEvent.TOOL_TYPE_ERASER)
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                val upId = event.getPointerId(event.actionIndex)
                if (!drawing || (event.actionMasked != MotionEvent.ACTION_CANCEL && upId != stylusId)) {
                    return drawing
                }
                val index = event.findPointerIndex(stylusId)
                val erasing = erase || (index >= 0 && event.getToolType(index) == MotionEvent.TOOL_TYPE_ERASER)
                if (index >= 0) {
                    val from = max(0, n - 1)
                    add(event.getX(index), event.getY(index), event.getPressure(index), event.eventTime)
                    draw(from, erasing)
                }
                drawing = false
                stylusId = MotionEvent.INVALID_POINTER_ID
                if (event.actionMasked == MotionEvent.ACTION_CANCEL) { n = 0; wipeNow(); return true }
                // Held a moment: the pen landing again right here is the same line.
                pendingUp = true
                pendingErase = erasing
                upAt = event.eventTime
                removeCallbacks(send)
                postDelayed(send, JOIN_MS)
                return true
            }
        }
        return drawing
    }

    private fun sendPending() {
        removeCallbacks(send)
        if (!pendingUp) return
        pendingUp = false
        learn()
        val packed = pack()
        n = 0
        if (packed.isNotEmpty()) listener?.onStroke(packed, pendingErase, strokePen)
    }

    private fun learn() {
        if (n < 3 || strokePen == "lasso") return
        val list = ps.copyOf(n).filter { it > 0f && it != 0.5f }.sorted()
        if (list.size < 3) return
        val med = list[list.size / 2]
        typicalP = max(0.02f, if (typicalP > 0f) typicalP * 0.8f + med * 0.2f else med)
    }

    private fun indexOfStylus(event: MotionEvent): Int {
        for (i in 0 until event.pointerCount) {
            if (!isStylusTool(event.getToolType(i))) continue
            if (event.getTouchMajor(i) > 36f * density) continue
            return i
        }
        return -1
    }

    // Long strokes grow the buffers instead of being cut short.
    private fun add(x: Float, y: Float, p: Float, t: Long) {
        if (n > 0) {
            val dx = x - xs[n - 1]
            val dy = y - ys[n - 1]
            if (dx * dx + dy * dy < minDist2) { ps[n - 1] = p; return }
        }
        if (n >= xs.size) {
            if (xs.size >= 65536) return
            xs = xs.copyOf(xs.size * 2); ys = ys.copyOf(ys.size * 2)
            ps = ps.copyOf(ps.size * 2); ts = ts.copyOf(ts.size * 2); rs = rs.copyOf(rs.size * 2)
        }
        if (n > 0) {
            val dx = x - xs[n - 1]
            val dy = y - ys[n - 1]
            val len = Math.hypot(dx.toDouble(), dy.toDouble()).toFloat()
            if (len > 1e-3f) {
                if (n == 1) { dirX = dx / len; dirY = dy / len } else { dirX = dirX * 0.6f + dx / len * 0.4f; dirY = dirY * 0.6f + dy / len * 0.4f }
            }
        } else { dirX = 1f; dirY = 0f }
        xs[n] = x; ys[n] = y; ps[n] = p; ts[n] = t; rs[n] = radius(p, atan2(dirY, dirX))
        n++
    }

    // Radius in screen pixels for this pressure and direction: the pen's own
    // curve (ink-format.js PENS, factor) on a low-passed pressure.
    private fun radius(p: Float, angle: Float): Float {
        pSmooth = if (pSmooth < 0f) p else pSmooth + (p - pSmooth) * 0.35f
        val t = if (typicalP > 0f) typicalP else 0.5f
        val q = (0.5f * pSmooth / t).coerceIn(0.03f, 1f)
        if (strokePen == "lasso") return 1.4f * cssPx
        return max(0.75f, widthCss * cssPx / 2f * penFactor(strokePen, q, angle))
    }

    // Draw points [from, n) joined to the point before them: on the panel
    // overlay as one polyline and one update, or on this view.
    private fun draw(from: Int, erasing: Boolean) {
        if (erasing || n == 0 || strokeTone < 0) return
        val count = n - from
        if (count <= 0) return
        if (nib != 0L) {
            if (bx.size < count) { bx = FloatArray(count * 2); by = FloatArray(count * 2); br = FloatArray(count * 2) }
            for (k in 0 until count) {
                val i = from + k
                bx[k] = ox + xs[i]; by[k] = oy + ys[i]; br[k] = rs[i]
            }
            // A dashed line starts its dashes with the line (TONE_START).
            val t = if (from == 0 && (strokeTone and 0x200) != 0) strokeTone or 0x400 else strokeTone
            val rc = if (t == 0) EbcNib.polyline(nib, bx, by, br, count, false) else EbcNib.polylineTone(nib, bx, by, br, count, t)
            if (rc == 0) { nibDirty = true; return }
            stopNib(); nibFailed = true // a refused update: this layer draws from now on
        }
        if (count == 1 && from == 0) seg(xs[0], ys[0], xs[0], ys[0], rs[0] * 2f)
        for (i in max(1, from + 1) until n) seg(xs[i - 1], ys[i - 1], xs[i], ys[i], rs[i - 1] + rs[i])
        invalidate()
    }

    private fun seg(x0: Float, y0: Float, x1: Float, y1: Float, w: Float) {
        segX0.add(x0); segY0.add(y0); segX1.add(x1); segY1.add(y1); segW.add(w)
    }

    /** "x,y,pressure,ms …": css pixels, pressure 0–1, ms since the pen went down. */
    private fun pack(): String {
        if (n < 1) return ""
        val d = cssPx
        val out = StringBuilder(n * 20)
        for (i in 0 until n) {
            if (i > 0) out.append(' ')
            out.append(String.format(Locale.US, "%.1f,%.1f,%.2f,%d", xs[i] / d, ys[i] / d, ps[i].coerceIn(0f, 1f), ts[i] - t0))
        }
        return out.toString()
    }

    override fun onDraw(canvas: Canvas) {
        for (i in segW.indices) {
            paint.strokeWidth = segW[i]
            canvas.drawLine(segX0[i], segY0[i], segX1[i], segY1[i], paint)
        }
    }

    companion object {
        private const val DIAG = (PI / 4).toFloat()

        /** The pens' width curves: the same as ink-format.js PENS (change both). */
        fun penFactor(pen: String, q: Float, a: Float): Float = when (pen) {
            "fineliner" -> 0.9f + 0.2f * q
            "pencil" -> 0.7f + 0.5f * q
            "brush" -> 0.1f + 1.45f * q.pow(1.35f)
            "calligraphy" -> (0.16f + 0.84f * abs(sin(a - DIAG))) * (0.8f + 0.4f * q)
            "marker" -> 0.9f + 0.15f * q
            "highlighter" -> 0.42f + 0.58f * abs(cos(a))
            else -> 0.4f + 0.9f * sin(q * PI.toFloat() / 2f)
        }

        /** How long the pen rests before this copy goes and the page's shows alone. */
        const val WIPE_MS = 450L
        const val JOIN_MS = 40L
        const val JOIN_DP = 12f

        fun isStylusTool(tool: Int) =
            tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER
    }
}
