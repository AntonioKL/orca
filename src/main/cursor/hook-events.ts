// Subscribe only to Cursor hooks needed for spinner and turn detection.
// Exclude process-boundary session hooks, which can reset the submitted-turn prompt cache.
export const CURSOR_EVENTS = [
  'beforeSubmitPrompt',
  'stop',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'beforeMCPExecution',
  'afterAgentResponse'
] as const

export type CursorEvent = (typeof CURSOR_EVENTS)[number]

export const CURSOR_PERMISSION_EVENTS = new Set<CursorEvent>([
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution'
])

export const CURSOR_PERMISSION_ALLOW_RESPONSE = '{"permission":"allow"}'
export const CURSOR_NEUTRAL_RESPONSE = '{}'

export function getCursorHookResponse(eventName: CursorEvent): string {
  return CURSOR_PERMISSION_EVENTS.has(eventName)
    ? CURSOR_PERMISSION_ALLOW_RESPONSE
    : CURSOR_NEUTRAL_RESPONSE
}
