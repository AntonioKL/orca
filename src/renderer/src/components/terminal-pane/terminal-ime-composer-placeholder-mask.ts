import type { IDisposable, Terminal } from '@xterm/xterm'
import { hasTerminalComposerPlaceholder } from '../../../../shared/terminal-composer-draft'
import { readTerminalCursorLineContext } from '../../../../shared/terminal-cursor-line-context'
import {
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'

export const TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS = 'orca-ime-composer-placeholder'
// One live composition and a few delayed turnovers are enough for xterm's lifecycle; a missing
// session-end event must not retain ownership forever.
export const MAX_ACTIVE_COMPOSITION_SESSIONS = 8

function compositionSessionId(event: Event): number | null {
  if (!(event instanceof CustomEvent)) {
    return null
  }
  const id = (event.detail as { id?: unknown } | null)?.id
  return Number.isSafeInteger(id) && Number(id) > 0 ? Number(id) : null
}

export function installTerminalImeComposerPlaceholderMask(terminal: Terminal): IDisposable {
  const element = terminal.element
  if (!element) {
    return { dispose: () => undefined }
  }

  const activeSessions = new Set<number>()
  const syncPlaceholderOwnership = (): void => {
    const ownsPlaceholder =
      activeSessions.size > 0 &&
      hasTerminalComposerPlaceholder(readTerminalCursorLineContext(terminal, terminal.rows))
    element.classList.toggle(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS, ownsPlaceholder)
  }
  const handleSessionStart = (event: Event): void => {
    const id = compositionSessionId(event)
    if (id === null) {
      return
    }
    if (!activeSessions.has(id) && activeSessions.size >= MAX_ACTIVE_COMPOSITION_SESSIONS) {
      // Drop stale ownership before adopting the newest transaction.
      activeSessions.clear()
    }
    activeSessions.add(id)
    syncPlaceholderOwnership()
  }
  const handleSessionEnd = (event: Event): void => {
    const id = compositionSessionId(event)
    if (id === null) {
      return
    }
    activeSessions.delete(id)
    syncPlaceholderOwnership()
  }
  const handleBlur = (): void => {
    activeSessions.clear()
    syncPlaceholderOwnership()
  }

  element.addEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, handleSessionStart)
  element.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, handleSessionEnd)
  element.addEventListener('blur', handleBlur, true)
  const renderDisposable = terminal.onRender(() => {
    if (activeSessions.size > 0) {
      syncPlaceholderOwnership()
    }
  })

  return {
    dispose: () => {
      activeSessions.clear()
      element.classList.remove(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)
      element.removeEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, handleSessionStart)
      element.removeEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, handleSessionEnd)
      element.removeEventListener('blur', handleBlur, true)
      renderDisposable.dispose()
    }
  }
}
