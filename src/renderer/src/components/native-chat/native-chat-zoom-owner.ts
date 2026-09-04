import type { UIZoomDirection } from '../../../../shared/ui-zoom-level'

type NativeChatZoomHandler = (direction: UIZoomDirection) => void

const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'
const handlersByRoot = new WeakMap<Element, NativeChatZoomHandler>()

function findNativeChatRoot(activeElement: unknown): Element | null {
  if (
    typeof activeElement !== 'object' ||
    activeElement === null ||
    !('closest' in activeElement) ||
    typeof (activeElement as { closest?: unknown }).closest !== 'function'
  ) {
    return null
  }
  return (
    activeElement as {
      closest: (selector: string) => Element | null
    }
  ).closest(NATIVE_CHAT_ROOT_SELECTOR)
}

export function isNativeChatZoomFocused(activeElement: unknown): boolean {
  return findNativeChatRoot(activeElement) !== null
}

export function registerNativeChatZoomOwner(
  root: Element,
  handler: NativeChatZoomHandler
): () => void {
  handlersByRoot.set(root, handler)
  return () => {
    if (handlersByRoot.get(root) === handler) {
      handlersByRoot.delete(root)
    }
  }
}

export function dispatchNativeChatZoom(
  activeElement: unknown,
  direction: UIZoomDirection
): boolean {
  const root = findNativeChatRoot(activeElement)
  const handler = root ? handlersByRoot.get(root) : undefined
  if (!handler) {
    return false
  }
  handler(direction)
  return true
}
