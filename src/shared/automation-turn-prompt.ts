const AUTOMATION_TURN_PREFIX = '<!-- ORCA_AUTOMATION_RUN_ID:'
const AUTOMATION_TURN_SUFFIX = ' -->'

/** Adds authority-generated turn identity without changing the user's task body. */
export function buildAutomationTurnPrompt(prompt: string, runId: string): string {
  return `${AUTOMATION_TURN_PREFIX}${runId}${AUTOMATION_TURN_SUFFIX}\n${prompt}`
}

export function isAutomationTurnPrompt(prompt: string, runId?: string): boolean {
  if (!prompt.startsWith(AUTOMATION_TURN_PREFIX)) {
    return false
  }
  const markerEnd = prompt.indexOf(AUTOMATION_TURN_SUFFIX, AUTOMATION_TURN_PREFIX.length)
  const delimiter = prompt[markerEnd + AUTOMATION_TURN_SUFFIX.length]
  if (markerEnd <= AUTOMATION_TURN_PREFIX.length || (delimiter !== '\n' && delimiter !== ' ')) {
    return false
  }
  const markerRunId = prompt.slice(AUTOMATION_TURN_PREFIX.length, markerEnd)
  return runId === undefined || markerRunId === runId
}
