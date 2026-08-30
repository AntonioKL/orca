import type {
  CrashReportBreadcrumb,
  CrashReportBreadcrumbInput,
  CrashReportDetailValue
} from './crash-reporting'

const MAX_STRING_DETAIL_LENGTH = 240
const MAX_STACK_DETAIL_LENGTH = 4_000
const MAX_BREADCRUMB_NAME_LENGTH = 80
const MAX_BREADCRUMBS = 30

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
]
const CREDENTIAL_URL_PATTERN = /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@(?=[^/\s]+)/g
const SECRET_ASSIGNMENT_PATTERN =
  /\b(token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|secret|password|account[_-]?key)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&\s,;]+)/gi

// Characters that end an unquoted path token.
const PATH_STOP = '\\s"\'`<>)'

// Quoted paths keep their spaces. An unquoted path crosses a space only to reach a run that
// continues it -- one carrying a separator but not starting one, so a second path stays separate --
// which keeps emitting the marker and removing the path a single operation rather than two.
// Sentence punctuation and ':' (URL schemes, line:col) end the crossing, so prose after a path survives.
const unquotedPathTail = (separator: string): string =>
  `(?:[^${PATH_STOP}]|(?<![.,;:!?])[ \\t](?=(?:[^${PATH_STOP}:]*[ \\t])*?[^${PATH_STOP}:${separator}][^${PATH_STOP}:]*${separator}))*`
const POSIX_TAIL = unquotedPathTail('/')
const WINDOWS_TAIL = unquotedPathTail('\\\\')

const PATH_PATTERNS = [
  /(["'`])\/[A-Za-z0-9._-]+\/(?:(?!\1)[^<>\n\r])+\1/g,
  /(["'`])[A-Za-z]:\\(?:(?!\1)[^<>\n\r])+\1/gi,
  /(["'`])\\\\[^\\\s"'`<>\n\r)]+\\(?:(?!\1)[^<>\n\r])+\1/gi,
  new RegExp(`(?<![A-Za-z0-9./])/[A-Za-z0-9._-]+/${POSIX_TAIL}`, 'g'),
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:\\\\${WINDOWS_TAIL}`, 'gi'),
  new RegExp(`\\\\\\\\[^\\\\${PATH_STOP}]+\\\\${WINDOWS_TAIL}`, 'gi'),
  new RegExp(`%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)%${WINDOWS_TAIL}`, 'gi')
]

export function sanitizeCrashReportString(
  value: string,
  maxLength = MAX_STRING_DETAIL_LENGTH
): string {
  let sanitized = value
  for (const pattern of PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted-path]')
  }
  sanitized = sanitized.replace(CREDENTIAL_URL_PATTERN, '[redacted-credential]@')
  sanitized = sanitized.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => {
    return `${key}=[redacted]`
  })
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted-secret]')
  }
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}...` : sanitized
}

export function sanitizeCrashReportDetails(
  details: Record<string, unknown>
): Record<string, CrashReportDetailValue> {
  const sanitized: Record<string, CrashReportDetailValue> = {}
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      if (/(?:^|_)path$/i.test(normalizedKey)) {
        sanitized[key] = '[redacted-path]'
      } else {
        const maxLength =
          /(?:^|_)(?:stack|component_stack|error_stack|minidump_check_message)$/i.test(
            normalizedKey
          )
            ? MAX_STACK_DETAIL_LENGTH
            : MAX_STRING_DETAIL_LENGTH
        sanitized[key] = sanitizeCrashReportString(value, maxLength)
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value
    } else if (typeof value === 'boolean' || value === null) {
      sanitized[key] = value
    }
  }
  return sanitized
}

export function sanitizeCrashReportBreadcrumbs(
  breadcrumbs: CrashReportBreadcrumbInput[] | undefined
): CrashReportBreadcrumb[] | undefined {
  if (!breadcrumbs || breadcrumbs.length === 0) {
    return undefined
  }

  const sanitized = breadcrumbs
    .slice(-MAX_BREADCRUMBS)
    .map((breadcrumb): CrashReportBreadcrumb | null => {
      if (!breadcrumb.name.trim() || !breadcrumb.createdAt.trim()) {
        return null
      }
      const data = breadcrumb.data ? sanitizeCrashReportDetails(breadcrumb.data) : {}
      const origin = breadcrumb.origin
        ? sanitizeCrashReportString(breadcrumb.origin).slice(0, 80)
        : ''
      return {
        createdAt: sanitizeCrashReportString(breadcrumb.createdAt),
        name: sanitizeCrashReportString(breadcrumb.name).slice(0, MAX_BREADCRUMB_NAME_LENGTH),
        ...(Object.keys(data).length > 0 ? { data } : {}),
        ...(origin ? { origin } : {})
      }
    })
    .filter((breadcrumb): breadcrumb is CrashReportBreadcrumb => breadcrumb !== null)

  return sanitized.length > 0 ? sanitized : undefined
}
