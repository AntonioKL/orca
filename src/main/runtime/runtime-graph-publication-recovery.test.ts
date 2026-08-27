/**
 * STA-5523: a live renderer must be able to restore an `unavailable` runtime
 * graph. The reload fence added for STA-4016 keyed supersession off
 * `graphStatus !== 'ready'`, which also rejected the only publisher that could
 * heal a terminally-failed graph — leaving paired mobile clients on an empty
 * tab inventory for the rest of the desktop process's life.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const WINDOW_ID = 7
const OTHER_WINDOW_ID = 9
const WORKTREE_ID = 'repo-1::/tmp/worktree-a'

function createRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService({} as never)
}

function desktopGraph(generation: string): Parameters<OrcaRuntimeService['syncWindowGraph']>[1] {
  return {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'zsh',
        activeLeafId: 'leaf-1',
        layout: { type: 'leaf', leafId: 'leaf-1' }
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: 'leaf-1',
        paneRuntimeId: 1,
        ptyId: 'pty-1'
      }
    ],
    rendererGeneration: generation
  }
}

describe('runtime graph publication recovery', () => {
  it('lets the still-live renderer republish after a terminal reload failure', () => {
    const runtime = createRuntime()
    runtime.attachWindow(WINDOW_ID)
    runtime.syncWindowGraph(WINDOW_ID, desktopGraph('renderer-a'))
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready' })

    // A renderer notification send failure suspends the graph while the same
    // document keeps running — the desktop UI stays up and responsive.
    runtime.markGraphReloadFailed(WINDOW_ID, 'renderer-frame-unavailable')
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: WINDOW_ID,
      graphStatus: 'unavailable',
      liveTabCount: 0
    })

    runtime.syncWindowGraph(WINDOW_ID, desktopGraph('renderer-a'))
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: WINDOW_ID,
      graphStatus: 'ready',
      liveTabCount: 1
    })
  })

  it('still rejects the pre-reload document while its replacement is loading', () => {
    const runtime = createRuntime()
    runtime.attachWindow(WINDOW_ID)
    runtime.syncWindowGraph(WINDOW_ID, desktopGraph('renderer-a'))
    runtime.markRendererReloading(WINDOW_ID)

    expect(() => runtime.syncWindowGraph(WINDOW_ID, desktopGraph('renderer-a'))).toThrow(
      'superseded renderer generation'
    )
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'reloading' })
  })

  it('refuses a late publication from a window whose graph was retired', () => {
    const runtime = createRuntime()
    runtime.attachWindow(WINDOW_ID)
    runtime.syncWindowGraph(WINDOW_ID, desktopGraph('renderer-a'))
    runtime.markGraphUnavailable(WINDOW_ID)

    expect(() => runtime.syncWindowGraph(WINDOW_ID, desktopGraph('renderer-a'))).toThrow()
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: null,
      graphStatus: 'unavailable'
    })

    runtime.attachWindow(OTHER_WINDOW_ID)
    runtime.syncWindowGraph(OTHER_WINDOW_ID, desktopGraph('renderer-b'))
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: OTHER_WINDOW_ID,
      graphStatus: 'ready'
    })
  })
})
