/*
 * ebc_nib.c — the pen's live line drawn straight onto a Rockchip e-ink
 * panel's overlay (/dev/ebc), for Chattering's handwritten notes (design/98).
 *
 * From the handwriting keyboard (~/Projects/iflytek/handwriting-ime,
 * fastink/src/main/cpp/fastink_ebc.c and research/ebc/README.md), where it
 * is the reason the pen feels fast on the AINOTE 2: an Android view goes
 * through the compositor and the panel's slow full-frame update; the overlay
 * takes a few changed pixels in one small rectangle on the fast waveform.
 *
 * Kept from there, learned the hard way:
 *   - query first: the buffer format must be Y8, the overlay buffer must
 *     sit inside the mapped range, or nothing is written;
 *   - one MotionEvent (with its history) is one polyline, one dirty
 *     rectangle, one ioctl — never one update per point;
 *   - the clip is fixed at create time: the caller rebuilds on move,
 *     resize or rotation (checked on every pen-down);
 *   - destroy clears and submits BEFORE disabling, or old ink stays on the
 *     panel until something else repaints there;
 *   - panel coordinates stay in the panel's portrait orientation: points
 *     and rectangles are turned for the display's rotation.
 * New here: a radius per point, so the live line follows pressure as the
 * page's finished line does.
 *
 * Talks only to the kernel device already on the tablet; on any device
 * without it, create() returns 0 and the app draws its line the ordinary way.
 */
#include <jni.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#define EBC_ENABLE_OVERLAY 0x7004
#define EBC_DISABLE_OVERLAY 0x7005
#define EBC_GET_OSD_BUFFER 0x7006
#define EBC_SEND_OSD_BUFFER 0x7007
#define EBC_GET_BUF_FORMAT 0x7010
#define EBC_MAP_BYTES 0x02D00000UL
#define EPD_OVERLAY 1
#define TRANSPARENT_Y8 0xf0
#define BLACK_Y8 0x00

struct ebc_buf_info {
    int32_t offset, epd_mode, height, width, panel_color;
    int32_t win_x1, win_y1, win_x2, win_y2;
    int32_t width_mm, height_mm;
    int32_t extension[6];
};

struct nib {
    int fd;
    uint8_t *mapping;
    uint8_t *pixels;
    int width, height;
    int left, top, right, bottom;
    int rotation;
    float dash; /* panel pixels travelled by a dashed line so far */
};

struct dirty { int left, top, right, bottom, valid; };

static void to_panel(const struct nib *n, float x, float y, float *px, float *py) {
    switch (n->rotation) {
        case 1: *px = n->width - y; *py = x; break;
        case 2: *px = n->width - x; *py = n->height - y; break;
        case 3: *px = y; *py = n->height - x; break;
        default: *px = x; *py = y; break;
    }
}

static int submit(struct nib *n, int left, int top, int right, int bottom) {
    if (left < n->left) left = n->left;
    if (top < n->top) top = n->top;
    if (right > n->right) right = n->right;
    if (bottom > n->bottom) bottom = n->bottom;
    if (left >= right || top >= bottom) return 0;
    struct ebc_buf_info u;
    memset(&u, 0, sizeof(u));
    u.epd_mode = EPD_OVERLAY;
    u.win_x1 = left; u.win_y1 = top; u.win_x2 = right; u.win_y2 = bottom;
    __sync_synchronize();
    if (ioctl(n->fd, EBC_SEND_OSD_BUFFER, &u) != 0) return -errno;
    return 0;
}

static void clear_memory(struct nib *n) {
    for (int y = n->top; y < n->bottom; y++)
        memset(n->pixels + (size_t)y * n->width + n->left, TRANSPARENT_Y8, (size_t)(n->right - n->left));
}

/* A pen's tone on a panel that shows black or nothing while the pen moves:
 * a share of the pixels, in sixteenths. 0 (or 16): all of them. An even
 * 4x4 screen (Bayer) for a grey or a highlighter; with TONE_GRAIN a fixed
 * random speckle, a pencil's grain. The mask is the panel's pixel, so a
 * line drawn over itself stays the same and never fills in. */
#define TONE_GRAIN 0x100
/* A dashed line (the lasso's loop): DASH_ON panel pixels drawn, then a gap,
 * counted along the whole line across calls; TONE_START begins a new line. */
#define TONE_DASH 0x200
#define TONE_START 0x400
#define DASH_ON 14.0f
#define DASH_PERIOD 24.0f
static const uint8_t BAYER[16] = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 };
static int tone_on(int tone, int x, int y) {
    int density = tone & 0xff;
    if (density <= 0 || density >= 16) return 1;
    if (tone & TONE_GRAIN) {
        uint32_t h = (uint32_t)x * 374761393u + (uint32_t)y * 668265263u;
        h = (h ^ (h >> 13)) * 1274126177u;
        return (int)((h >> 24) & 15) < density;
    }
    return BAYER[(y & 3) * 4 + (x & 3)] < density;
}

