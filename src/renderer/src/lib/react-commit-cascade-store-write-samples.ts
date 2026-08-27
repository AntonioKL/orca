/**
 * Samples the store writes made during a suspected React commit cascade.
 *
 * Why sampling writes and not the throw site: React #185 lands on whichever
 * fiber dispatched after a root-global counter tripped, so the reported
 * component is a bystander (see shared/react-update-depth-attribution.ts). The
 * writes that kept scheduling are the only frames that identify the loop.
 *
 * Cost discipline: the armed flag is the only thing the store-write path reads
 * when no cascade is suspected, capture is capped per cascade, and frames are
 * formatted at report time so a sampled write pays for nothing it may not use.
 */

/**
 * Read on every store write, so it is a plain field load on a shared object
 * rather than a cross-module call.
 */
export const reactCommitCascadeWriteProbe = { armed: false }

/** Enough frames to cross React's commit/effect frames into app code. */
const CAPTURE_STACK_FRAME_LIMIT = 8
/** A loop repeats; six samples name every distinct participant worth naming. */
const MAX_SAMPLED_WRITES = 6
/** Keeps `changedKeys` inside the 240-char detail cap without truncating mid-key. */
const MAX_REPORTED_CHANGED_KEYS = 12

type SampledWrite = { stack?: string }

let storeWrites = 0
let samples: SampledWrite[] = []
let changedKeys: Set<string> | null = null

export type ReactCommitCascadeWriteSummary = {
  storeWrites: number
  storeWriteSites: number
  driverFrame: string | undefined
  driverStack: string | undefined
  changedKeys: string | undefined
}

export function armReactCommitCascadeWriteSampling(): void {
  reactCommitCascadeWriteProbe.armed = true
}

export function resetReactCommitCascadeWriteSamples(): void {
  reactCommitCascadeWriteProbe.armed = false
  storeWrites = 0
  samples = []
  changedKeys = null
}

/**
 * Call only while armed. `boundary` is the wrapping `set` function, so V8 elides
 * our own frames and the first captured frame is the real caller. Typed as
 * `object` because zustand's `set` is an overload set, not a plain signature.
 */
export function noteReactCommitCascadeStoreWrite(boundary: object, partial: unknown): void {
  storeWrites += 1
  if (samples.length >= MAX_SAMPLED_WRITES) {
    return
  }
  // Why object-only: a functional updater's keys are unknowable without running it.
  if (partial && typeof partial === 'object') {
    changedKeys ??= new Set<string>()
    for (const key of Object.keys(partial)) {
      changedKeys.add(key)
    }
  }
  const capture = Error as ErrorConstructor & {
    captureStackTrace?: (target: object, constructorOpt?: unknown) => void
    stackTraceLimit?: number
  }
  if (typeof capture.captureStackTrace !== 'function') {
    return
  }
  const previousLimit = capture.stackTraceLimit
  const sample: SampledWrite = {}
  try {
    capture.stackTraceLimit = CAPTURE_STACK_FRAME_LIMIT
    capture.captureStackTrace(sample, boundary)
    samples.push(sample)
  } catch {
    // Best-effort crash evidence only.
  } finally {
    capture.stackTraceLimit = previousLimit
  }
}

/** `at fn (/Users/me/app/src/x.ts:1:2)` becomes `x.ts:1:2 fn`. */
function reduceFrame(frame: string): string | undefined {
  const match = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(frame)
  if (!match) {
    return undefined
  }
  const [, fn, location, line, column] = match
  // Why basename only: the redaction that strips paths is keyed on the detail
  // NAME, so a full path inside this value would ship a developer's home dir.
  const basename = location?.split(/[/\\]/).pop() ?? ''
  return fn ? `${basename}:${line}:${column} ${fn}` : `${basename}:${line}:${column}`
}

function callerFrames(): string[] {
  const frames: string[] = []
  for (const sample of samples) {
    const first = sample.stack?.split('\n').find((line) => /^\s*at\s/.test(line))
    const reduced = first ? reduceFrame(first) : undefined
    if (reduced && !frames.includes(reduced)) {
      frames.push(reduced)
    }
  }
  return frames
}

/** Formats only here, so an unreported cascade pays nothing for its samples. */
export function readReactCommitCascadeWriteSummary(): ReactCommitCascadeWriteSummary {
  const frames = callerFrames()
  const keys = changedKeys ? Array.from(changedKeys).slice(0, MAX_REPORTED_CHANGED_KEYS) : []
  return {
    storeWrites,
    storeWriteSites: frames.length,
    driverFrame: frames[0],
    driverStack: frames.length > 0 ? frames.join('\n') : undefined,
    changedKeys: keys.length > 0 ? keys.join(',') : undefined
  }
}
