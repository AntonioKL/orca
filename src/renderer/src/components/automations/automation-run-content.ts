import type { AutomationRun } from '../../../../shared/automations-types'

export type AutomationRunNoticeTone = 'error' | 'neutral'

export type AutomationRunNotice = {
  text: string
  tone: AutomationRunNoticeTone
}

export function getAutomationRunContent(run: AutomationRun): string {
  const savedOutput = run.outputSnapshot?.content.trim()
  if (savedOutput) {
    return run.outputSnapshot?.content ?? savedOutput
  }
  if (run.precheckResult) {
    const output = [run.precheckResult.stderr.trim(), run.precheckResult.stdout.trim()]
      .filter(Boolean)
      .join('\n\n')
    if (output) {
      return output
    }
  }
  return run.usage?.unavailableMessage ?? 'No output content available.'
}

/** Why separate from the body: a passing precheck's stdout outranks `run.error` there,
 *  so the reason a run ended was invisible on exactly the runs that needed it. */
export function getAutomationRunNotice(run: AutomationRun): AutomationRunNotice | null {
  const text = run.error?.trim()
  if (!text) {
    return null
  }
  return {
    text,
    tone:
      run.status === 'dispatch_failed' && run.observationVerdict !== 'unverifiable'
        ? 'error'
        : 'neutral'
  }
}
