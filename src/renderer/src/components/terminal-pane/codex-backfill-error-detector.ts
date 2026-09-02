export const CODEX_BACKFILL_TIMEOUT_SIGNATURE = 'timed out waiting for state db backfill'

export const CODEX_BACKFILL_RECOVERY_NOTICE = [
  'Codex could not start because its session-history index is still incomplete.',
  'Keep Orca open for a few minutes, then retry this pane. Orca attempts background recovery for managed local and WSL homes.'
].join('\n')

/**
 * Width of the normalized-output window the signature must land inside. Kept
 * from the original `normalized.slice(-4096)` detector so a signature followed
 * by more than this many normalized characters in one chunk still does not fire.
 */
const DETECTOR_BUFFER_MAX_CHARS = 4096

const SIGNATURE_CODES = Uint16Array.from(CODEX_BACKFILL_TIMEOUT_SIGNATURE, (character) =>
  character.charCodeAt(0)
)

/** KMP prefix table so the streaming match needs no per-chunk buffer or backtracking. */
function buildSignatureFailureTable(codes: Uint16Array): Int32Array {
  const failure = new Int32Array(codes.length)
  let matched = 0
  for (let index = 1; index < codes.length; index++) {
    while (matched > 0 && codes[index] !== codes[matched]) {
      matched = failure[matched - 1]
    }
    if (codes[index] === codes[matched]) {
      matched += 1
    }
    failure[index] = matched
  }
  return failure
}

const SIGNATURE_FAILURE = buildSignatureFailureTable(SIGNATURE_CODES)

const STATE_TEXT = 0
const STATE_ESCAPE = 1
const STATE_CSI_PARAMS = 2
const STATE_CSI_INTERMEDIATE = 3
const STATE_OSC = 4
const STATE_OSC_ESCAPE = 5

const ESC = 0x1b
const CARRIAGE_RETURN = 0x0d
const BEL = 0x07
const LEFT_BRACKET = 0x5b
const RIGHT_BRACKET = 0x5d
const BACKSLASH = 0x5c

function isCsiParameterByte(code: number): boolean {
  // Mirrors the old [0-9;?] class exactly — ':' and '<' '=' '>' are deliberately excluded.
  return (code >= 0x30 && code <= 0x39) || code === 0x3b || code === 0x3f
}

function isCsiIntermediateByte(code: number): boolean {
  return code >= 0x20 && code <= 0x2f
}

function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e
}

export type CodexBackfillErrorDetector = { observe(chunk: string): string | null }

/**
 * Scans one Codex pane's output once for the unambiguous backfill timeout.
 *
 * Streams the chunk through an ANSI/CR state machine feeding a KMP matcher, so
 * no normalized copy of the output is ever built. Detection is identical to the
 * previous `strip -> slice(-4096) -> toLowerCase -> includes` implementation:
 * escape sequences and carriage returns are removed with the same grammar, a
 * sequence split across chunks is still recognized, an escape that never
 * completes is still emitted as literal text (and so still breaks a match), and
 * the signature must still fall inside the trailing 4096-character window.
 */
