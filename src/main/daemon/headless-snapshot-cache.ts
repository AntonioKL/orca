import type { SerializeAddon } from '@xterm/addon-serialize'
import type { Terminal } from '@xterm/headless'
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences'
import { buildFrameRestoreSnapshotFields } from './terminal-frame-restore-sequences'
import { collectHeadlessOscLinkRanges } from './headless-osc-link-ranges'
import { splitTerminalSnapshotAnsi } from './terminal-snapshot-ansi-buffers'
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor
} from '../../shared/terminal-serialize-absolute-cursor'
import type { TerminalModes, TerminalSnapshot } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

/**
 * Snapshot assembly for HeadlessEmulator, memoized on a mutation epoch.
 *
 * Why: attaching a viewer serializes the session's whole buffer synchronously
 * on the daemon event loop, so every reattach of a quiescent session paid to
 * re-serialize identical bytes (measured 253-281ms per session). The cache is
 * keyed on an epoch the emulator bumps on every state mutation, so a hit is
 * byte-identical by construction rather than merely fresh-enough.
 */
type CachedParts = {
  snapshotAnsi: string
  scrollbackAnsi: string
  oscLinks: TerminalOscLinkRange[]
  frameRestore: { frameRestoreAnsi?: string }
  modes: TerminalModes
}

// Why a cap: an entry is retained for the session's lifetime once the session
// goes quiescent — exactly the parked case this optimizes. A 5k-row buffer
// serializes to a few hundred KB, but a renderer may ask for 50k rows, so an
// uncapped cache would retain tens of MB per session. Oversized payloads still
// serve correctly, they just re-serialize instead of being retained.
const MAX_CACHED_SNAPSHOT_CHARS = 2_000_000

export type HeadlessSnapshotSource = {
  serializer: SerializeAddon
  terminal: Terminal
  restoredOscLinks: TerminalOscLinkRange[]
  readModes: () => TerminalModes
  cwd: string | null
  lastTitle: string | null | undefined
  partialEscapeTail: string
}

export class HeadlessSnapshotCache {
  private epoch = 0
  private retained: (CachedParts & { epoch: number; scrollbackRows: number | undefined }) | null =
    null

  /** Invalidates the cache. Every emulator state mutation must call this. */
  markMutated(): void {
    this.epoch += 1
    this.retained = null
  }

  private resolve(source: HeadlessSnapshotSource, scrollbackRows: number | undefined): CachedParts {
    const retained = this.retained
    if (retained && retained.epoch === this.epoch && retained.scrollbackRows === scrollbackRows) {
      return retained
    }
    const computed = computeCachedParts(source, scrollbackRows)
    // Why length-gated: see MAX_CACHED_SNAPSHOT_CHARS. Declining to retain
    // costs the pre-existing serialize, never correctness.
    this.retained =
      computed.snapshotAnsi.length + computed.scrollbackAnsi.length <= MAX_CACHED_SNAPSHOT_CHARS
        ? { ...computed, epoch: this.epoch, scrollbackRows }
        : null
    return computed
  }

  /** Builds a caller-owned snapshot, reusing the memoized serialize on a hit. */
  build(source: HeadlessSnapshotSource, scrollbackRows: number | undefined): TerminalSnapshot {
    const parts = this.resolve(source, scrollbackRows)
    // Why cloned: a hit hands back the retained entry, so a caller mutating
    // its snapshot would otherwise corrupt every later one.
    const modes = { ...parts.modes }
    return {
      snapshotAnsi: parts.snapshotAnsi,
      scrollbackAnsi: parts.scrollbackAnsi,
      oscLinks: parts.oscLinks.map((link) => ({ ...link })),
      rehydrateSequences: buildRehydrateSequences(modes),
      ...parts.frameRestore,
      cwd: source.cwd,
      modes,
      cols: source.terminal.cols,
      rows: source.terminal.rows,
      scrollbackLines: source.terminal.buffer.normal.length - source.terminal.rows,
      lastTitle: source.lastTitle ?? undefined,
      // Why written LAST by the restorer: the next live chunk must complete this dangling sequence, not render it literally (Bug E / #7329).
      ...(source.partialEscapeTail.length > 0
        ? { pendingEscapeTailAnsi: source.partialEscapeTail }
        : {})
    }
  }
}

function computeCachedParts(
  source: HeadlessSnapshotSource,
  scrollbackRows: number | undefined
): CachedParts {
  const modes = source.readModes()
  // Why absolute: relative cursor restore is off by a column after a wrap-pending final row; saved-cursor rides along for DECRC.
  const serializedAnsi = serializeWithAbsoluteCursor(
    source.serializer,
    source.terminal,
    { scrollback: scrollbackRows },
    readSavedCursorRegister(source.terminal)
  )
  return {
    ...splitTerminalSnapshotAnsi(serializedAnsi, modes),
    oscLinks: collectHeadlessOscLinkRanges(
      source.terminal,
      scrollbackRows,
      source.restoredOscLinks
    ),
    frameRestore: buildFrameRestoreSnapshotFields(source.serializer, source.terminal, modes),
    modes
  }
}
