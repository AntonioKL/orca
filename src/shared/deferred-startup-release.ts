export type StartupCommandReleaseResult =
  | 'accepted'
  | 'unverifiable'
  | 'retired'
  | 'identity-mismatch'
  | 'unavailable'
export type DeferredStartupStatus = 'pending' | 'accepted' | 'unverifiable' | 'retired'
