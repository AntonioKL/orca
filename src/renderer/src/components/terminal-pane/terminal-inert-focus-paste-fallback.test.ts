// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  installInertFocusPasteFallback,
  restoreInertFocusPasteTarget
} from './terminal-inert-focus-paste-fallback'

// STA-5272 / STA-3834: a dictation tool, IME, or overlay hands focus back to <body>,
// not to the pane. The pane's own keydown/paste listeners are bound to its root
// container with capture, so a body-targeted chord never reaches them: no paste,
// no error, nothing. Everything here runs on real DOM nodes and real dispatched
// events — a `contains` double would let this pass against unreachable state.
describe('inert-focus paste fallback', () => {
  let container: HTMLElement
  let inside: HTMLTextAreaElement
  let outside: HTMLInputElement
  let onPasteKey: Mock<(event: KeyboardEvent) => void>
  let onPasteEvent: Mock<(event: ClipboardEvent) => void>
  let dispose: (() => void) | null

  const install = (): ReturnType<typeof installInertFocusPasteFallback> => {
    const fallback = installInertFocusPasteFallback({ container, onPasteKey, onPasteEvent })
    dispose = fallback.dispose
    return fallback
  }
  const pressPasteChordOn = (target: EventTarget): void => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    )
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    container = document.createElement('div')
    inside = document.createElement('textarea')
    inside.className = 'xterm-helper-textarea'
    container.append(inside)
    outside = document.createElement('input')
    document.body.append(container, outside)
    onPasteKey = vi.fn()
    onPasteEvent = vi.fn()
    dispose = null
  })

  afterEach(() => {
    dispose?.()
    document.body.innerHTML = ''
  })

  it('premise: a container-bound capture listener never sees a body-targeted chord', () => {
    const paneListener = vi.fn()
    container.addEventListener('keydown', paneListener, { capture: true })
    inside.focus()
    inside.blur()

    pressPasteChordOn(document.body)

    // This is the whole defect: body is the container's ancestor, so the capture
    // path document -> html -> body never reaches the container.
    expect(paneListener).not.toHaveBeenCalled()
    container.removeEventListener('keydown', paneListener, { capture: true })
  })

  it('recovers a paste chord that lands on body after the pane blurred to it', () => {
    install()
    inside.focus()
    inside.blur()

    expect(document.activeElement).toBe(document.body)
    pressPasteChordOn(document.body)

    expect(onPasteKey).toHaveBeenCalledTimes(1)
  })

  it('recovers a native paste event that lands on body the same way', () => {
    install()
    inside.focus()
    inside.blur()

    document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }))

    expect(onPasteEvent).toHaveBeenCalledTimes(1)
  })

  it('leaves events inside the pane to the pane so a paste cannot fire twice', () => {
    install()
    inside.focus()

    pressPasteChordOn(inside)

    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('leaves an in-pane event to the pane even while focus itself is inert', () => {
    install()
    inside.focus()
    inside.blur()
    expect(document.activeElement).toBe(document.body)

    // A programmatic paste aimed at a pane child while focus sits on body: the
    // pane's own capture listener does receive this one, so the fallback must not
    // handle it as well and paste twice.
    inside.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }))
    pressPasteChordOn(inside)

    expect(onPasteEvent).not.toHaveBeenCalled()
    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('does not steal a paste once another surface has taken focus', () => {
    install()
    inside.focus()
    outside.focus()
    // Focus then falls to body from that other surface, not from the pane.
    outside.blur()

    expect(document.activeElement).toBe(document.body)
    pressPasteChordOn(document.body)

    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('does not steal a paste after the user clicks outside the pane', () => {
    install()
    inside.focus()
    inside.blur()
    // A click on a non-focusable region blurs to body with no focusin at all, so
    // the pointer is the only evidence the user moved on.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    pressPasteChordOn(document.body)

    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('keeps ownership through a click inside the pane', () => {
    install()
    inside.focus()
    inside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    inside.blur()

    pressPasteChordOn(document.body)

    expect(onPasteKey).toHaveBeenCalledTimes(1)
  })

  it('does not fire while a real element outside the pane holds focus', () => {
    install()
    inside.focus()
    outside.focus()

    expect(document.activeElement).toBe(outside)
    pressPasteChordOn(outside)

    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('claims focus that already sat in the pane when the listeners were installed', () => {
    inside.focus()
    install()
    inside.blur()

    pressPasteChordOn(document.body)

    expect(onPasteKey).toHaveBeenCalledTimes(1)
  })

  it('reports inert-focus ownership so other paste entry points can share the test', () => {
    const fallback = install()

    expect(fallback.ownsInertFocus()).toBe(false)
    inside.focus()
    expect(fallback.ownsInertFocus()).toBe(false)
    inside.blur()
    expect(fallback.ownsInertFocus()).toBe(true)
    outside.focus()
    expect(fallback.ownsInertFocus()).toBe(false)
  })

  it('stops recovering pastes after dispose', () => {
    const fallback = install()
    inside.focus()
    inside.blur()
    fallback.dispose()
    dispose = null

    pressPasteChordOn(document.body)
    document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }))

    expect(onPasteKey).not.toHaveBeenCalled()
    expect(onPasteEvent).not.toHaveBeenCalled()
  })
})

describe('restoreInertFocusPasteTarget', () => {
  const buildPane = (): { container: HTMLElement; terminal: { focus: Mock<() => void> } } => {
    document.body.innerHTML = ''
    const container = document.createElement('div')
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    container.append(helper)
    document.body.append(container)
    return { container, terminal: { focus: vi.fn<() => void>() } }
  }

  it('puts focus back on the pane when focus fell to body', () => {
    const pane = buildPane()

    restoreInertFocusPasteTarget(pane, document.body)

    expect(pane.terminal.focus).toHaveBeenCalledTimes(1)
  })

  it('puts focus back on the pane when nothing at all has focus', () => {
    const pane = buildPane()

    restoreInertFocusPasteTarget(pane, null)

    expect(pane.terminal.focus).toHaveBeenCalledTimes(1)
  })

  it('leaves focus alone when it is already inside the pane', () => {
    const pane = buildPane()

    restoreInertFocusPasteTarget(pane, pane.container.firstElementChild as Element)

    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })
})
