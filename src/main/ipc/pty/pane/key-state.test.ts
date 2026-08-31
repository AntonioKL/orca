import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  paneKeyPtyId,
  paneKeyRekeyListeners,
  ptyPaneKey,
  rememberPaneKeyForPty,
  registerPaneKeyRekeyListener
} from './key-state'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const PTY_ID = 'pty-pane-key-rebind'
const OLD_PANE_KEY = makePaneKey(
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
)
const CURRENT_PANE_KEY = makePaneKey(
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222'
)

describe('pane key state', () => {
  afterEach(() => {
    ptyPaneKey.delete(PTY_ID)
    paneKeyPtyId.delete(OLD_PANE_KEY)
    paneKeyPtyId.delete(CURRENT_PANE_KEY)
    paneKeyRekeyListeners.clear()
    vi.restoreAllMocks()
  })

  it('notifies consumers when a surviving PTY binds to a new pane key', () => {
    const onRekey = vi.fn()
    registerPaneKeyRekeyListener(onRekey)

    rememberPaneKeyForPty(PTY_ID, OLD_PANE_KEY)
    rememberPaneKeyForPty(PTY_ID, CURRENT_PANE_KEY)

    expect(onRekey).toHaveBeenCalledOnce()
    expect(onRekey).toHaveBeenCalledWith({
      ptyId: PTY_ID,
      previousPaneKey: OLD_PANE_KEY,
      paneKey: CURRENT_PANE_KEY
    })
    expect(ptyPaneKey.get(PTY_ID)).toBe(CURRENT_PANE_KEY)
    expect(paneKeyPtyId.get(CURRENT_PANE_KEY)).toBe(PTY_ID)
    expect(paneKeyPtyId.has(OLD_PANE_KEY)).toBe(false)
  })

  it('aliases a stale hook key when the local PTY map was rebuilt', () => {
    const onRekey = vi.fn()
    registerPaneKeyRekeyListener(onRekey)

    rememberPaneKeyForPty(PTY_ID, CURRENT_PANE_KEY, { sourcePaneKey: OLD_PANE_KEY })

    expect(onRekey).toHaveBeenCalledWith({
      ptyId: PTY_ID,
      previousPaneKey: OLD_PANE_KEY,
      paneKey: CURRENT_PANE_KEY
    })
  })
})
