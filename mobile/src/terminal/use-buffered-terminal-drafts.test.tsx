import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { useBufferedTerminalDrafts } from './use-buffered-terminal-drafts'

type BufferedDraftHook = ReturnType<typeof useBufferedTerminalDrafts>

let currentHook: BufferedDraftHook | null = null
let renderer: ReactTestRenderer | null = null

function Probe({ activeHandle }: { readonly activeHandle: string | null }) {
  const activeHandleRef = useRef(activeHandle)
  activeHandleRef.current = activeHandle
  currentHook = useBufferedTerminalDrafts({ activeHandle, activeHandleRef })
  return null
}

function hook(): BufferedDraftHook {
  if (!currentHook) {
    throw new Error('Hook probe is not mounted')
  }
  return currentHook
}

afterEach(() => {
  act(() => renderer?.unmount())
  currentHook = null
  renderer = null
})

describe('useBufferedTerminalDrafts', () => {
  it('preserves an intentional clear after the optimistic send clear', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal' }))
    })
    act(() => hook().setInput('rejected command'))
    let send: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      send = hook().beginBufferedTerminalDraftSend('terminal', hook().input)
    })
    act(() => hook().setInput('new command'))
    act(() => hook().setInput(''))
    act(() => hook().restoreRejectedDraft(send))

    expect(hook().input).toBe('')
  })

  it('restores by origin after a tab switch and preserves stable callback identities', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal-a' }))
    })
    const callbacks = {
      begin: hook().beginBufferedTerminalDraftSend,
      prune: hook().pruneDrafts,
      reset: hook().resetDrafts,
      restore: hook().restoreRejectedDraft,
      setInput: hook().setInput,
      settle: hook().settleBufferedTerminalDraftSend
    }
    act(() => hook().setInput('  echo exact–text  '))
    let send: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      send = hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
      renderer?.update(createElement(Probe, { activeHandle: 'terminal-b' }))
    })
    act(() => hook().setInput('new command for B'))
    act(() => hook().restoreRejectedDraft(send))
    act(() => renderer?.update(createElement(Probe, { activeHandle: 'terminal-a' })))

    expect(hook().input).toBe('  echo exact–text  ')
    expect(hook().beginBufferedTerminalDraftSend).toBe(callbacks.begin)
    expect(hook().pruneDrafts).toBe(callbacks.prune)
    expect(hook().resetDrafts).toBe(callbacks.reset)
    expect(hook().restoreRejectedDraft).toBe(callbacks.restore)
    expect(hook().setInput).toBe(callbacks.setInput)
    expect(hook().settleBufferedTerminalDraftSend).toBe(callbacks.settle)
  })

  it('drops ended-handle and route-reset restoration metadata', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal' }))
    })
    act(() => hook().setInput('rejected command'))
    let prunedSend: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      prunedSend = hook().beginBufferedTerminalDraftSend('terminal', hook().input)
      hook().pruneDrafts(new Set())
      hook().restoreRejectedDraft(prunedSend)
    })
    expect(hook().input).toBe('')

    act(() => hook().setInput('route draft'))
    let resetSend: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      resetSend = hook().beginBufferedTerminalDraftSend('terminal', hook().input)
      hook().resetDrafts()
      hook().restoreRejectedDraft(resetSend)
    })
    expect(hook().input).toBe('')
  })
})
