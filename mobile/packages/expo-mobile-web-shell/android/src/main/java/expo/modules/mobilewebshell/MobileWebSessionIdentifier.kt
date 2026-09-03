package expo.modules.mobilewebshell

import java.security.SecureRandom

private const val MOBILE_WEB_IDENTIFIER_BYTE_LENGTH = 32
private const val MOBILE_WEB_IDENTIFIER_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

/**
 * Session ids become the WebView origin's host label, so they are drawn from a canonical hostname
 * alphabet: base64url's `_` makes `URI.getHost()` null and its uppercase letters do not survive
 * Chromium's host canonicalization.
 */
internal fun mobileWebRandomIdentifier(random: SecureRandom = SecureRandom()): String {
  val bytes = ByteArray(MOBILE_WEB_IDENTIFIER_BYTE_LENGTH)
  random.nextBytes(bytes)
  return encodeMobileWebIdentifierAlphabet(bytes)
}

/** RFC 4648 base32 over a lowercase alphabet, without padding. */
private fun encodeMobileWebIdentifierAlphabet(bytes: ByteArray): String {
  val encoded = StringBuilder()
  var buffer = 0
  var bufferedBits = 0
  for (byte in bytes) {
    buffer = (buffer shl 8) or (byte.toInt() and 0xff)
    bufferedBits += 8
    while (bufferedBits >= 5) {
      bufferedBits -= 5
      encoded.append(MOBILE_WEB_IDENTIFIER_ALPHABET[(buffer shr bufferedBits) and 0x1f])
    }
  }
  if (bufferedBits > 0) {
    encoded.append(MOBILE_WEB_IDENTIFIER_ALPHABET[(buffer shl (5 - bufferedBits)) and 0x1f])
  }
  return encoded.toString()
}
