import { sanitizeCrashReportString, type CrashReportBreadcrumbData } from './crash-reporting'

export type CrashErrorDescription = CrashReportBreadcrumbData

const MAX_STACK_CHARS = 2_000

export function describeCrashError(
  error: unknown,
  componentStack?: string | null
): CrashErrorDescription {
  const candidate = error instanceof Error ? error : null
  const message = candidate?.message ?? String(error)
  const stack = extractStackFrames(candidate?.stack, message)
  return {
    errorName: sanitizeCrashReportString(candidate?.name || 'NonErrorThrown', 80),
    errorFingerprint: fingerprint(message),
    ...(stack ? { errorStack: sanitizeCrashReportString(stack, MAX_STACK_CHARS) } : {}),
    ...(componentStack?.trim()
      ? { componentStack: sanitizeCrashReportString(componentStack.trim(), MAX_STACK_CHARS) }
      : {})
  }
}

function extractStackFrames(stack: string | undefined, message: string): string | undefined {
  const messageLineCount = message.split(/\r?\n/).length
  const lines = (stack?.split(/\r?\n/) ?? []).slice(messageLineCount)
  const firstFrameIndex = lines.findIndex((line) => /^\s+at\b/.test(line))
  if (firstFrameIndex === -1) {
    return undefined
  }
  return lines.slice(firstFrameIndex).join('\n').trim() || undefined
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
