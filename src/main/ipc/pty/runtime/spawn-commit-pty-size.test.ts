import { afterEach, describe, expect, it, vi } from 'vitest'
import { ptySizes } from '../delivery/visibility-state'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const PTY_ID = 'orca-pty-adopted'
const LIVE_GRID = { cols: 211, rows: 57 }

function makeRuntime() {
  return {
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    noteTerminalSpawnCommand: vi.fn()
  }
}

describe('runtime spawn commit: adopted agent-session claim', () => {
  afterEach(() => {
    ptySizes.delete(PTY_ID)
  })

  it('commits the live grid from the adoption reply before the early return', async () => {
    const runtime = makeRuntime()
    const deps = { runtime, store: undefined, options: {} } as unknown as PtyRuntimeControllerDeps
    const args = { cols: 120, rows: 40, worktreeId: 'wt-1' } as unknown as RuntimePtySpawnArgs
    const ctx = createRuntimePtySpawnState(deps, args)
    ctx.result = {
      id: PTY_ID,
      isReattach: true,
      snapshotCols: LIVE_GRID.cols,
      snapshotRows: LIVE_GRID.rows,
      agentSessionEnsure: {
        disposition: 'adopted',
        owner: {
          claim: { kind: 'terminal' },
          generation: 'g1',
          phase: 'live',
          ptyId: PTY_ID,
          surface: { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1', terminalHandle: 'h1' }
        }
      }
    } as unknown as typeof ctx.result

    await commitRuntimePtySpawn(ctx)

    expect(ptySizes.get(PTY_ID)).toEqual(LIVE_GRID)
    expect(runtime.reflowHeadlessTerminalToPtyGrid).toHaveBeenCalledWith(
      PTY_ID,
      LIVE_GRID.cols,
      LIVE_GRID.rows
    )
  })
})
