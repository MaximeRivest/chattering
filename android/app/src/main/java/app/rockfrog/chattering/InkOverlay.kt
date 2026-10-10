package app.rockfrog.chattering

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.SystemClock
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import java.util.Locale

class InkOverlay @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    fun interface Listener {
        fun onStroke(packed: String, erase: Boolean)
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
    var lastStylusMs = 0L
        private set

    private val density = resources.displayMetrics.density
    private val livePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.BLACK
        strokeWidth = 2f * density
        isDither = false
    }
    private val livePath = Path()
    private val donePaths = ArrayList<Path>(64)
    private var xs = FloatArray(1024)
    private var ys = FloatArray(1024)
    private var ps = FloatArray(1024)
    private var ts = LongArray(1024)
    private var n = 0
    private var lastX = 0f
    private var lastY = 0f
    private var drawing = false
    private var stylusId = MotionEvent.INVALID_POINTER_ID
    private val minDist2 = 2.5f * 2.5f * density * density

    init {
        setBackgroundColor(Color.TRANSPARENT)
        isClickable = false
        isFocusable = false
        visibility = GONE
    }

    fun isDrawing() = drawing

    /** Is this point (overlay pixels) where the page lets the pen write? */
    fun inRegion(x: Float, y: Float): Boolean {
        val r = region ?: return true
        val cx = x / density
        val cy = y / density
        return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom
    }

    /** The live line's width, in css pixels, to match the page's pen. */
    fun setWidthCss(w: Float) {
        if (w > 0f && w < 40f) livePaint.strokeWidth = w * density
    }

    fun markStylus() {
        lastStylusMs = SystemClock.uptimeMillis()
    }

    fun clearLive() {
        if (livePath.isEmpty && n == 0) return
        livePath.reset()
        n = 0
        invalidate()
    }

    fun clearAll() {
        drawing = false
        stylusId = MotionEvent.INVALID_POINTER_ID
        livePath.reset()
        donePaths.clear()
        n = 0
        invalidate()
    }

    override fun dispatchTouchEvent(event: MotionEvent) = false

    override fun onHoverEvent(event: MotionEvent): Boolean {
        if (isStylusTool(event.getToolType(event.actionIndex))) markStylus()
        return false
    }

    fun feed(event: MotionEvent): Boolean {
        val stylusIndex = indexOfStylus(event)
        if (stylusIndex >= 0) markStylus()
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                if (stylusIndex < 0 || drawing) return drawing
                if (!inRegion(event.getX(stylusIndex), event.getY(stylusIndex))) return false
                stylusId = event.getPointerId(stylusIndex)
                drawing = true
                val x = event.getX(stylusIndex)
                val y = event.getY(stylusIndex)
                n = 0
                livePath.reset()
                livePath.moveTo(x, y)
                lastX = x
                lastY = y
                t0 = event.eventTime
                addPoint(x, y, event.getPressure(stylusIndex), event.eventTime)
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!drawing) return false
                val index = event.findPointerIndex(stylusId)
                if (index < 0) return true
                var changed = false
                for (h in 0 until event.historySize) {
                    if (maybeAdd(event.getHistoricalX(index, h), event.getHistoricalY(index, h), event.getHistoricalPressure(index, h), event.getHistoricalEventTime(h))) changed = true
                }
                if (maybeAdd(event.getX(index), event.getY(index), event.getPressure(index), event.eventTime)) changed = true
                if (changed) invalidate()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                val upId = event.getPointerId(event.actionIndex)
                if (!drawing || (event.actionMasked != MotionEvent.ACTION_CANCEL && upId != stylusId)) {
                    return drawing
                }
                val index = event.findPointerIndex(stylusId)
                if (index >= 0) maybeAdd(event.getX(index), event.getY(index), event.getPressure(index), event.eventTime)
                val erasing = erase || (index >= 0 && event.getToolType(index) == MotionEvent.TOOL_TYPE_ERASER)
                val packed = pack()
                val keep = event.actionMasked != MotionEvent.ACTION_CANCEL && n > 0 && !erasing
                if (keep) donePaths.add(Path(livePath))
                livePath.reset()
                n = 0
                drawing = false
                stylusId = MotionEvent.INVALID_POINTER_ID
                invalidate()
                if (event.actionMasked != MotionEvent.ACTION_CANCEL && packed.isNotEmpty()) {
                    listener?.onStroke(packed, erasing)
                }
                return true
            }
        }
        return drawing
    }

    private fun indexOfStylus(event: MotionEvent): Int {
        for (i in 0 until event.pointerCount) {
            if (!isStylusTool(event.getToolType(i))) continue
            if (event.getTouchMajor(i) > 36f * density) continue
            return i
        }
        return -1
    }

    private fun maybeAdd(x: Float, y: Float, p: Float, t: Long): Boolean {
        val dx = x - lastX
        val dy = y - lastY
        if (n > 0 && dx * dx + dy * dy < minDist2) return false
        livePath.lineTo(x, y)
        addPoint(x, y, p, t)
        lastX = x
        lastY = y
        return true
    }

    private var t0 = 0L

    // Long strokes grow the buffers instead of being cut short.
    private fun addPoint(x: Float, y: Float, p: Float, t: Long) {
        if (n >= xs.size) {
            if (xs.size >= 65536) return
            xs = xs.copyOf(xs.size * 2); ys = ys.copyOf(ys.size * 2)
            ps = ps.copyOf(ps.size * 2); ts = ts.copyOf(ts.size * 2)
        }
        xs[n] = x
        ys[n] = y
        ps[n] = p
        ts[n] = t
        n++
    }

    /** "x,y,pressure,ms …": css pixels, pressure 0–1, ms since the pen went down. */
    private fun pack(): String {
        if (n < 1) return ""
        val d = density
        val out = StringBuilder(n * 20)
        for (i in 0 until n) {
            if (i > 0) out.append(' ')
            out.append(String.format(Locale.US, "%.1f,%.1f,%.2f,%d", xs[i] / d, ys[i] / d, ps[i].coerceIn(0f, 1f), ts[i] - t0))
        }
        return out.toString()
    }

    override fun onDraw(canvas: Canvas) {
        for (path in donePaths) canvas.drawPath(path, livePaint)
        if (!livePath.isEmpty) canvas.drawPath(livePath, livePaint)
    }

    companion object {
        fun isStylusTool(tool: Int) =
            tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER
    }
}
