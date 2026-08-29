import { describe, expect, it } from 'vitest'
import {
  extractAgentWorkingDirectory,
  normalizeAgentWorkingDirectory
} from './agent-working-directory'

describe('agent working directory', () => {
  it('reads the cwd Claude and Codex hooks report', () => {
    expect(extractAgentWorkingDirectory({ cwd: '/repo/wt/packages/api' })).toBe(
      '/repo/wt/packages/api'
    )
  })

  it('reads the alternate spellings other providers use', () => {
    expect(extractAgentWorkingDirectory({ workspaceRoot: '/repo/wt' })).toBe('/repo/wt')
    expect(extractAgentWorkingDirectory({ workspace_root: '/repo/wt' })).toBe('/repo/wt')
  })

  it('accepts Windows drive and UNC paths', () => {
    expect(normalizeAgentWorkingDirectory('C:\\repo\\wt')).toBe('C:\\repo\\wt')
    expect(normalizeAgentWorkingDirectory('\\\\host\\share\\wt')).toBe('\\\\host\\share\\wt')
  })

  it('rejects a relative path — it means nothing without the process that emitted it', () => {
    expect(normalizeAgentWorkingDirectory('packages/api')).toBeUndefined()
    expect(normalizeAgentWorkingDirectory('./packages/api')).toBeUndefined()
    expect(normalizeAgentWorkingDirectory('~/repo')).toBeUndefined()
  })

  it('rejects blank, oversized, and control-character values', () => {
    expect(normalizeAgentWorkingDirectory('   ')).toBeUndefined()
    expect(normalizeAgentWorkingDirectory(`/${'a'.repeat(4096)}`)).toBeUndefined()
    expect(normalizeAgentWorkingDirectory('/repo/wt\u0007')).toBeUndefined()
  })

  it('reports unknown rather than a value for a payload with no directory', () => {
    expect(extractAgentWorkingDirectory({ session_id: 'abc' })).toBeUndefined()
    expect(normalizeAgentWorkingDirectory(undefined)).toBeUndefined()
    expect(normalizeAgentWorkingDirectory(42)).toBeUndefined()
  })
})
