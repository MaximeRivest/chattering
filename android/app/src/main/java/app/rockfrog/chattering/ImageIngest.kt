package app.rockfrog.chattering

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.WebView
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Turns any picture Android can read (JPEG, PNG, WebP, HEIC, GIF first
 * frame) into a small upright JPEG the page can attach.
 *
 * The page's own decoder cannot do this job on a phone: a 50-megapixel
 * photo unpacks to ~200 MB inside the WebView, and HEIC does not decode
 * there at all. Decoding here reads the file at a sampled size, so the
 * peak is a few tens of MB whatever the camera produced.
 */
object ImageIngest {
    /** Longest edge of the JPEG handed to the page. Text in a phone
     *  screenshot (1080×2400) must stay legible, so this matches the
     *  desktop composer rather than the 960 px the phone used before. */
    const val MAX_EDGE = 1600
    const val JPEG_QUALITY = 82

    fun toJpeg(context: Context, uri: Uri, maxEdge: Int = MAX_EDGE): ByteArray? {
        val bitmap = decodeSampled(context, uri, maxEdge) ?: return null
        return try {
            val scaled = fitWithin(bitmap, maxEdge)
            try {
                val out = ByteArrayOutputStream()
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) return null
                out.toByteArray()
            } finally {
                if (scaled !== bitmap) scaled.recycle()
            }
        } finally {
            bitmap.recycle()
        }
    }

    /** The picker's display name for a content URI, or null. */
    fun displayName(context: Context, uri: Uri): String? {
        return try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (_: Exception) { null } ?: uri.lastPathSegment
    }

    /** Hands a JPEG to the page's composer; runs on the WebView's thread. */
    fun inject(web: WebView, jpeg: ByteArray, name: String) {
        val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
        val quotedName = JSONObject.quote(name)
        PageCall.run(web, "w.chatteringAcceptImage&&w.chatteringAcceptImage('image/jpeg','$b64',$quotedName)")
    }

    // Decodes at the largest power-of-two sample that keeps the longest
    // edge at or above maxEdge; fitWithin() then does the exact resize.
    private fun decodeSampled(context: Context, uri: Uri, maxEdge: Int): Bitmap? {
        val resolver = context.contentResolver
        if (Build.VERSION.SDK_INT >= 28) {
            return try {
                // ImageDecoder applies EXIF orientation itself and reads
                // HEIC on devices that have the codec (Samsung does).
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                    decoder.setTargetSampleSize(sampleFor(info.size.width, info.size.height, maxEdge))
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    decoder.isMutableRequired = false
                }
            } catch (_: Exception) { null }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        try { resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } } catch (_: Exception) { return null }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleFor(bounds.outWidth, bounds.outHeight, maxEdge) }
        val raw = try { resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } } catch (_: Exception) { null }
            ?: return null
        return applyExif(context, uri, raw)
    }

    private fun sampleFor(width: Int, height: Int, maxEdge: Int): Int {
        var sample = 1
        while (width / (sample * 2) >= maxEdge && height / (sample * 2) >= maxEdge) sample *= 2
        return sample
    }

    private fun fitWithin(bitmap: Bitmap, maxEdge: Int): Bitmap {
        val w = bitmap.width; val h = bitmap.height
        if (w <= maxEdge && h <= maxEdge) return bitmap
        val s = maxEdge.toFloat() / maxOf(w, h)
        return Bitmap.createScaledBitmap(bitmap, maxOf(1, Math.round(w * s)), maxOf(1, Math.round(h * s)), true)
    }

    // Pre-28 path: BitmapFactory ignores orientation, so a portrait photo
    // would otherwise arrive on its side.
    private fun applyExif(context: Context, uri: Uri, bitmap: Bitmap): Bitmap {
        val orientation = try {
            context.contentResolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.preScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.preScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.preScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.preScale(-1f, 1f) }
            else -> return bitmap
        }
        val turned = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
        if (turned !== bitmap) bitmap.recycle()
        return turned
    }
}
