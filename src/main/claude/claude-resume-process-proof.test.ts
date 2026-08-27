import { describe, expect, it } from 'vitest'
import {
  isClaudeResumeProcessCommandLine,
  readClaudeResumeProcessIdentity
} from './claude-resume-process-proof'

const SESSION_ID = 'session-claude-1'

describe('Claude resume process proof', () => {
  it('refuses a lingering Claude child for another session', async () => {
    await expect(
      readClaudeResumeProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-new',
        sessionId: SESSION_ID,
        platform: 'darwin',
        readPosixRows: async () => [
          { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
          { pid: 101, ppid: 100, stat: 'S+', command: 'claude --resume session-other' }
        ],
        timeoutMs: 0
      })
    ).rejects.toThrow('one exact Claude child process')
  })

  it('excludes the previous owner and all of its descendants', async () => {
    await expect(
      readClaudeResumeProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-new',
        sessionId: SESSION_ID,
        platform: 'darwin',
        readPosixRows: async () => [
          { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
          { pid: 101, ppid: 100, stat: 'S+', command: `claude --resume ${SESSION_ID}` },
          { pid: 102, ppid: 101, stat: 'S+', command: `claude --resume ${SESSION_ID}` }
        ],
        excludedProcessTreeRootIdentities: [{ pid: 101, processStartTimeMs: null }],
        timeoutMs: 0
      })
    ).rejects.toThrow('one exact Claude child process')
  })

  it('requires a PID-reuse-safe start time for the new owner', async () => {
    await expect(
      readClaudeResumeProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-new',
        sessionId: SESSION_ID,
        platform: 'darwin',
        readPosixRows: async () => [
          { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
          { pid: 101, ppid: 100, stat: 'S+', command: `claude --resume ${SESSION_ID}` }
        ],
        readStartTime: async () => null,
        timeoutMs: 0
      })
    ).rejects.toThrow('PID-reuse-safe start time')
  })

  it('matches only adjacent resume argv tokens exactly', () => {
    expect(
      isClaudeResumeProcessCommandLine(`claude --resume ${SESSION_ID}`, SESSION_ID, 'darwin')
    ).toBe(true)
    expect(
      isClaudeResumeProcessCommandLine(`claude --session-id ${SESSION_ID}`, SESSION_ID, 'darwin')
    ).toBe(false)
    expect(
      isClaudeResumeProcessCommandLine(`claude --resume ${SESSION_ID}-other`, SESSION_ID, 'darwin')
    ).toBe(false)
    expect(
      isClaudeResumeProcessCommandLine(`claude --resume=${SESSION_ID}`, SESSION_ID, 'darwin')
    ).toBe(false)
  })
})
