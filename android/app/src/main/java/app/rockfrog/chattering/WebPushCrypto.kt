package app.rockfrog.chattering

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The receiving side of Web Push (RFC 8291, aes128gcm), for notifications
 * that reach the app through the relay's mailbox (anywhere/mailbox.js,
 * design/100). The computer encrypts each message to the keys made here;
 * only this app can open it.
 *
 * Plain Java crypto only (no Android classes), so the same file is tested
 * on a desktop JVM against the RFC's own example (test/android-webpush.test.js).
 */
object WebPushCrypto {
    /** The device's keys: the public point (65 bytes, uncompressed), the
     *  private scalar (32 bytes) and the auth secret (16 bytes). */
    class Keys(val publicRaw: ByteArray, val privateD: ByteArray, val auth: ByteArray)

    private val b64u = Base64.getUrlEncoder().withoutPadding()
    fun b64u(b: ByteArray): String = b64u.encodeToString(b)
    fun unb64u(s: String): ByteArray = Base64.getUrlDecoder().decode(s.trim().trimEnd('='))

    private val params: ECParameterSpec by lazy {
        val p = AlgorithmParameters.getInstance("EC")
        p.init(ECGenParameterSpec("secp256r1"))
        p.getParameterSpec(ECParameterSpec::class.java)
    }

    private fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    fun generate(): Keys {
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val kp = kpg.generateKeyPair()
        val w = (kp.public as ECPublicKey).w
        val raw = byteArrayOf(4) + fixed32(w.affineX) + fixed32(w.affineY)
        val d = fixed32((kp.private as java.security.interfaces.ECPrivateKey).s)
        val auth = ByteArray(16).also { SecureRandom().nextBytes(it) }
        return Keys(raw, d, auth)
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    private fun publicKey(raw: ByteArray): java.security.PublicKey {
        require(raw.size == 65 && raw[0] == 4.toByte()) { "not an uncompressed P-256 point" }
        val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params))
    }

    /** One aes128gcm message, opened; throws when it is not for these keys. */
    fun decrypt(body: ByteArray, keys: Keys): ByteArray {
        require(body.size > 21 + 65 + 16) { "too short" }
        val salt = body.copyOfRange(0, 16)
        val idlen = body[20].toInt() and 0xff
        val asPublic = body.copyOfRange(21, 21 + idlen)
        val ciphertext = body.copyOfRange(21 + idlen, body.size)
        val priv = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, keys.privateD), params))
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(priv)
        ka.doPhase(publicKey(asPublic), true) // refuses a point off the curve
        val secret = ka.generateSecret()
        val prkKey = hmac(keys.auth, secret)
        val ikm = hmac(prkKey, "WebPush: info\u0000".toByteArray() + keys.publicRaw + asPublic + byteArrayOf(1))
        val prk = hmac(salt, ikm)
        val cek = hmac(prk, "Content-Encoding: aes128gcm\u0000".toByteArray() + byteArrayOf(1)).copyOf(16)
        val nonce = hmac(prk, "Content-Encoding: nonce\u0000".toByteArray() + byteArrayOf(1)).copyOf(12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
        val record = cipher.doFinal(ciphertext)
        var end = record.size - 1
        while (end >= 0 && record[end] == 0.toByte()) end--
        require(end >= 0 && record[end] == 2.toByte()) { "bad padding" }
        return record.copyOfRange(0, end)
    }

    /** The mailbox id the relay derives from this app's secret (mailbox.js idOf). */
    fun mailboxId(secret: String): String {
        val h = MessageDigest.getInstance("SHA-256").digest(("chattering-mailbox/1\n" + secret).toByteArray())
        return b64u(h).substring(0, 32)
    }
}
