/**
 * Evidence returned by the two independent PTY liveness probes.
 *
 * `unverifiable` means the execution host could not answer; it is never an
 * alias for process death. The optional wire field preserves this distinction
 * while old clients continue to read the legacy scalar fields.
 */
export type PtyForegroundProcessEvidence =
  | { verdict: 'live'; processName: string }
  | { verdict: 'exited'; processName: string | null }
  | { verdict: 'unverifiable'; reason: string }

export type PtyChildProcessesEvidence =
  | { verdict: 'live' }
  | { verdict: 'exited' }
  | { verdict: 'unverifiable'; reason: string }

export type PtyProcessInspectionEvidence = {
  foreground: PtyForegroundProcessEvidence
  children: PtyChildProcessesEvidence
}

export type PtyProcessVerdict = 'live' | 'unverifiable' | 'exited'

/** Any unknown component poisons the whole answer; a partial answer is not an answer. */
export function combinePtyProcessInspectionVerdict(
  evidence: PtyProcessInspectionEvidence
): PtyProcessVerdict {
  if (
    evidence.foreground.verdict === 'unverifiable' ||
    evidence.children.verdict === 'unverifiable'
  ) {
    return 'unverifiable'
  }
  if (evidence.foreground.verdict === 'live' || evidence.children.verdict === 'live') {
    return 'live'
  }
  return 'exited'
}

export type PtyProcessInspectionWireResult = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  processEvidence: PtyProcessInspectionEvidence
}

/** Compose legacy fields without allowing an unverifiable probe to claim idle. */
export function buildPtyProcessInspectionWireResult(
  foreground: PtyForegroundProcessEvidence,
  children: PtyChildProcessesEvidence
): PtyProcessInspectionWireResult {
  return {
    foregroundProcess:
      foreground.verdict === 'live' || foreground.verdict === 'exited'
        ? foreground.processName
        : null,
    hasChildProcesses: children.verdict === 'live',
    processEvidence: { foreground, children }
  }
}

/**
 * Normalize evidence from a mixed-version peer. Malformed or absent evidence
 * never upgrades an unknown probe to an observed exit.
 */
export function readPtyProcessInspectionEvidence(result: {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  processEvidence?: PtyProcessInspectionEvidence
}): PtyProcessInspectionEvidence {
  const evidence = result.processEvidence
  if (evidence === undefined) {
    // Legacy peers only publish these two fields. Preserve compatibility for
    // ordinary readers; absence-action callers apply their stricter fence.
    return {
      foreground: classifyLegacyForegroundProcess(result.foregroundProcess),
      children: result.hasChildProcesses ? { verdict: 'live' } : { verdict: 'exited' }
    }
  }
  return {
    foreground: normalizeForegroundEvidence(evidence.foreground),
    children: normalizeChildrenEvidence(evidence.children)
  }
}

function normalizeReason(reason: unknown): string {
  return typeof reason === 'string' ? reason : 'unspecified'
}

function normalizeForegroundEvidence(
  evidence: PtyForegroundProcessEvidence | undefined
): PtyForegroundProcessEvidence {
  if (evidence?.verdict === 'live') {
    if (typeof evidence.processName === 'string' && evidence.processName.length > 0) {
      return { verdict: 'live', processName: evidence.processName }
    }
  }
  if (evidence?.verdict === 'exited') {
    const processName = evidence.processName ?? null
    if (processName === null || typeof processName === 'string') {
      return { verdict: 'exited', processName }
    }
  }
  if (evidence?.verdict === 'unverifiable') {
    return { verdict: 'unverifiable', reason: normalizeReason(evidence.reason) }
  }
  return { verdict: 'unverifiable', reason: 'malformed foreground inspection evidence' }
}

function classifyLegacyForegroundProcess(processName: string | null): PtyForegroundProcessEvidence {
  if (!processName) {
    return { verdict: 'exited', processName: null }
  }
  const basename = processName
    .trim()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
  const shells = new Set(['bash', 'cmd', 'fish', 'nu', 'powershell', 'pwsh', 'sh', 'zsh'])
  return shells.has(basename.toLowerCase())
    ? { verdict: 'exited', processName }
    : { verdict: 'live', processName }
}

function normalizeChildrenEvidence(
  evidence: PtyChildProcessesEvidence | undefined
): PtyChildProcessesEvidence {
  if (evidence?.verdict === 'live' || evidence?.verdict === 'exited') {
    return { verdict: evidence.verdict }
  }
  if (evidence?.verdict === 'unverifiable') {
    return { verdict: 'unverifiable', reason: normalizeReason(evidence.reason) }
  }
  return { verdict: 'unverifiable', reason: 'malformed child-process inspection evidence' }
}
