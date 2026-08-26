import { describe, expect, it } from 'vitest'
import { describeCrashError } from './crash-error-description'

describe('describeCrashError', () => {
  it('keeps only stack frames and never records multi-line message content', () => {
    const error = new Error(
      'Failed to render prompt:\nSECRET_TOKEN=do-not-share\n    at private message-shaped frame'
    )
    error.stack = [
      'Error: Failed to render prompt:',
      'SECRET_TOKEN=do-not-share',
      '    at private message-shaped frame',
      '    at PrivateScreen (/Users/example/private-repo/screen.tsx:1:1)'
    ].join('\n')
    const description = describeCrashError(
      error,
      '\n    at PrivateScreen (/Users/example/private-repo/screen.tsx:1:1)'
    )

    expect(description.errorName).toBe('Error')
    expect(description.errorFingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(description.errorStack).toContain('at PrivateScreen ([redacted-path]')
    expect(description.errorStack).not.toContain('SECRET_TOKEN')
    expect(description.errorStack).not.toContain('private message-shaped frame')
    expect(description.componentStack).toContain('at PrivateScreen ([redacted-path]')
  })
})
