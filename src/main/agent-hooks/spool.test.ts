import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainAgentHookSpool, launchTokenHash, readSpoolRecords } from './spool'
import { AgentHookServer, _internals } from './server'
import { buildBody } from './server.test-fixtures'

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
})
