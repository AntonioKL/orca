import { describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainAgentHookSpool, launchTokenHash, readSpoolRecords } from './spool'
import { AgentHookServer, _internals } from './server'
import { buildBody } from './server.test-fixtures'
import { _internals as codexInternals } from '../codex/hook-service'

describe('agent hook spool', () => {
  it('drops torn lines while retaining complete records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-'))
    const file = join(dir, 'pane.jsonl')
    writeFileSync(
      file,
      '\n{"paneKey":"tab:1","source":"codex","receivedAt":1,"payload":{}}\n{"paneKey":'
    )
    expect(readSpoolRecords(file, 1)).toHaveLength(1)
  })

  it('rejects stale launch tokens before ingest and truncates in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-'))
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    const file = join(spool, 'pane-1.jsonl')
    writeFileSync(
      file,
      `\n${JSON.stringify({ paneKey: 'tab:1', source: 'codex', launchToken: 'old', receivedAt: Date.now(), payload: { state: 'done' } })}\n`
    )
    const inode = statSync(file).ino
    const ingested: unknown[] = []
    drainAgentHookSpool({
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => launchTokenHash('new')!,
      ingest: (record) => ingested.push(record)
    })
    expect(ingested).toHaveLength(0)
    expect(readFileSync(file)).toHaveLength(0)
    expect(statSync(file).ino).toBe(inode)
  })

  it('ingests a record with the matching launch token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-'))
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    const file = join(spool, 'pane-1.jsonl')
    writeFileSync(
      file,
      `\n${JSON.stringify({ paneKey: 'tab:1', source: 'codex', launchToken: 'same', receivedAt: Date.now(), payload: { state: 'done' } })}\n`
    )
    const ingested: unknown[] = []
    drainAgentHookSpool({
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => launchTokenHash('same')!,
      ingest: (record) => ingested.push(record)
    })
    expect(ingested).toHaveLength(1)
    expect(ingested[0]).toMatchObject({ paneKey: 'tab:1', isReplay: true })
  })

  it('replays a spooled Codex SubagentStop through the server after restart', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-spool-e2e-'))
    const paneKey = 'tab-spool:0'
    const launchToken = 'generation-token'
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    const started = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'child-spooled' }),
      'production'
    )!
    first.ingestRemote(
      {
        paneKey,
        source: 'codex',
        hookEventName: 'SubagentStart',
        launchToken,
        payload: started.payload
      },
      'spool-test'
    )
    first.flushStatusPersistSync()
    first.stop()
    const stopped = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SubagentStop', agent_id: 'child-spooled' }),
      'production'
    )!
    const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    writeFileSync(
      join(spoolDir, 'pane-tab-spooled_0.jsonl'),
      `\n${JSON.stringify({ paneKey, source: 'codex', hookEventName: 'SubagentStop', launchToken, receivedAt: Date.now(), payload: stopped.payload })}\n`
    )
    const restarted = new AgentHookServer()
    await restarted.start({ env: 'production', userDataPath })
    try {
      expect(restarted.getStatusSnapshot()[0]?.payload.subagents).toBeUndefined()
    } finally {
      restarted.stop()
    }
  })

  it('spools when the endpoint is present but the receiver is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-failure-'))
    const endpointDir = join(dir, 'agent-hooks')
    mkdirSync(endpointDir, { recursive: true })
    const endpoint = join(endpointDir, 'endpoint.env')
    writeFileSync(
      endpoint,
      'ORCA_AGENT_HOOK_PORT=9\nORCA_AGENT_HOOK_TOKEN=stale\nORCA_AGENT_HOOK_ENV=production\nORCA_AGENT_HOOK_VERSION=1\n'
    )
    const script = join(dir, 'codex-hook.sh')
    writeFileSync(script, codexInternals.getManagedScript('posix'))
    chmodSync(script, 0o755)
    execFileSync('/bin/sh', [script], {
      input: '{"hook_event_name":"SubagentStop","agent_id":"child"}\n',
      env: {
        ...process.env,
        ORCA_AGENT_HOOK_ENDPOINT: endpoint,
        ORCA_PANE_KEY: 'tab-failure:0',
        ORCA_TAB_ID: 'tab-failure',
        ORCA_AGENT_LAUNCH_TOKEN: 'generation-token'
      },
      timeout: 5000
    })
    const spoolFiles = readdirSync(join(endpointDir, 'spool'))
    expect(spoolFiles).toHaveLength(1)
    expect(readFileSync(join(endpointDir, 'spool', spoolFiles[0]!), 'utf8')).toContain(
      'SubagentStop'
    )
  })
})
