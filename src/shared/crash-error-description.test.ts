import { describe, expect, it } from 'vitest'
import { describeCrashError } from './crash-error-description'

describe('describeCrashError', () => {
  it('retains sanitized messages and the full sanitized stack alongside a fingerprint', () => {
    const error = new Error(
      [
        'Failed to render prompt: SECRET_TOKEN=first-secret',
        'Details in /Users/example/private-repo/first.ts token=second-secret',
        'Credentials alice:super-secret@example.com and /tmp/second-secret secret=third-secret'
      ].join('\n')
    )
    error.stack = [
      'Error: Failed to render prompt: SECRET_TOKEN=first-secret',
      'Details in /Users/example/private-repo/first.ts token=second-secret',
      'Credentials alice:super-secret@example.com and /tmp/second-secret secret=third-secret',
      '    at private message-shaped frame',
      '    at PrivateScreen (/Users/example/private-repo/screen.tsx:1:1)'
    ].join('\n')
    const description = describeCrashError(
      error,
      '\n    at PrivateScreen (/Users/example/private-repo/screen.tsx:1:1)'
    )

    expect(description.errorName).toBe('Error')
    expect(description.errorMessage).toContain('SECRET_TOKEN=[redacted]')
    expect(description.errorMessage).toContain('Details in [redacted-path] token=[redacted]')
    expect(description.errorMessage).toContain(
      'Credentials [redacted-credential]@example.com and [redacted-path] secret=[redacted]'
    )
    for (const privateValue of [
      'first-secret',
      '/Users/example/private-repo/first.ts',
      'second-secret',
      'alice:super-secret@',
      '/tmp/second-secret',
      'third-secret'
    ]) {
      expect(description.errorMessage).not.toContain(privateValue)
    }
    expect(description.errorFingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(description.errorStack).toContain(
      'Error: Failed to render prompt: SECRET_TOKEN=[redacted]'
    )
    expect(description.errorStack).toContain('at private message-shaped frame')
    expect(description.errorStack).toContain('at PrivateScreen ([redacted-path]')
    expect(description.componentStack).toContain('at PrivateScreen ([redacted-path]')
  })
})
