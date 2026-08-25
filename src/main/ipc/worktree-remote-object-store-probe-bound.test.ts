// The object-store diagnosis probes run on the create FAILURE path, where a partial clone
// can turn `rev-parse ^{tree}` into a promisor fetch against an unreachable remote. The local
// path bounds every probe at WORKTREE_OBJECT_STORE_DIAGNOSIS_TIMEOUT_MS
// (worktree-add-object-store-diagnosis-timeout.test.ts); the SSH path must not silently
// inherit the multiplexer's 30s ambient default and hold a failing create three times longer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { WORKTREE_OBJECT_STORE_DIAGNOSIS_TIMEOUT_MS } from '../git/worktree'

const SOURCE = readFileSync(join(__dirname, 'worktree-remote.ts'), 'utf8')

// Call-site audit (same shape as global-fetch-call-site-audit.test.ts): the diagnosis
// runner is built inline at each create path, so the bound is only visible in the source.
const DIAGNOSIS_RUNNER = /provider\.exec\(gitArgs,\s*repo\.path([^)]*)\)/g

describe('SSH worktree-create object-store diagnosis probes', () => {
  it('bounds every probe instead of inheriting the 30s relay request default', () => {
    const runners = [...SOURCE.matchAll(DIAGNOSIS_RUNNER)].map(([, args]) => args)

    // Both create paths diagnose: plain `worktree add`, and the sparse follow-up checkout.
    expect(runners).toHaveLength(2)
    for (const args of runners) {
      expect(args).toContain('timeoutMs')
    }
  })

  it('keeps the SSH bound well under the ambient relay request timeout it replaces', () => {
    expect(WORKTREE_OBJECT_STORE_DIAGNOSIS_TIMEOUT_MS).toBeLessThan(30_000)
  })
})
