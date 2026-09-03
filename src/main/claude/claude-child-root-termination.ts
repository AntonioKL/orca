import type { SpawnedProcess } from '../../shared/child-process/run-process'
import type { PosixProcessIdentity } from '../pty-descendant-termination'
import { verifyPosixProcessIdentity } from '../pty-posix-root-identity'
import type {
  WindowsDescendantSnapshot,
  WindowsProcessIdentity
} from '../windows-descendant-exit-verification'
import { verifyWindowsProcessIdentity } from '../windows-descendant-exit-verification'

export type ClaudeRootIdentity = PosixProcessIdentity | WindowsProcessIdentity

export function createClaudeRootIdentityVerifier(
  platform: NodeJS.Platform,
  captureBoundary: () => number | undefined
): (root: ClaudeRootIdentity) => Promise<boolean> {
  return (root) =>
    platform === 'win32'
      ? verifyWindowsProcessIdentity(root as WindowsProcessIdentity)
      : verifyPosixProcessIdentity(root as PosixProcessIdentity, {
          capturedAtMs: captureBoundary()
        })
}

type RootTerminationInput = {
  child: Pick<SpawnedProcess, 'pid' | 'kill'>
  root: ClaudeRootIdentity | undefined
  exited: () => boolean
  identityUnsafe: boolean
  verifyRoot: (root: ClaudeRootIdentity) => Promise<boolean>
}

/** Identity-gated direct root kill; false means no signal was sent. */
export async function terminateClaudeRootIfLive(input: RootTerminationInput): Promise<boolean> {
  const { child, root, exited, identityUnsafe, verifyRoot } = input
  if (exited() || identityUnsafe || !root || root.pid !== child.pid) {
    return false
  }
  const identityMatches = await verifyRoot(root).catch(() => false)
  // Re-check JS ownership after the async identity read: exit may land meanwhile.
  if (!identityMatches || exited() || identityUnsafe) {
    return false
  }
  child.kill('SIGKILL')
  return true
}

type WindowsRootTerminationInput = {
  snapshot: WindowsDescendantSnapshot | null
  exited: () => boolean
  verifyRoot: (root: WindowsProcessIdentity) => Promise<boolean>
  terminateTree: (root: WindowsProcessIdentity) => Promise<void>
  killRoot: (root: WindowsProcessIdentity | undefined) => Promise<boolean>
}

export async function terminateClaudeWindowsRoot(
  input: WindowsRootTerminationInput
): Promise<{ rootVerified: boolean; rootKilled: boolean }> {
  const { snapshot, exited, verifyRoot, terminateTree, killRoot } = input
  let rootVerified = false
  if (!exited() && snapshot) {
    rootVerified = await verifyRoot(snapshot.root).catch(() => false)
    if (rootVerified && !exited()) {
      await terminateTree(snapshot.root).catch(() => {})
    }
  }
  const rootKilled = await killRoot(rootVerified && snapshot ? snapshot.root : undefined)
  return { rootVerified, rootKilled }
}
