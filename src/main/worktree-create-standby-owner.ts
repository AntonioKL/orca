type ReleaseStandby = () => void
let standbyQueue: Promise<void> = Promise.resolve()

export function createWorktreeStandbyOwner() {
  let revision = 0
  let closed = false
  let release: ReleaseStandby | undefined

  return {
    set(prepare?: () => Promise<ReleaseStandby>): Promise<void> {
      const current = ++revision
      release?.()
      release = undefined
      if (closed || !prepare) {
        return Promise.resolve()
      }
      const job = standbyQueue.then(async () => {
        if (closed || revision !== current) {
          return
        }
        try {
          const prepared = await prepare()
          if (closed || revision !== current) {
            prepared()
          } else {
            release = prepared
          }
        } catch {
          // Speculative failure leaves ordinary Create responsible for recovery.
        }
      })
      standbyQueue = job
      return job
    },
    close(): void {
      closed = true
      revision++
      release?.()
      release = undefined
    }
  }
}
