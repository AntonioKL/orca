package expo.modules.mobilewebshell

import java.net.URI
import java.security.SecureRandom
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The session id's prefix is the private origin's host label. Chromium ASCII-lowercases the host of
 * every `https` URL it loads and reports back, and `java.net.URI.getHost()` is null for a label
 * holding `_`, so a base64url id silently loses the document (403) and the bridge (dropped
 * messages).
 */
class MobileWebOriginTest {
  @Test
  fun `generated session ids survive host parsing unchanged`() {
    val random = SecureRandom.getInstance("SHA1PRNG").apply { setSeed(ByteArray(16)) }

    repeat(64) {
      val sessionId = mobileWebRandomIdentifier(random)
      val host = mobileWebOriginHostForSession(sessionId)

      assertEquals(host, host.lowercase())
      assertEquals(host, URI(mobileWebOriginForSession(sessionId)).host)
      assertTrue(sessionId, isMobileWebOriginHostForSession(URI("https://$host/").host, sessionId))
      assertTrue(
        sessionId,
        isAllowedMobileWebBridgeDocumentUrl(
          "${mobileWebOriginForSession(sessionId)}/#$sessionId",
          sessionId
        )
      )
    }
  }

  @Test
  fun `rejects session ids a URL host cannot carry`() {
    val rejected = listOf(
      "47Im-Tb2rq2Y5jz235dEGMcvyQSk5p17H5UZaAPc",
      "47im-tb2_rq2y5jz235degmcvyqsk5p17h5uzaapc",
      "47im-tb2-rq2y5jz235degmcvyqsk5p17h5uzaapc",
      ""
    )

    for (sessionId in rejected) {
      assertEquals(
        sessionId,
        "mobile_web_session_id_invalid",
        runCatching { mobileWebOriginForSession(sessionId) }.exceptionOrNull()?.message
      )
    }
  }

  @Test
  fun `keeps distinct sessions on distinct origins`() {
    val sessionId = mobileWebRandomIdentifier()
    val other = mobileWebRandomIdentifier()

    assertFalse(mobileWebOriginForSession(sessionId) == mobileWebOriginForSession(other))
    assertFalse(isMobileWebOriginHostForSession(mobileWebOriginHostForSession(other), sessionId))
  }
}
