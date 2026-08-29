import { describe, expectTypeOf, it } from 'vitest'
import type { GitHistoryResult } from '../../../../../../shared/git-history'
import type { GitHistoryPanelState } from './git-history-panel'

describe('GitHistoryPanelState', () => {
  it('ties retained history and errors to panel status', () => {
    expectTypeOf<
      Extract<GitHistoryPanelState, { status: 'refreshing' | 'ready' }>['result']
    >().toEqualTypeOf<GitHistoryResult>()
    expectTypeOf<
      Extract<GitHistoryPanelState, { status: 'idle' | 'loading' }>['result']
    >().toEqualTypeOf<undefined>()
    expectTypeOf<
      Extract<GitHistoryPanelState, { status: 'error' }>['error']
    >().toEqualTypeOf<string>()
  })
})