export function createCodexBackfillErrorDetector(): CodexBackfillErrorDetector {
  let armed = true
  let state: number = STATE_TEXT
  /** Escape prefix carried from earlier chunks; re-emitted verbatim if the sequence never completes. */
  let carriedEscape = ''
  /** Index in the current chunk where the pending escape prefix starts (0 when it began earlier). */
  let pendingStart = 0
  /** Characters emitted into the normalized stream so far — the stream coordinate space. */
  let emitted = 0
  let matchedLength = 0
  let lastMatchStart = -1

  const feed = (code: number): void => {
    // ASCII fold only: the signature is ASCII, and no non-ASCII character can
    // lowercase into a position that completes it (U+0130 always emits a
    // combining mark right after its 'i', and the signature does not end in 'i').
    const folded = code >= 0x41 && code <= 0x5a ? code + 0x20 : code
    while (matchedLength > 0 && SIGNATURE_CODES[matchedLength] !== folded) {
      matchedLength = SIGNATURE_FAILURE[matchedLength - 1]
    }
    if (SIGNATURE_CODES[matchedLength] === folded) {
      matchedLength += 1
    }
    emitted += 1
    if (matchedLength === SIGNATURE_CODES.length) {
      lastMatchStart = emitted - SIGNATURE_CODES.length
      matchedLength = SIGNATURE_FAILURE[matchedLength - 1]
    }
  }

  const emitRange = (source: string, start: number, end: number): void => {
    for (let index = start; index < end; index++) {
      const code = source.charCodeAt(index)
      if (code === CARRIAGE_RETURN) {
        continue
      }
      feed(code)
    }
  }

  /** An escape prefix that never became a sequence stays in the output as literal text. */
  const flushPendingEscape = (chunk: string, end: number): void => {
    if (carriedEscape.length > 0) {
      emitRange(carriedEscape, 0, carriedEscape.length)
      carriedEscape = ''
    }
    emitRange(chunk, pendingStart, end)
  }

  return {
    observe(chunk: string): string | null {
      if (!armed) {
        return null
      }
      pendingStart = 0
      for (let index = 0; index < chunk.length; index++) {
        const code = chunk.charCodeAt(index)
        // Re-dispatches the same character once when a state falls back to text.
        for (;;) {
          if (state === STATE_TEXT) {
            if (code === ESC) {
              state = STATE_ESCAPE
              pendingStart = index
            } else if (code !== CARRIAGE_RETURN) {
              feed(code)
            }
            break
          }
          if (state === STATE_ESCAPE) {
            if (code === LEFT_BRACKET) {
              state = STATE_CSI_PARAMS
              break
            }
            if (code === RIGHT_BRACKET) {
              // An OSC always matches (its terminator is optional), so nothing is re-emitted.
              carriedEscape = ''
              state = STATE_OSC
              break
            }
            flushPendingEscape(chunk, index)
            state = STATE_TEXT
            continue
          }
          if (state === STATE_CSI_PARAMS || state === STATE_CSI_INTERMEDIATE) {
            if (state === STATE_CSI_PARAMS && isCsiParameterByte(code)) {
              break
            }
            if (isCsiIntermediateByte(code)) {
              state = STATE_CSI_INTERMEDIATE
              break
            }
            if (isCsiFinalByte(code)) {
              carriedEscape = ''
              state = STATE_TEXT
              break
            }
            flushPendingEscape(chunk, index)
            state = STATE_TEXT
            continue
          }
          if (state === STATE_OSC) {
            if (code === BEL) {
              state = STATE_TEXT
            } else if (code === ESC) {
              state = STATE_OSC_ESCAPE
            }
            break
          }
          // STATE_OSC_ESCAPE
          if (code === BACKSLASH) {
            state = STATE_TEXT
            break
          }
          // The OSC match ended before this ESC, which the scanner then re-reads.
          state = STATE_ESCAPE
          pendingStart = index - 1
          continue
        }
      }
      let pendingLength = 0
      if (state === STATE_OSC) {
        // An unterminated OSC is consumed to end of input, exactly as the regex did.
        state = STATE_TEXT
      } else if (state === STATE_OSC_ESCAPE) {
        // The OSC match ends before the trailing ESC, which survives into the window.
        state = STATE_ESCAPE
        carriedEscape = '\x1b'
        pendingLength = 1
      } else if (state !== STATE_TEXT) {
        carriedEscape = `${carriedEscape}${chunk.slice(pendingStart)}`
        if (carriedEscape.length > DETECTOR_BUFFER_MAX_CHARS) {
          // A parameter run this long can never complete inside the retained
          // window; treat it as the literal text it will be scanned as.
          emitRange(carriedEscape, 0, carriedEscape.length)
          carriedEscape = ''
          state = STATE_TEXT
        } else {
          pendingLength = carriedEscape.length
        }
      }
      const normalizedLength = emitted + pendingLength
      if (lastMatchStart < 0 || lastMatchStart < normalizedLength - DETECTOR_BUFFER_MAX_CHARS) {
        return null
      }
      armed = false
      return CODEX_BACKFILL_RECOVERY_NOTICE
    }
  }
}
