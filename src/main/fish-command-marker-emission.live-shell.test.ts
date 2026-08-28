/**
 * Real-fish proof that a wrapped fish pane actually emits its private
 * command-start marker.
 *
 * Why a live shell and not the generated-script snapshot: the init text looked
 * correct while every marker was silently suppressed. `set -l` scopes the nonce
 * to the sourced init file, which has already gone out of scope by the time
 * `fish_preexec` fires, so `__orca_command_markers_allowed` saw an empty nonce
 * and returned 1 on every command. Only running fish shows that.
 *
 * `emit fish_preexec` rather than a PTY: the scope question is settled the
 * moment the handler runs, and fish blocks on terminal capability probes that
 * a bare pipe never answers.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import {
  SHELL_COMMAND_NONCE_ENV,
  SHELL_INTEGRATION_CONTEXT_ENV,
  SHELL_INTEGRATION_DIRECT_CONTEXT
} from './shell-command-marker-template'

const FISH_PATH = (() => {
  try {
    return execFileSync('command', ['-v', 'fish'], { encoding: 'utf8', shell: '/bin/bash' }).trim()
  } catch {
    return ''
  }
})()
const itWithFish = FISH_PATH ? it : it.skip

const NONCE = 'live-fish-nonce'
const OSC = '\u001b]'
const BEL = '\u0007'
const MARKER_PREFIX = `${OSC}777;orca-cmd;`

describe('fish private command markers (real fish)', () => {
  let root: string
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-fish-marker-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = root
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(root, { recursive: true, force: true })
  })

  /** The real launch decision, so a pane Orca would not wrap cannot pass here. */
  function buildFishInit(): string {
    const shellPath = FISH_PATH || '/usr/bin/fish'
    const features = selectShellStartupFeatures({
      shellPath,
      env: {},
      hasStartupCommand: true,
      waitsForShellReady: true,
      emitsStartupIdentity: true,
      injectsCommandMarkers: true
    })
    expect(features).toContain('markers')
    const init = getShellLaunchConfig(shellPath, features, { commandNonce: NONCE }).args?.[2]
    expect(typeof init).toBe('string')
    return init as string
  }

  function runPreexec(command: string): string {
    const initPath = join(root, 'init.fish')
    writeFileSync(initPath, buildFishInit(), 'utf8')
    return execFileSync(
      FISH_PATH,
      ['-c', `source ${JSON.stringify(initPath)}; emit fish_preexec ${JSON.stringify(command)}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          [SHELL_COMMAND_NONCE_ENV]: NONCE,
          [SHELL_INTEGRATION_CONTEXT_ENV]: SHELL_INTEGRATION_DIRECT_CONTEXT
        }
      }
    )
  }

  itWithFish('emits one nonce-carrying marker carrying the command it ran', () => {
    const stdout = runPreexec('echo hello-marker')

    // Split rather than match: a control-character regex is banned, and the
    // marker is a fixed OSC 777 payload terminated by BEL.
    const payloads = stdout
      .split(MARKER_PREFIX)
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf(BEL)))
    expect(payloads.length).toBe(1)
    expect(payloads[0].split(';')[0]).toBe(NONCE)
    expect(Buffer.from(payloads[0].split(';')[1], 'base64').toString('utf8')).toBe(
      'echo hello-marker'
    )
  })

  itWithFish('emits the OSC 133 command-start after the private marker', () => {
    const stdout = runPreexec('echo ordering')

    const markerIndex = stdout.indexOf(`${MARKER_PREFIX}${NONCE};`)
    const commandStartIndex = stdout.indexOf(`${OSC}133;C${BEL}`)
    expect(markerIndex).toBeGreaterThanOrEqual(0)
    expect(commandStartIndex).toBeGreaterThan(markerIndex)
  })

  itWithFish('stays silent when the pane carries no nonce', () => {
    const initPath = join(root, 'init.fish')
    writeFileSync(initPath, buildFishInit(), 'utf8')
    const env = {
      ...process.env,
      [SHELL_INTEGRATION_CONTEXT_ENV]: SHELL_INTEGRATION_DIRECT_CONTEXT
    }
    delete env[SHELL_COMMAND_NONCE_ENV]

    const stdout = execFileSync(
      FISH_PATH,
      ['-c', `source ${JSON.stringify(initPath)}; emit fish_preexec "echo quiet"`],
      { encoding: 'utf8', env }
    )

    expect(stdout).not.toContain('orca-cmd')
  })
})