static void disc_tone(struct nib *n, int cx, int cy, float r, uint8_t value, int tone) {
    int ri = (int)ceilf(r);
    int y0 = cy - ri, y1 = cy + ri;
    if (y0 < n->top) y0 = n->top;
    if (y1 >= n->bottom) y1 = n->bottom - 1;
    float r2 = r * r;
    for (int y = y0; y <= y1; y++) {
        float dy = (float)(y - cy);
        float h = r2 - dy * dy;
        if (h < 0) continue;
        int span = (int)sqrtf(h);
        int x0 = cx - span, x1 = cx + span;
        if (x0 < n->left) x0 = n->left;
        if (x1 >= n->right) x1 = n->right - 1;
        uint8_t *row = n->pixels + (size_t)y * n->width;
        for (int x = x0; x <= x1; x++) if (tone_on(tone, x, y)) row[x] = value;
    }
}

static void disc(struct nib *n, int cx, int cy, float r, uint8_t value) {
    int ri = (int)ceilf(r);
    int y0 = cy - ri, y1 = cy + ri;
    if (y0 < n->top) y0 = n->top;
    if (y1 >= n->bottom) y1 = n->bottom - 1;
    float r2 = r * r;
    for (int y = y0; y <= y1; y++) {
        float dy = (float)(y - cy);
        float h = r2 - dy * dy;
        if (h < 0) continue;
        int span = (int)sqrtf(h);
        int x0 = cx - span, x1 = cx + span;
        if (x0 < n->left) x0 = n->left;
        if (x1 >= n->right) x1 = n->right - 1;
        if (x0 <= x1) memset(n->pixels + (size_t)y * n->width + x0, value, (size_t)(x1 - x0 + 1));
    }
}

static void grow(struct dirty *d, int l, int t, int r, int b) {
    if (!d->valid) { d->left = l; d->top = t; d->right = r; d->bottom = b; d->valid = 1; return; }
    if (l < d->left) d->left = l;
    if (t < d->top) d->top = t;
    if (r > d->right) d->right = r;
    if (b > d->bottom) d->bottom = b;
}

/* Discs along the segment, one per panel pixel of travel, the radius
 * going from ra to rb. */
static void segment(struct nib *n, float x1, float y1, float ra, float x2, float y2, float rb, uint8_t value, int tone, struct dirty *d) {
    float ax, ay, bx, by;
    to_panel(n, x1, y1, &ax, &ay);
    to_panel(n, x2, y2, &bx, &by);
    float len = hypotf(bx - ax, by - ay);
    int steps = (int)ceilf(len);
    if (steps < 1) steps = 1;
    for (int i = 0; i <= steps; i++) {
        float t = (float)i / (float)steps;
        if ((tone & TONE_DASH) && fmodf(n->dash + len * t, DASH_PERIOD) >= DASH_ON) continue;
        int cx = (int)lroundf(ax + (bx - ax) * t), cy = (int)lroundf(ay + (by - ay) * t);
        float r = ra + (rb - ra) * t;
        if ((tone & 0xff) > 0 && (tone & 0xff) < 16) disc_tone(n, cx, cy, r, value, tone);
        else disc(n, cx, cy, r, value);
    }
    if (tone & TONE_DASH) n->dash += len;
    float r = ra > rb ? ra : rb;
    int pad = (int)ceilf(r) + 2;
    grow(d, (int)floorf(fminf(ax, bx)) - pad, (int)floorf(fminf(ay, by)) - pad,
         (int)ceilf(fmaxf(ax, bx)) + pad, (int)ceilf(fmaxf(ay, by)) + pad);
}

JNIEXPORT jlong JNICALL
Java_app_rockfrog_chattering_EbcNib_create(JNIEnv *env, jclass clazz, jint left, jint top, jint right, jint bottom, jint rotation) {
    (void)env; (void)clazz;
    struct nib *n = calloc(1, sizeof(*n));
    if (!n) return 0;
    n->fd = -1;
    n->mapping = MAP_FAILED;
    n->fd = open("/dev/ebc", O_RDWR | O_CLOEXEC);
    if (n->fd < 0) goto fail;
    int32_t format = -1;
    struct ebc_buf_info osd;
    memset(&osd, 0, sizeof(osd));
    if (ioctl(n->fd, EBC_GET_BUF_FORMAT, &format) != 0 || format != 1) goto fail;
    if (ioctl(n->fd, EBC_GET_OSD_BUFFER, &osd) != 0) goto fail;
    if (osd.width <= 0 || osd.height <= 0 || osd.offset < 0) goto fail;
    uint64_t end = (uint64_t)(uint32_t)osd.offset + (uint64_t)(uint32_t)osd.width * (uint32_t)osd.height;
    if (end > EBC_MAP_BYTES) goto fail;
    n->mapping = mmap(NULL, EBC_MAP_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, n->fd, 0);
    if (n->mapping == MAP_FAILED) goto fail;
    n->pixels = n->mapping + osd.offset;
    n->width = osd.width;
    n->height = osd.height;
    n->rotation = rotation;
    float cx[4], cy[4];
    to_panel(n, left, top, &cx[0], &cy[0]);
    to_panel(n, right, top, &cx[1], &cy[1]);
    to_panel(n, left, bottom, &cx[2], &cy[2]);
    to_panel(n, right, bottom, &cx[3], &cy[3]);
    float minx = cx[0], maxx = cx[0], miny = cy[0], maxy = cy[0];
    for (int i = 1; i < 4; i++) {
        if (cx[i] < minx) minx = cx[i];
        if (cx[i] > maxx) maxx = cx[i];
        if (cy[i] < miny) miny = cy[i];
        if (cy[i] > maxy) maxy = cy[i];
    }
    n->left = (int)floorf(minx); n->top = (int)floorf(miny);
    n->right = (int)ceilf(maxx); n->bottom = (int)ceilf(maxy);
    if (n->left < 0) n->left = 0;
    if (n->top < 0) n->top = 0;
    if (n->right > n->width) n->right = n->width;
    if (n->bottom > n->height) n->bottom = n->height;
    if (n->left >= n->right || n->top >= n->bottom) goto fail;
    clear_memory(n);
    if (ioctl(n->fd, EBC_ENABLE_OVERLAY, NULL) != 0) goto fail;
    return (jlong)(uintptr_t)n;
fail:
    if (n->mapping != MAP_FAILED) munmap(n->mapping, EBC_MAP_BYTES);
    if (n->fd >= 0) close(n->fd);
    free(n);
    return 0;
}

