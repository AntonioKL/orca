import { describe, expect, it } from 'vitest'
import { sanitizeCrashReportString } from './crash-report-redaction'

/**
 * Why: a crash report leaves the machine. Each pattern below is the only thing standing between
 * a real secret or a real filesystem path and the report body, and neutering either of these two
 * used to leave the whole suite green.
 */

const API_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const UNC_WITH_SPACE = 'open "\\\\fileserver\\Private Share\\brennan\\creds.txt" failed'

describe('sanitizeCrashReportString', () => {
  it('redacts a bare sk- API key that no assignment keyword introduces', () => {
    const sanitized = sanitizeCrashReportString(`Request failed for API key ${API_KEY} (401)`)

    expect(sanitized).not.toContain(API_KEY)
    expect(sanitized).not.toContain('sk-ant-api03')
    expect(sanitized).toContain('[redacted-secret]')
  })

  it('redacts a quoted UNC path whose segments contain spaces', () => {
    const sanitized = sanitizeCrashReportString(UNC_WITH_SPACE)

    expect(sanitized).not.toContain('Private Share')
    expect(sanitized).not.toContain('creds.txt')
    expect(sanitized).toContain('[redacted-path]')
  })

  // Positive control: prose that resembles neither must survive, so the assertions above
  // cannot pass by redacting everything.
  it('leaves text carrying no secret and no path untouched', () => {
    const prose = 'Renderer crashed while restoring 3 tabs after a sk- prefixed heading'

    expect(sanitizeCrashReportString(prose)).toBe(prose)
  })
})

/**
 * Why: the unquoted patterns used to stop at the first space, emitting [redacted-path] with the
 * rest of the path still beside it -- a report that looks scrubbed but still carries a share name,
 * a directory chain and a filename. Each form below is pinned to go whole.
 */
const PARTIAL_LEAK_FORMS: readonly (readonly [string, string, readonly string[]])[] = [
  [
    'unquoted UNC, one space',
    'open \\\\fileserver\\Private Share\\brennan\\creds.txt failed',
    ['Private Share', 'brennan', 'creds.txt']
  ],
  [
    'unquoted UNC, two spaces',
    'open \\\\fileserver\\Very Private Share\\creds.txt failed',
    ['Very Private Share', 'creds.txt']
  ],
  [
    'unquoted drive letter',
    'load C:\\Users\\brennan\\My Documents\\creds.txt failed',
    ['Users', 'brennan', 'My Documents', 'creds.txt']
  ],
  [
    'unquoted POSIX',
    'read /Users/brennan/My Documents/creds.txt failed',
    ['brennan', 'My Documents', 'creds.txt']
  ],
  [
    'unquoted POSIX, backslash-escaped space',
    'read /Users/brennan/My\\ Documents/creds.txt failed',
    ['brennan', 'Documents', 'creds.txt']
  ],
  [
    'environment-variable root',
    'open %APPDATA%\\Orca App Data\\creds.txt failed',
    ['Orca App Data', 'creds.txt']
  ],
  [
    'POSIX path inside a stack frame',
    '    at load (/Users/brennan/My Documents/app.js:12:9)',
    ['brennan', 'My Documents', 'app.js']
  ],
  [
    'drive-letter path inside a stack frame',
    '    at load (C:\\Users\\brennan\\My Documents\\app.js:12:9)',
    ['brennan', 'My Documents', 'app.js']
  ]
]

describe('sanitizeCrashReportString path redaction is all-or-nothing', () => {
  it.each(PARTIAL_LEAK_FORMS)('redacts %s whole', (_name, input, fragments) => {
    const sanitized = sanitizeCrashReportString(input)

    expect(sanitized).toContain('[redacted-path]')
    for (const fragment of fragments) {
      expect(sanitized).not.toContain(fragment)
    }
    // The defect shape: a marker sitting next to surviving path content.
    expect(sanitized).not.toMatch(/\[redacted-path\][^\n]*[\\/]/)
  })

  // Control for the space-crossing rule specifically: it must not swallow the prose that follows a
  // path, or these pins could pass by redacting the rest of every line.
  it.each([
    [
      'plain prose',
      'read /Users/brennan/Documents/creds.txt but the disk was full',
      'but the disk was full'
    ],
    [
      'sentence break',
      'read /etc/hosts. Then it failed and/or retried',
      'Then it failed and/or retried'
    ],
    [
      'following URL',
      'read /etc/hosts then see https://example.com for help',
      'then see https://example.com for help'
    ]
  ])('keeps the prose after a redacted path (%s)', (_name, input, survives) => {
    expect(sanitizeCrashReportString(input)).toBe(`read [redacted-path] ${survives}`)
  })
})
