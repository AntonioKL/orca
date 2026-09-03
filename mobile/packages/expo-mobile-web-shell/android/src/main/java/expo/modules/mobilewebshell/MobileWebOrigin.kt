package expo.modules.mobilewebshell

import android.net.Uri

private const val MOBILE_WEB_ORIGIN_SUFFIX = ".orca-mobile-web.invalid"
private const val MOBILE_WEB_ORIGIN_LABEL_LIMIT = 32

/**
 * Derives a per-session origin so WebView cookies/storage cannot cross hosts.
 *
 * The id's prefix *is* the host label, so it must already be a canonical hostname label: `https` is
 * a special scheme, so Chromium ASCII-lowercases the host of every URL it loads and reports back,
 * and `java.net.URI.getHost()` returns null for a label holding anything outside `[a-z0-9-]`.
 * Rejecting a non-canonical id here fails the session open loudly instead of leaving every asset
 * request to 403 behind Chromium's own error page.
 */
internal fun mobileWebOriginForSession(sessionId: String): String {
  require(
    sessionId.isNotEmpty() &&
      sessionId.length <= 128 &&
      sessionId.all { it in 'a'..'z' || it in '0'..'9' }
  ) {
    "mobile_web_session_id_invalid"
  }
  return "$MOBILE_WEB_ORIGIN_SCHEME://${sessionId.take(MOBILE_WEB_ORIGIN_LABEL_LIMIT)}$MOBILE_WEB_ORIGIN_SUFFIX"
}

internal fun mobileWebOriginUriForSession(sessionId: String): Uri = Uri.parse(mobileWebOriginForSession(sessionId))

/** Android-free host projection so JVM unit tests can check origins without android.net.Uri. */
internal fun mobileWebOriginHostForSession(sessionId: String): String =
  mobileWebOriginForSession(sessionId).substringAfter("://")

/** Hosts are case-insensitive, so a non-canonical parser must still bind to the active session. */
internal fun isMobileWebOriginHostForSession(host: String?, sessionId: String): Boolean =
  host != null && host.equals(mobileWebOriginHostForSession(sessionId), ignoreCase = true)

internal fun isMobileWebOriginForSession(url: Uri, sessionId: String): Boolean =
  url.scheme == MOBILE_WEB_ORIGIN_SCHEME &&
    isMobileWebOriginHostForSession(url.host, sessionId) &&
    url.port == -1 &&
    url.userInfo == null