/* One MotionEvent's points (screen pixels) and radii: one rectangle, one ioctl. */
static jint polyline(JNIEnv *env, jlong handle, jfloatArray xs, jfloatArray ys, jfloatArray rs, jint count, jboolean erase, jint tone) {
    struct nib *n = (struct nib *)(uintptr_t)handle;
    if (!n || !xs || !ys || !rs || count < 1) return -EINVAL;
    if ((*env)->GetArrayLength(env, xs) < count || (*env)->GetArrayLength(env, ys) < count || (*env)->GetArrayLength(env, rs) < count) return -EINVAL;
    jfloat *px = (*env)->GetPrimitiveArrayCritical(env, xs, NULL);
    jfloat *py = (*env)->GetPrimitiveArrayCritical(env, ys, NULL);
    jfloat *pr = (*env)->GetPrimitiveArrayCritical(env, rs, NULL);
    int result = -ENOMEM;
    if (px && py && pr) {
        uint8_t value = erase ? TRANSPARENT_Y8 : BLACK_Y8;
        if (erase) tone = 0;
        if (tone & TONE_START) n->dash = 0;
        struct dirty d = {0, 0, 0, 0, 0};
        if (count == 1) segment(n, px[0], py[0], pr[0], px[0], py[0], pr[0], value, tone, &d);
        for (jint i = 1; i < count; i++) segment(n, px[i - 1], py[i - 1], pr[i - 1], px[i], py[i], pr[i], value, tone, &d);
        result = d.valid ? submit(n, d.left, d.top, d.right, d.bottom) : 0;
    }
    if (pr) (*env)->ReleasePrimitiveArrayCritical(env, rs, pr, JNI_ABORT);
    if (py) (*env)->ReleasePrimitiveArrayCritical(env, ys, py, JNI_ABORT);
    if (px) (*env)->ReleasePrimitiveArrayCritical(env, xs, px, JNI_ABORT);
    return result;
}

JNIEXPORT jint JNICALL
Java_app_rockfrog_chattering_EbcNib_polyline(JNIEnv *env, jclass clazz, jlong handle, jfloatArray xs, jfloatArray ys, jfloatArray rs, jint count, jboolean erase) {
    (void)clazz;
    return polyline(env, handle, xs, ys, rs, count, erase, 0);
}

/* The same, in a pen's tone (tone_on): a grey, a pencil, a highlighter. */
JNIEXPORT jint JNICALL
Java_app_rockfrog_chattering_EbcNib_polylineTone(JNIEnv *env, jclass clazz, jlong handle, jfloatArray xs, jfloatArray ys, jfloatArray rs, jint count, jint tone) {
    (void)clazz;
    return polyline(env, handle, xs, ys, rs, count, JNI_FALSE, tone);
}

JNIEXPORT jint JNICALL
Java_app_rockfrog_chattering_EbcNib_clear(JNIEnv *env, jclass clazz, jlong handle) {
    (void)env; (void)clazz;
    struct nib *n = (struct nib *)(uintptr_t)handle;
    if (!n) return -EINVAL;
    clear_memory(n);
    return submit(n, n->left, n->top, n->right, n->bottom);
}

JNIEXPORT void JNICALL
Java_app_rockfrog_chattering_EbcNib_destroy(JNIEnv *env, jclass clazz, jlong handle) {
    (void)env; (void)clazz;
    struct nib *n = (struct nib *)(uintptr_t)handle;
    if (!n) return;
    clear_memory(n);
    submit(n, n->left, n->top, n->right, n->bottom);
    ioctl(n->fd, EBC_DISABLE_OVERLAY, NULL);
    munmap(n->mapping, EBC_MAP_BYTES);
    close(n->fd);
    free(n);
}
