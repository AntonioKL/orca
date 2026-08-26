import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from '../../shared/agent-process-recognition'
import {
  resolveOuterWrapperForegroundProcess,
  shouldInspectOuterWrapperForegroundProcess
} from '../../shared/foreground-wrapper-agent'
import { isShellProcess } from '../../shared/shell-process-detection'
import {
  queryWindowsProcessDescendants,
  type WindowsProcessCandidate,
  type WindowsProcessRow
} from './windows-foreground-process-rows'

export type AgentForegroundResolutionOptions = {
  contextPaths?: readonly string[]
  /** Require a Windows process-table scan started after this request. */
  fresh?: boolean
  /** Force confirmation scans even when node-pty reports a recognized name. */
  forceProcessScan?: boolean
  /** Lazily proves which global descendants still belong to this ConPTY. */
  readWindowsConsoleAttachedProcessIds?: () => Promise<ReadonlySet<number> | null>
}

export type WindowsAgentForegroundResolution = {
  available: boolean
  processName: string | null
  /**
   * Pid of the candidate row that proved the name — the liveness anchor a
   * caller may check against the pane's job. Absent when the name came from a
   * fallback or when sibling leaves left no single anchor.
   */
  processId?: number
}

type WindowsForegroundIdentity = {
  processName: string | null
  processId?: number
}

export function shouldInspectWindowsAgentForeground(fallbackProcess: string): boolean {
  const recognized = recognizeAgentProcess(fallbackProcess)
  return (
    isAgentForegroundWrapperProcess(fallbackProcess) ||
    isShellProcess(fallbackProcess) ||
    (recognized !== null && shouldInspectOuterWrapperForegroundProcess(recognized))
  )
}

export async function resolveWindowsAgentForegroundProcess(
  shellPid: number,
  fallbackProcess: string,
  options: AgentForegroundResolutionOptions
): Promise<string | null> {
  return (
    await resolveWindowsAgentForegroundProcessWithAvailability(shellPid, fallbackProcess, options)
  ).processName
}

export async function resolveWindowsAgentForegroundProcessWithAvailability(
  shellPid: number,
  fallbackProcess: string,
  options: AgentForegroundResolutionOptions
): Promise<WindowsAgentForegroundResolution> {
  const candidates = await queryWindowsProcessDescendants(
    shellPid,
    options.fresh === true ? { fresh: true } : {}
  )
  if (!candidates) {
    return { available: false, processName: null }
  }
  // Resolve membership before applying the global ambiguity rule. A detached
  // agent can otherwise make an attached Droid look ambiguous and suppress
  // the only identity that is actually able to receive this PTY's input.
  const hasRecognizedCandidate = windowsCandidatesContainRecognizedAgent(
    candidates,
    fallbackProcess,
    options.contextPaths
  )
  let filteredCandidates = candidates
  if (hasRecognizedCandidate && options.readWindowsConsoleAttachedProcessIds) {
    // Why console attachment and not the job: this filter exists to DROP a
    // descendant that detached from the console, and the job still contains
    // those by design. Answering it from the job would re-admit precisely what
    // the filter is for -- granting byte authority to a detached `Start-Process
    // droid`, or making an attached agent look ambiguous.
    const consoleProcessIds = await options.readWindowsConsoleAttachedProcessIds()
    if (!consoleProcessIds) {
      return { available: false, processName: null }
    }
    filteredCandidates = candidates.filter((candidate) => consoleProcessIds.has(candidate.pid))
  }
  return {
    available: true,
    ...resolveWindowsForegroundIdentity(filteredCandidates, fallbackProcess, options.contextPaths)
  }
}

function windowsCandidatesContainRecognizedAgent(
  candidates: readonly WindowsProcessCandidate[],
  fallbackProcess: string,
  contextPaths: readonly string[] | undefined
): boolean {
  if (isShellProcess(fallbackProcess)) {
    return createRecognizedWindowsProcessCandidates(candidates, contextPaths).length > 0
  }
  return candidates
    .filter((candidate) => windowsCandidateMatchesFallbackWrapper(candidate, fallbackProcess))
    .some(
      (candidate) =>
        recognizeAgentProcessFromCommandLine(candidate.command) !== null ||
        recognizeAgentProcessFromCommandLine(candidate.name) !== null
    )
}

function resolveWindowsForegroundIdentity(
  candidates: readonly WindowsProcessCandidate[],
  fallbackProcess: string,
  contextPaths: readonly string[] | undefined
): WindowsForegroundIdentity {
  if (isShellProcess(fallbackProcess)) {
    return resolveShellForegroundProcessFromWindowsCandidates(candidates, contextPaths)
  }
  const wrapperCandidates = candidates.filter((candidate) =>
    windowsCandidateMatchesFallbackWrapper(candidate, fallbackProcess)
  )
  if (wrapperCandidates.length !== 1) {
    return resolveWrapperForegroundProcessFromWindowsCandidates(
      wrapperCandidates,
      candidates,
      contextPaths
    )
  }
  const [candidate] = wrapperCandidates
  const recognized =
    recognizeAgentProcessFromCommandLine(candidate.command) ??
    recognizeAgentProcessFromCommandLine(candidate.name)
  if (recognized) {
    return {
      processName: resolveOuterWrapperForegroundProcess(recognized, candidate, candidates),
      processId: candidate.pid
    }
  }
  return { processName: null }
}

function resolveShellForegroundProcessFromWindowsCandidates(
  candidates: readonly WindowsProcessCandidate[],
  contextPaths: readonly string[] | undefined
): WindowsForegroundIdentity {
  const recognizedCandidates = createRecognizedWindowsProcessCandidates(candidates, contextPaths)
  const contextCandidates = recognizedCandidates.filter((candidate) => candidate.contextMatch)
  if (contextCandidates.length > 0) {
    return resolveRecognizedWindowsProcessCandidates(contextCandidates, candidates)
  }
  return resolveRecognizedWindowsProcessCandidates(recognizedCandidates, candidates)
}

