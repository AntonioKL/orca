// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { TerminalQuickCommandDialog } from './TerminalQuickCommandDialog'

const mountedRoots: Root[] = []

async function renderDialog(
  command: TerminalQuickCommand,
  props: {
    defaultAdvancedOpen?: boolean
    onOpenChange?: ReturnType<typeof vi.fn<(open: boolean) => void>>
    onSave?: ReturnType<typeof vi.fn<(command: TerminalQuickCommand) => void>>
  } = {}
): Promise<{
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>
  onSave: ReturnType<typeof vi.fn<(command: TerminalQuickCommand) => void>>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  const onOpenChange = props.onOpenChange ?? vi.fn<(open: boolean) => void>()
  const onSave = props.onSave ?? vi.fn<(command: TerminalQuickCommand) => void>()

  await act(async () => {
    root.render(
      <TerminalQuickCommandDialog
        open={true}
        mode="add"
        command={command}
        repos={[]}
        defaultAdvancedOpen={props.defaultAdvancedOpen}
        onOpenChange={onOpenChange}
        onSave={onSave}
      />
    )
  })
  return { onOpenChange, onSave }
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click())
}

async function replaceTextareaValue(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    valueSetter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function findAnimatedRowContaining(text: string): HTMLElement {
  const row = Array.from(document.body.querySelectorAll<HTMLElement>('[aria-hidden]')).find(
    (element) => element.textContent?.includes(text)
  )
  if (!row) {
    throw new Error(`Could not find animated row containing ${text}`)
  }
  return row
}

describe('TerminalQuickCommandDialog animation structure', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('selects all text in editable fields with Cmd+A', async () => {
    await renderDialog({
      id: 'qc-select-all',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev',
      appendEnter: true,
      scope: { type: 'global' }
    })

    const fields = [
      document.body.querySelector<HTMLInputElement>('input'),
      document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Command"]')
    ]

    for (const field of fields) {
      expect(field).not.toBeNull()
      if (!field) {
        continue
      }
      field.setSelectionRange(field.value.length, field.value.length)
      await act(async () => {
        field.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            code: 'KeyA',
            metaKey: true,
            bubbles: true,
            cancelable: true
          })
        )
      })

      expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length])
    }
  })

  it('keeps agent-only fields mounted as collapsed animated rows in terminal mode', async () => {
    await renderDialog({
      id: 'qc-1',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev',
      appendEnter: true,
      scope: { type: 'global' }
    })

    const agentRow = findAnimatedRowContaining('Agent')

    expect(agentRow.getAttribute('aria-hidden')).toBe('true')
    expect(agentRow.className).toContain('transition-[grid-template-rows]')
    expect(agentRow.className).toContain('grid-rows-[0fr]')
  })

  it('shows append enter in the editor footer for terminal commands', async () => {
    await renderDialog({
      id: 'qc-2',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev',
      appendEnter: true,
      scope: { type: 'global' }
    })

    expect(document.body.textContent).toContain('Append Enter — run immediately')
    expect(document.body.textContent).not.toContain('Supports /goal, skills, paths')
  })

  it('keeps the command editable and saves insertion-only mode after toggling Enter off', async () => {
    const { onOpenChange, onSave } = await renderDialog({
      id: 'qc-editable',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev',
      appendEnter: true,
      scope: { type: 'global' }
    })
    const appendEnterSwitch = document.body.querySelector<HTMLElement>(
      '[aria-label="Toggle append Enter"]'
    )
    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Command"]'
    )
    const saveButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Save')
    )
    expect(appendEnterSwitch).not.toBeNull()
    expect(textarea).not.toBeNull()
    expect(saveButton).not.toBeUndefined()

    await click(appendEnterSwitch!)
    expect(appendEnterSwitch?.getAttribute('aria-checked')).toBe('false')
    await replaceTextareaValue(textarea!, 'npm run dev -- --watch')
    expect(textarea?.value).toBe('npm run dev -- --watch')
    await click(saveButton!)

    expect(onSave).toHaveBeenCalledWith({
      id: 'qc-editable',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev -- --watch',
      appendEnter: false,
      scope: { type: 'global' }
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('hides append enter and shows agent toolbar hint in agent mode', async () => {
    await renderDialog({
      id: 'qc-3',
      label: 'Investigate',
      action: 'agent-prompt',
      agent: 'claude',
      prompt: 'Look into the build',
      scope: { type: 'global' }
    })

    expect(document.body.textContent).toContain('Supports /goal, skills, paths')
    expect(document.body.textContent).not.toContain('Append Enter — run immediately')
  })

  it('shows scope summary on the collapsed advanced toggle', async () => {
    await renderDialog({
      id: 'qc-4',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev',
      appendEnter: true,
      scope: { type: 'global' }
    })

    expect(document.body.textContent).toMatch(/Advanced\s*·\s*Global/)
  })

  it('opens the advanced section when defaultAdvancedOpen is true', async () => {
    await renderDialog(
      {
        id: 'qc-5',
        label: 'Start dev server',
        action: 'terminal-command',
        command: 'npm run dev',
        appendEnter: true,
        scope: { type: 'global' }
      },
      { defaultAdvancedOpen: true }
    )

    const advancedToggle = document.body.querySelector('[aria-expanded="true"]')
    expect(advancedToggle?.textContent).toContain('Advanced')
    expect(document.body.textContent).not.toMatch(/Advanced\s*·\s*Global/)
  })
})
