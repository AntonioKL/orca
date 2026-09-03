import { describe, expect, it, vi } from 'vitest'

const installed = vi.hoisted(() => ({ deps: null as Record<string, unknown> | null }))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(async (deps: Record<string, unknown>) => {
    installed.deps = deps
  })
}))

import { OrcaRuntimeService } from './orca-runtime'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'

const SETTINGS = {
  claudeManagedAccounts: [],
  activeClaudeManagedAccountId: null,
  agentDefaultEnv: {},
  agentDefaultArgs: {}
} as unknown as ClaudeManagedAccountGateSettings

function readGate(): (() => unknown) | undefined {
  const deps: Record<string, unknown> = installed.deps ?? {}
  const read = deps['readClaudeManagedAccountGate']
  return typeof read === 'function' ? (read as () => unknown) : undefined
}

/** The runtime class this wiring lives on does not typecheck its own `this` calls, so a broken or
 *  missing gate hookup compiles clean. Pin it behaviourally instead. */
describe('structured Claude managed-account gate wiring', () => {
  it('hands the host a gate reader that resolves the live settings', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService({ getSettings: () => SETTINGS } as never)

    await runtime.ensureStructuredAgentSessionHost()

    const read = readGate()
    expect(typeof read).toBe('function')
    expect(read?.()).toBe(SETTINGS)
  })

  it('answers null instead of throwing when the settings cannot be read', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()

    expect(readGate()?.()).toBeNull()
  })
})