function resolveWrapperForegroundProcessFromWindowsCandidates(
  candidates: readonly WindowsProcessCandidate[],
  allCandidates: readonly WindowsProcessCandidate[],
  contextPaths: readonly string[] | undefined
): WindowsForegroundIdentity {
  const contextCandidates = createRecognizedWindowsProcessCandidates(
    candidates,
    contextPaths
  ).filter((candidate) => candidate.contextMatch)
  return contextCandidates.length > 0
    ? resolveRecognizedWindowsProcessCandidates(contextCandidates, allCandidates)
    : { processName: null }
}

type RecognizedWindowsProcessCandidate = WindowsProcessRow & {
  contextMatch: boolean
  depth: number
  processName: string
  recognized: RecognizedAgentProcess
}

function createRecognizedWindowsProcessCandidates(
  candidates: readonly WindowsProcessCandidate[],
  contextPaths: readonly string[] | undefined
): RecognizedWindowsProcessCandidate[] {
  const normalizedContextPaths = normalizeContextPaths(contextPaths)
  return candidates.flatMap((candidate) => {
    const recognized = recognizeWindowsProcessCandidate(candidate)
    if (!recognized) {
      return []
    }
    return [
      {
        ...candidate,
        contextMatch: candidateMatchesContextPath(candidate, normalizedContextPaths),
        processName: recognized.processName,
        recognized
      }
    ]
  })
}

function resolveRecognizedWindowsProcessCandidates(
  recognizedCandidates: readonly RecognizedWindowsProcessCandidate[],
  allCandidates: readonly WindowsProcessCandidate[]
): WindowsForegroundIdentity {
  if (recognizedCandidates.length === 0) {
    return { processName: null }
  }
  const candidatesByPid = new Map(allCandidates.map((candidate) => [candidate.pid, candidate]))
  const leafCandidates = recognizedCandidates.filter(
    (candidate) =>
      !recognizedCandidates.some(
        (other) =>
          other.pid !== candidate.pid &&
          windowsCandidateIsAncestor(candidate, other, candidatesByPid)
      )
  )
  const leafProcessNames = new Set(
    leafCandidates.map((candidate) =>
      resolveOuterWrapperForegroundProcess(candidate.recognized, candidate, allCandidates)
    )
  )
  // Why: Windows lacks a cheap PTY foreground marker like POSIX '+'. A single
  // recognized lineage leaf is strong enough; sibling agent leaves are not.
  if (leafProcessNames.size !== 1) {
    return { processName: null }
  }
  return {
    processName: [...leafProcessNames][0],
    // The anchor is the leaf that proved the name, even when the reported name
    // is its outer wrapper. Two leaves agreeing on a name leave no single anchor.
    ...(leafCandidates.length === 1 ? { processId: leafCandidates[0].pid } : {})
  }
}

function windowsCandidateIsAncestor(
  candidate: WindowsProcessRow,
  other: WindowsProcessRow,
  candidatesByPid: ReadonlyMap<number, WindowsProcessRow>
): boolean {
  let current = candidatesByPid.get(other.ppid)
  while (current) {
    if (current.pid === candidate.pid) {
      return true
    }
    current = candidatesByPid.get(current.ppid)
  }
  return false
}

function normalizeContextPaths(contextPaths: readonly string[] | undefined): string[] {
  const normalized = new Set<string>()
  for (const contextPath of contextPaths ?? []) {
    const candidate = normalizePathForCommandMatch(contextPath)
    if (isSafeContextPath(candidate)) {
      normalized.add(candidate)
    }
  }
  return [...normalized].sort((a, b) => b.length - a.length)
}

function isSafeContextPath(contextPath: string): boolean {
  return contextPath.length >= 4 && (/^[a-z]:\//.test(contextPath) || contextPath.startsWith('//'))
}

function candidateMatchesContextPath(
  candidate: WindowsProcessRow,
  normalizedContextPaths: readonly string[]
): boolean {
  if (normalizedContextPaths.length === 0) {
    return false
  }
  const haystack = normalizePathForCommandMatch(candidate.command)
  return normalizedContextPaths.some((contextPath) =>
    commandLineContainsPath(haystack, contextPath)
  )
}

function normalizePathForCommandMatch(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLowerCase()
}

function commandLineContainsPath(haystack: string, contextPath: string): boolean {
  let index = haystack.indexOf(contextPath)
  while (index !== -1) {
    const before = index > 0 ? haystack[index - 1] : ''
    const after = haystack[index + contextPath.length] ?? ''
    const beforeOk = !before || /[\s"'(=]/.test(before)
    const afterOk = !after || after === '/' || /[\s"'),;]/.test(after)
    if (beforeOk && afterOk) {
      return true
    }
    index = haystack.indexOf(contextPath, index + 1)
  }
  return false
}

function recognizeWindowsProcessCandidate(
  candidate: WindowsProcessRow
): RecognizedAgentProcess | null {
  return (
    recognizeAgentProcessFromCommandLine(candidate.command) ??
    recognizeAgentProcessFromCommandLine(candidate.name)
  )
}

function windowsCandidateMatchesFallbackWrapper(
  candidate: WindowsProcessRow,
  fallbackProcess: string
): boolean {
  const commandToken = candidate.command.trim().split(/\s+/, 1)[0] ?? ''
  return (
    isExpectedAgentProcess(candidate.name, fallbackProcess) ||
    isExpectedAgentProcess(commandToken, fallbackProcess)
  )
}
