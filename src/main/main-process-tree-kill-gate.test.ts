import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The ratchet behind the guard's claim to be a choke point.
 *
 * `admitSelfInitiatedTreeKill` is only "one decision" for as long as every
 * pid-addressed `taskkill /pid <pid> /t /f` in Electron main asks it. Each such
 * kill can land on a recycled pid that is now one of Orca's own Chromium
 * processes (#10680), and an ungated one is also invisible to
 * `selfInitiatedTreeKillCount`, which makes a zero read as exculpatory when it
 * is not. A new family fails here rather than in the field.
 */
const REPOSITORY_ROOT = resolve(__dirname, '..', '..')
const MAIN_DIRECTORY = 'src/main/'
const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

/** Pid-addressed: `/pid <n>` walks whatever tree owns that pid *now*. */
const PID_ADDRESSED_TASKKILL = /['"]taskkill(?:\.exe)?['"][\s\S]{0,120}?['"]\/pid['"]/i

const GATE = 'admitSelfInitiatedTreeKill'
/** The `src/shared` seam main installs the same gate into; shared code cannot import it directly. */
const SEAM = 'admitProcessTreeKill'

/**
 * Only ever shrinks. Each entry states why the gate cannot reach it — never
 * "not got to yet", which is what a new ungated family would also look like.
 */
const UNGATED_TASKKILL_ALLOWLIST = new Map<string, string>([
  [
    'src/main/browser/browser-route-egress-electron-launch.ts',
    'Electron probe reached only from *.electron.test.ts; kills the probe Electron it spawned'
  ],
  [
    'src/main/browser/browser-route-persisted-worker-electron-process.ts',
    'Electron probe reached only from *.electron.test.ts; kills the probe Electron it spawned'
  ],
  [
    'src/cli/handlers/interactive-login-interruption.ts',
    'CLI host: no Chromium pid on the machine to reach, and no reader for the ring'
  ],
  [
    'src/relay/subprocess-tree-termination.ts',
    'Relay host: same, and the relay cannot import the main-process gate'
  ]
])

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || /(?:test-harness|test-fixture|fixture)/.test(path)
}

function scanSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      scanSourceFiles(path, found)
      continue
    }
    if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension)) && !isTestFile(path)) {
      found.push(path)
    }
  }
  return found
}

// Only the Node-side hosts: a renderer or preload cannot spawn a process at all.
const SCANNED_HOSTS = ['src/main', 'src/shared', 'src/cli', 'src/relay']

/** Scanned once at import: 10k files is seconds, and every case below reuses it. */
const PID_ADDRESSED_TASKKILL_FILES = SCANNED_HOSTS.flatMap((host) =>
  scanSourceFiles(join(REPOSITORY_ROOT, host))
    .map((path) => ({
      path: relative(REPOSITORY_ROOT, path).split('\\').join('/'),
      source: readFileSync(path, 'utf8')
    }))
    .filter((file) => PID_ADDRESSED_TASKKILL.test(file.source))
)

function pidAddressedTaskkillFiles(): { path: string; source: string }[] {
  return PID_ADDRESSED_TASKKILL_FILES
}

describe('main-process tree-kill gate', () => {
  it('finds the taskkill families it is meant to police', () => {
    // Falsifiable: a scanner that matched nothing would pass every case below.
    expect(pidAddressedTaskkillFiles().map((file) => file.path)).toContain(
      'src/main/windows-process-tree-kill.ts'
    )
  })

  it('routes every pid-addressed taskkill in Electron main through the gate', () => {
    const ungated = pidAddressedTaskkillFiles()
      .filter((file) => file.path.startsWith(MAIN_DIRECTORY))
      .filter((file) => !file.source.includes(GATE) && !file.source.includes(SEAM))
      .map((file) => file.path)
      .filter((path) => !UNGATED_TASKKILL_ALLOWLIST.has(path))

    expect(ungated).toEqual([])
  })

  it('leaves no pid-addressed taskkill outside main unaccounted for', () => {
    const unaccounted = pidAddressedTaskkillFiles()
      .filter((file) => !file.path.startsWith(MAIN_DIRECTORY))
      .filter((file) => !file.source.includes(GATE) && !file.source.includes(SEAM))
      .map((file) => file.path)
      .filter((path) => !UNGATED_TASKKILL_ALLOWLIST.has(path))

    expect(unaccounted).toEqual([])
  })

  it('keeps the allowlist honest: every entry still spawns a taskkill', () => {
    const spawning = new Set(pidAddressedTaskkillFiles().map((file) => file.path))

    expect([...UNGATED_TASKKILL_ALLOWLIST.keys()].filter((path) => !spawning.has(path))).toEqual([])
  })
})
