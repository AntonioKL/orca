// The registration half of combineUnsubscribes, shared so the daemon provider, its adapter
// fanout and the adapter base don't each repeat it. Why the guard: these unsubscribes get
// called twice (dispose, then the caller's own cleanup) and splice(-1, 1) would drop the
// last listener rather than none.
export function addRemovableListener<T>(listeners: T[], listener: NoInfer<T>): () => void {
  listeners.push(listener)
  return () => {
    const index = listeners.indexOf(listener)
    if (index !== -1) {
      listeners.splice(index, 1)
    }
  }
}
