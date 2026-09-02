import { describe, expect, it } from 'vitest'
import {
  CODEX_BACKFILL_RECOVERY_NOTICE,
  CODEX_BACKFILL_TIMEOUT_SIGNATURE,
  createCodexBackfillErrorDetector
} from './codex-backfill-error-detector'

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex -- terminal escape sequences contain control bytes
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g
const DETECTOR_BUFFER_MAX_CHARS = 4096

/** The pre-optimization detector, kept verbatim as the differential oracle. */
function createReferenceDetector(): { observe(chunk: string): string | null } {
  let tail = ''
  let armed = true
  return {
    observe(chunk: string): string | null {
      if (!armed) {
        return null
      }
      const normalized = (tail + chunk).replace(ANSI_ESCAPE_PATTERN, '').replace(/\r/g, '')
      tail = normalized.slice(-DETECTOR_BUFFER_MAX_CHARS)
      if (!tail.toLowerCase().includes(CODEX_BACKFILL_TIMEOUT_SIGNATURE)) {
        return null
      }
      armed = false
      return CODEX_BACKFILL_RECOVERY_NOTICE
    }
  }
}

function splitAt(text: string, offsets: readonly number[]): string[] {
  const chunks: string[] = []
  let previous = 0
  for (const offset of offsets) {
    chunks.push(text.slice(previous, offset))
    previous = offset
  }
  chunks.push(text.slice(previous))
  return chunks
}

function observeAll(
  detector: { observe(chunk: string): string | null },
  chunks: readonly string[]
): (string | null)[] {
  return chunks.map((chunk) => detector.observe(chunk))
}

function expectMatchesReference(chunks: readonly string[]): (string | null)[] {
  const actual = observeAll(createCodexBackfillErrorDetector(), chunks)
  const expected = observeAll(createReferenceDetector(), chunks)
  expect(actual).toEqual(expected)
  return actual
}

const ESC = String.fromCharCode(0x1b)

const SIGNATURE_LINE = '\u001b[31mError: timed out waiting for state DB backfill\u001b[0m\r\n'

describe('Codex backfill error detector', () => {
  it('recognizes the timeout across ANSI-decorated chunks once', () => {
    const detector = createCodexBackfillErrorDetector()

    expect(detector.observe('\u001b[31mError: timed out waiting for state DB back')).toBeNull()
    expect(detector.observe('fill\u001b[0m\r\n')).toBe(CODEX_BACKFILL_RECOVERY_NOTICE)
    expect(detector.observe('timed out waiting for state db backfill')).toBeNull()
  })

  it('does not classify the generic damaged-database message', () => {
    const detector = createCodexBackfillErrorDetector()

    expect(detector.observe('local database appears to be damaged')).toBeNull()
  })

  it('detects the signature at every chunk-boundary split, including inside escapes', () => {
    for (let offset = 0; offset <= SIGNATURE_LINE.length; offset++) {
      const results = expectMatchesReference(splitAt(SIGNATURE_LINE, [offset]))
      expect(results.some((result) => result === CODEX_BACKFILL_RECOVERY_NOTICE)).toBe(true)
    }
  })

  it('detects a signature interleaved with escape sequences at every split', () => {
    const interleaved =
      'timed \u001b[1mout \u001b[0;32mwaiting for state \u001b[Kdb \u001b[38;5;214mbackfill\u001b[0m\r\n'
    for (let offset = 0; offset <= interleaved.length; offset++) {
      const results = expectMatchesReference(splitAt(interleaved, [offset]))
      expect(results.some((result) => result === CODEX_BACKFILL_RECOVERY_NOTICE)).toBe(true)
    }
  })

  it('keeps a literal escape that never completes breaking the signature', () => {
    // The unmatched ESC stays in the normalized stream, so the halves do not join.
    expectMatchesReference(['timed out waiting for state db back\u001b', 'fill\n'])
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe('timed out waiting for state db back\u001b')).toBeNull()
    expect(detector.observe('fill\n')).toBeNull()
  })

  it('ignores a signature pushed out of the trailing normalized window by one chunk', () => {
    const chunk = `${CODEX_BACKFILL_TIMEOUT_SIGNATURE}${'x'.repeat(DETECTOR_BUFFER_MAX_CHARS)}`
    expect(createCodexBackfillErrorDetector().observe(chunk)).toBeNull()
    expect(createReferenceDetector().observe(chunk)).toBeNull()
  })

  it('still fires when the signature ends inside the trailing window', () => {
    const padding = DETECTOR_BUFFER_MAX_CHARS - CODEX_BACKFILL_TIMEOUT_SIGNATURE.length
    const chunk = `${CODEX_BACKFILL_TIMEOUT_SIGNATURE}${'x'.repeat(padding)}`
    expectMatchesReference([chunk])
    expect(createCodexBackfillErrorDetector().observe(chunk)).toBe(CODEX_BACKFILL_RECOVERY_NOTICE)
  })

  it('reads an aborted escape sequence once, the way a terminal parser does', () => {
    // Documented difference from the pre-optimization detector: that one re-stripped
    // its own retained output every chunk, so an aborted CSI prefix could fuse with a
    // byte that arrived in a LATER chunk and swallow it. Reaching this needs an escape
    // sequence aborted mid-sequence by another ESC, which no terminal renders as text.
    const aborted = `${ESC}[31${ESC}[0mtimed out waiting for state d`
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe(aborted)).toBeNull()
    expect(detector.observe('b backfill')).toBe(CODEX_BACKFILL_RECOVERY_NOTICE)

    const reference = createReferenceDetector()
    expect(reference.observe(aborted)).toBeNull()
    // The reference fuses the retained `ESC [ 3 1` with the following 't' on its next
    // pass and eats the signature's first character.
    expect(reference.observe('b backfill')).toBeNull()
  })

  it('matches the reference detector over randomized agent-like output', () => {
    const alphabet = [
      'timed out waiting for state db backfill',
      'Timed Out Waiting For State DB Backfill',
      'timed out waiting for state db back',
      'fill',
      '\u001b[0m',
      '\u001b[38;5;214m',
      '\u001b[?25l',
      '\u001b[2K',
      '\u001b]0;codex build\u0007',
      '\u001b]8;;https://example.com\u001b\\',
      '\u001b]0;unterminated',
      '\u001b',
      '',
      '\u001bM',
      '\u001b[<0;1;2M',
      '\r',
      '\r\n',
      '\n',
      'working spinner ',
      'local database appears to be damaged',
      'x'.repeat(97),
      'timed out\u001b[0m waiting for state db backfill'
    ]
    let seed = 0x2f6e2b1
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let iteration = 0; iteration < 400; iteration++) {
      let text = ''
      const pieces = 1 + Math.floor(random() * 14)
      for (let piece = 0; piece < pieces; piece++) {
        text += alphabet[Math.floor(random() * alphabet.length)] ?? ''
      }
      const offsets: number[] = []
      const splits = Math.floor(random() * 5)
      for (let split = 0; split < splits; split++) {
        offsets.push(Math.floor(random() * (text.length + 1)))
      }
      offsets.sort((a, b) => a - b)
      expectMatchesReference(splitAt(text, offsets))
    }
  })
})
