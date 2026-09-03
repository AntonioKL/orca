import { describe, expect, it, vi } from 'vitest'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { WindowsDescendantSnapshot } from '../windows-descendant-exit-verification'
import { createClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'
import { mergeClaudeCapturedTrees } from './claude-child-tree-snapshot'

function posixSnapshot(capturedAtMs: number): DescendantSnapshot {
  return {
    root: { pid: 100, startedAt: 'Mon Jan 1 00:00:00 2026' },
    rootPgid: 100,
    descendants: [{ pid: 200, ppid: 100, pgid: 100, startedAt: 'Mon Jan 1 00:00:01 2026' }],
    capturedAtMs
  }
}

function windowsSnapshot(): WindowsDescendantSnapshot {
  return {
    root: { pid: 100, creationTimeMs: 5 },
    descendants: [{ pid: 200, creationTimeMs: 7 }],
    unidentifiedCount: 0,
    capturedAtMs: 1
  }
}

describe('Claude child root identity', () => {
  it('keeps a retained row boundary when a refresh observes no new descendants', () => {
    const previous = posixSnapshot(1_700_000_000_900)
    const next = posixSnapshot(1_700_000_002_100)

    expect(
      mergeClaudeCapturedTrees(
        { platform: 'posix', tree: previous },
        { platform: 'posix', tree: next }
      )
    ).toEqual({
      platform: 'posix',
      tree: { ...next, capturedAtMsByPid: { '200': previous.capturedAtMs } }
    })
  })

  it('fails closed when POSIX root identity revalidation is unavailable', async () => {
    const child = { pid: 100, kill: vi.fn(() => true) }
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants: vi.fn(async () => posixSnapshot(1)),
      terminateDescendants,
      verifyRootIdentity: vi.fn(async () => false)
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(terminateDescendants).toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('fails closed when Windows root identity revalidation is unavailable', async () => {
    const child = { pid: 100, kill: vi.fn(() => true) }
    const terminateWindowsTree = vi.fn(async () => {})
    const terminateWindowsDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      captureWindowsDescendants: vi.fn(async () => windowsSnapshot()),
      terminateWindowsTree,
      terminateWindowsDescendants,
      verifyRootIdentity: vi.fn(async () => false)
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(terminateWindowsTree).not.toHaveBeenCalled()
    expect(terminateWindowsDescendants).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })
})
