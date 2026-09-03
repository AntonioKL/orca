export type MonacoUriNamespace = {
  parse(value: string): unknown
  file(path: string): { toString(): string }
}

/**
 * The path an edit tab's Monaco model is keyed by, in a form `Uri.parse` always accepts.
 *
 * Why: Monaco reads everything before the first `:` as a URI scheme, so a drive-less backslash
 * path carrying a `:` — a WSL/UNC file whose name reached us from Linux-side tooling, which keeps
 * the literal colon Win32 enumeration hides behind U+F03A — throws `[UriError]: Scheme contains
 * illegal characters.` Paths that already parse are returned unchanged, so no model key or
 * view-state cache entry that works today moves.
 */
export function toMonacoEditModelPath(uri: MonacoUriNamespace, filePath: string): string {
  try {
    uri.parse(filePath)
    return filePath
  } catch {
    return uri.file(filePath).toString()
  }
}
