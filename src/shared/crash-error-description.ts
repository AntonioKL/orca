import { sanitizeCrashReportString, type CrashReportBreadcrumbData } from './crash-reporting'

export type CrashErrorDescription = CrashReportBreadcrumbData

const MAX_STACK_CHARS = 2_000

export function describeCrashError(
  error: unknown,
  componentStack?: string | null
): CrashErrorDescription {
  const candidate = error instanceof Error ? error : null
  const message = candidate?.message ?? String(error)
  return {
    errorName: sanitizeCrashReportString(candidate?.name || 'NonErrorThrown', 80),
    errorMessage: sanitizeCrashReportString(message),
    errorFingerprint: fingerprint(message),
    ...(candidate?.stack
      ? { errorStack: sanitizeCrashReportString(candidate.stack, MAX_STACK_CHARS) }
      : {}),
    ...(componentStack?.trim()
      ? { componentStack: sanitizeCrashReportString(componentStack.trim(), MAX_STACK_CHARS) }
      : {})
  }
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
