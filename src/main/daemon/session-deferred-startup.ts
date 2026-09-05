import type { StartupCommandReleaseResult } from '../../shared/deferred-startup-release'
export type { StartupCommandReleaseResult } from '../../shared/deferred-startup-release'

export type DeferredSessionStartup = {
  operationId: string
  submission: string
}

/** Keeps Create authorization separate from the shell readiness timeout. */
export class SessionDeferredStartup {
  private state: 'pending' | 'accepted' | 'unverifiable' | 'retired' = 'pending'
  private submission: string | null
  private readonly operationId: string

  constructor(startup: DeferredSessionStartup) {
    this.operationId = startup.operationId
    this.submission = startup.submission
  }

  get isPending(): boolean {
    return this.state === 'pending'
  }

  retire(): void {
    if (this.state === 'pending') {
      this.state = 'retired'
      this.submission = null
    }
  }

  markUnverifiable(): void {
    if (this.state === 'accepted') {
      this.state = 'unverifiable'
    }
  }

  release(operationId: string, write: (submission: string) => void): StartupCommandReleaseResult {
    if (!operationId || operationId !== this.operationId) {
      return 'identity-mismatch'
    }
    if (this.state !== 'pending') {
      return this.state
    }
    const submission = this.submission
    this.submission = null
    this.state = 'accepted'
    try {
      if (submission) {
        write(submission)
      }
    } catch {
      // A throwing write can already have delivered bytes; never replay it.
      this.state = 'unverifiable'
    }
    return this.state
  }
}
