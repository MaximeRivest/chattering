package app.rockfrog.chattering

/**
 * The C pen nib on an e-ink panel's own overlay (cpp/ebc_nib.c, design/98).
 * Every call is safe on any device: without the library or without
 * /dev/ebc, [create] answers 0 and the app draws its line as a view.
 */
object EbcNib {
    val loaded: Boolean = try {
        System.loadLibrary("ebc_nib")
        true
    } catch (e: Throwable) {
        false
    }

    @JvmStatic external fun create(left: Int, top: Int, right: Int, bottom: Int, rotation: Int): Long
    @JvmStatic external fun polyline(handle: Long, xs: FloatArray, ys: FloatArray, rs: FloatArray, count: Int, erase: Boolean): Int
    /** tone: a share of the pixels in sixteenths (0 = all), + 256 for a pencil's grain (ebc_nib.c tone_on). */
    @JvmStatic external fun polylineTone(handle: Long, xs: FloatArray, ys: FloatArray, rs: FloatArray, count: Int, tone: Int): Int
    @JvmStatic external fun clear(handle: Long): Int
    @JvmStatic external fun destroy(handle: Long)
}
