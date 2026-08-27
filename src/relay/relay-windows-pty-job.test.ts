import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assignRelayProcessToKillOnCloseJob } from './relay-windows-pty-job'

afterEach(() => {
  vi.restoreAllMocks()
})

function captureRelayLog(): { lines: () => string } {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    lines: () => write.mock.calls.map(([line]) => String(line)).join('')
  }
}

describe('assignRelayProcessToKillOnCloseJob', () => {
  it('reports successful Windows assignment without a degradation log', () => {
    const log = captureRelayLog()
    const assignCurrentProcessToJob = vi.fn().mockReturnValue(true)

    expect(assignRelayProcessToKillOnCloseJob('win32', () => ({ assignCurrentProcessToJob }))).toBe(
      'assigned'
    )
    expect(assignCurrentProcessToJob).toHaveBeenCalledOnce()
    expect(log.lines()).toBe('')
  })

  it('keeps startup available and logs when the native export is absent', () => {
    const log = captureRelayLog()

    expect(assignRelayProcessToKillOnCloseJob('win32', () => ({}))).toBe('unavailable')
    expect(log.lines()).toContain(
      '[relay] Windows kill-on-close job unavailable: ConPTY addon does not export assignCurrentProcessToJob'
    )
  })

  it('keeps startup available and logs when Windows refuses assignment', () => {
    const log = captureRelayLog()

    expect(
      assignRelayProcessToKillOnCloseJob('win32', () => ({
        assignCurrentProcessToJob: () => false
      }))
    ).toBe('unavailable')
    expect(log.lines()).toContain(
      '[relay] Windows kill-on-close job unavailable: assignment was refused'
    )
  })

  it.each([
    ['native load', () => new Error('binding unavailable')],
    ['native assignment', () => new Error('job nesting denied')]
  ])('keeps startup available when %s throws', (phase, createError) => {
    const log = captureRelayLog()
    const loader =
      phase === 'native load'
        ? () => {
            throw createError()
          }
        : () => ({
            assignCurrentProcessToJob: () => {
              throw createError()
            }
          })

    expect(assignRelayProcessToKillOnCloseJob('win32', loader)).toBe('unavailable')
    expect(log.lines()).toContain(createError().message)
  })

  it.each(['darwin', 'linux'] as const)('does nothing on %s', (platform) => {
    const log = captureRelayLog()
    const loadNative = vi.fn()

    expect(assignRelayProcessToKillOnCloseJob(platform, loadNative)).toBe('not-applicable')
    expect(loadNative).not.toHaveBeenCalled()
    expect(log.lines()).toBe('')
  })
})

describe('relay daemon startup ordering', () => {
  it('assigns exactly once before relay ownership or request handling begins', () => {
    const source = readFileSync(new URL('./relay-daemon.ts', import.meta.url), 'utf8')
    const body = source.slice(
      source.indexOf('export async function runRelayDaemon'),
      source.indexOf('function registerRelayStatus')
    )
    const assignment = 'assignRelayProcessToKillOnCloseJob()'
    const assignmentIndex = body.indexOf(assignment)

    expect(body.split(assignment)).toHaveLength(2)
    expect(assignmentIndex).toBeGreaterThan(
      body.indexOf('installRelayLogRotation(options.logFile)')
    )
    for (const initialization of [
      'new RelaySocketOwnership(',
      'new RelayPrimaryChannel(',
      'new RelayRuntimeServices(',
      'new RelayReconnectListener('
    ]) {
      expect(assignmentIndex).toBeLessThan(body.indexOf(initialization))
    }
  })
})
