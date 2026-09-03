import { describe, expect, it } from 'vitest'
import { CLAUDE_MANAGED_AUTH_UNOWNED_PROVENANCE } from '../claude-accounts/runtime-auth/runtime-auth-types'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { metadataForClaudeUsageAttempt } from './claude-usage-result'
import type { ClaudeOAuthCredentialReadResult } from './claude-oauth-credentials'

const credentials: ClaudeOAuthCredentialReadResult = {
  token: null,
  hasRefreshableCredentials: false,
  source: 'none'
}

const unownedPreparation: ClaudeRuntimeAuthPreparation = {
  configDir: '/Users/test/.claude',
  envPatch: {},
  stripAuthEnv: false,
  provenance: CLAUDE_MANAGED_AUTH_UNOWNED_PROVENANCE
}

describe('metadataForClaudeUsageAttempt', () => {
  it('classifies an unowned managed auth directory for the renderer', () => {
    expect(
      metadataForClaudeUsageAttempt({
        attemptedSources: [],
        oauthCredentials: credentials,
        authPreparation: unownedPreparation,
        failureKind: 'missing-credentials'
      })
    ).toMatchObject({
      failureKind: 'managed-auth-unowned',
      authProvenance: CLAUDE_MANAGED_AUTH_UNOWNED_PROVENANCE
    })
  })

  it('passes the caller failure kind through when the preparation is not degraded', () => {
    expect(
      metadataForClaudeUsageAttempt({
        attemptedSources: [],
        oauthCredentials: credentials,
        authPreparation: { ...unownedPreparation, provenance: 'managed:account-1' },
        failureKind: 'missing-credentials'
      })
    ).toMatchObject({ failureKind: 'missing-credentials' })
  })
})
