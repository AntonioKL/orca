package expo.modules.mobilewebshell

import android.net.Uri

private const val MOBILE_WEB_ORIGIN_SUFFIX = ".orca-mobile-web.invalid"

/** Derives a per-session origin so WebView cookies/storage cannot cross hosts. */
internal fun mobileWebOriginForSession(sessionId: String): String {
  require(sessionId.isNotEmpty() && sessionId.length <= 128 && sessionId.all { it.isLetterOrDigit() || it == '-' || it == '_' }) {
    "mobile_web_session_id_invalid"
  }
  return "$MOBILE_WEB_ORIGIN_SCHEME://${sessionId.take(32)}$MOBILE_WEB_ORIGIN_SUFFIX"
}

internal fun mobileWebOriginUriForSession(sessionId: String): Uri = Uri.parse(mobileWebOriginForSession(sessionId))

/** Android-free host projection so JVM unit tests can check origins without android.net.Uri. */
internal fun mobileWebOriginHostForSession(sessionId: String): String =
  mobileWebOriginForSession(sessionId).substringAfter("://")

internal fun isMobileWebOriginForSession(url: Uri, sessionId: String): Boolean =
  url.scheme == MOBILE_WEB_ORIGIN_SCHEME &&
    url.host == mobileWebOriginUriForSession(sessionId).host &&
    url.port == -1 &&
    url.userInfo == null
