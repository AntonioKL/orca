import { isInertDocumentFocus } from './terminal-paste-target-state'

type InstallInertFocusPasteFallbackArgs = {
  /** TerminalPane root; the pane's own listeners already cover events inside it. */
  container: HTMLElement
  documentTarget?: Document
  onPasteKey: (event: KeyboardEvent) => void
  onPasteEvent: (event: ClipboardEvent) => void
}

export type InertFocusPasteFallback = {
  /** True while this pane is the last surface to have held focus and focus has
   *  since fallen to `<body>` rather than moving to another surface. */
  ownsInertFocus: () => boolean
  dispose: () => void
}

/** A dictation tool, IME, or overlay hands focus back to `<body>`, not to the pane.
 *  The pane's own capture listeners never see those keydown/paste events, so the
 *  chord is dropped with no paste and no error. Recover it at the document, but
 *  only while nothing else has claimed focus or the pointer. */
export function installInertFocusPasteFallback({
  container,
  documentTarget = document,
  onPasteKey,
  onPasteEvent
}: InstallInertFocusPasteFallbackArgs): InertFocusPasteFallback {
  let paneOwnsFocus = containsNode(container, documentTarget.activeElement)

  const onFocusIn = (event: FocusEvent): void => {
    paneOwnsFocus = containsNode(container, event.target)
  }
  // Why: a click on a non-focusable region blurs to <body> without any focusin,
  // so the pointer is the only signal that the user moved on.
  const onPointerDown = (event: Event): void => {
    if (!containsNode(container, event.target)) {
      paneOwnsFocus = false
    }
  }
  const ownsInertFocus = (): boolean =>
    paneOwnsFocus && isInertDocumentFocus(documentTarget.activeElement)
  const shouldRecover = (event: Event): boolean =>
    !containsNode(container, event.target) && ownsInertFocus()

  const onKeyDown = (event: KeyboardEvent): void => {
    if (shouldRecover(event)) {
      onPasteKey(event)
    }
  }
  const onPaste = (event: ClipboardEvent): void => {
    if (shouldRecover(event)) {
      onPasteEvent(event)
    }
  }

  documentTarget.addEventListener('focusin', onFocusIn, { capture: true })
  documentTarget.addEventListener('pointerdown', onPointerDown, { capture: true })
  documentTarget.addEventListener('keydown', onKeyDown, { capture: true })
  documentTarget.addEventListener('paste', onPaste, { capture: true })

  return {
    ownsInertFocus,
    dispose: () => {
      documentTarget.removeEventListener('focusin', onFocusIn, { capture: true })
      documentTarget.removeEventListener('pointerdown', onPointerDown, { capture: true })
      documentTarget.removeEventListener('keydown', onKeyDown, { capture: true })
      documentTarget.removeEventListener('paste', onPaste, { capture: true })
    }
  }
}

function containsNode(container: HTMLElement, node: EventTarget | Node | null): boolean {
  return node instanceof Node && container.contains(node)
}

/** Focus is on <body> but the pane still owns it logically; putting it back before
 *  the shared paste path runs lets that path's dispatch-element guard see the real target. */
export function restoreInertFocusPasteTarget(
  pane: { container: HTMLElement; terminal: { focus: () => void } },
  activeElement: Element | null
): void {
  if (!activeElement || !pane.container.contains(activeElement)) {
    pane.terminal.focus()
  }
}
