// A suppressed utility crash files no report, so nothing claims the dump Crashpad
// wrote for it. This covers the wiring that keeps that orphan dump from becoming
// the next reportable utility crash's CHECK signature.
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as minidumpCrashSignature from './minidump-crash-signature'

const parseMinidumpCrashSignatureMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: () => [],
    getPath: () => '/unused-in-tests'
  },
  crashReporter: { start: vi.fn() }
}))
vi.mock('./minidump-crash-signature', async (importOriginal) => ({
  ...(await importOriginal<typeof minidumpCrashSignature>()),
  parseMinidumpCrashSignature: parseMinidumpCrashSignatureMock
}))

import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import { _setCrashpadCaptureStateForTest, captureMinidumpSignature } from './crashpad-capture'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'

const CRASHED_AT = 1_700_000_000_000

let dumpDir: string
let now = CRASHED_AT

/** Bounded poll so the miss path does not burn the real 8s Crashpad wait. */
const capture = (crashedAtMs: number, expectedProcessType: string) =>
  captureMinidumpSignature(crashedAtMs, {
    expectedProcessType,
    timeoutMs: 0,
    now: () => crashedAtMs
  })

async function writeDump(name: string, mtimeMs: number): Promise<string> {
  const filePath = path.join(dumpDir, 'reports', name)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, Buffer.from(name))
  await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000)
  return filePath
}

function utilityCrash(serviceName: string, reason: string): ProcessGoneCrashEvent {
  return {
    source: 'child',
    processType: 'Utility',
    reason,
    exitCode: -1,
    expectedTeardown: 'none',
    details: { type: 'Utility', serviceName }
  }
}

beforeEach(async () => {
  parseMinidumpCrashSignatureMock.mockReset()
  parseMinidumpCrashSignatureMock.mockImplementation((dump: Buffer) => ({
    processType: 'utility',
    checkMessage: `[FATAL:${dump.toString('utf8')}]`,
    annotations: {}
  }))
  now = CRASHED_AT
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  setActiveSink({ push: vi.fn(), flush: vi.fn(), close: vi.fn() })
  dumpDir = await mkdtemp(path.join(os.tmpdir(), 'orca-suppressed-dump-'))
  _setCrashpadCaptureStateForTest({ dumpDirectory: dumpDir, started: true })
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
})

afterEach(async () => {
  vi.restoreAllMocks()
  _resetTracerForTests()
  _setCrashpadCaptureStateForTest(null)
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
  await rm(dumpDir, { recursive: true, force: true })
})

describe('suppressed utility dumps', () => {
  it('does not donate the print compositor CHECK to the next storage-service report', async () => {
    recordProcessGoneCrash(
      null,
      utilityCrash('printing.mojom.PrintCompositor', 'crashed'),
      new ProcessGoneDedupe(),
      capture
    )
    await writeDump('print-compositor.dmp', now + 100)

    now = CRASHED_AT + 5_000
    const attach = vi.fn().mockResolvedValue(null)
    recordProcessGoneCrash(
      { record: async () => ({ id: 'report-1' }), attachDetails: attach } as never,
      utilityCrash('storage.mojom.StorageService', 'crashed'),
      new ProcessGoneDedupe(),
      capture
    )

    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce())
    expect(attach).toHaveBeenCalledWith('report-1', { minidumpStatus: 'absent' })
  })

  it('leaves the dump for a real crash claimable after a killed utility exit', async () => {
    // A killed process runs no Crashpad handler, so its exit must fence nothing.
    recordProcessGoneCrash(
      null,
      { ...utilityCrash('proxy_resolver.mojom.ProxyResolverFactory', 'killed'), exitCode: 1 },
      new ProcessGoneDedupe(),
      capture
    )
    const dump = await writeDump('storage.dmp', now + 100)

    now = CRASHED_AT + 5_000
    const attach = vi.fn().mockResolvedValue(null)
    recordProcessGoneCrash(
      { record: async () => ({ id: 'report-1' }), attachDetails: attach } as never,
      utilityCrash('storage.mojom.StorageService', 'crashed'),
      new ProcessGoneDedupe(),
      capture
    )

    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce())
    expect(attach).toHaveBeenCalledWith(
      'report-1',
      expect.objectContaining({ minidumpStatus: 'captured', minidumpPath: dump })
    )
  })
})
