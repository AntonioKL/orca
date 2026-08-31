/**
 * Real-zsh proof that command markers carry zsh's expanded preexec command.
 *
 * zsh calls preexec with three forms of a command line: the typed text first,
 * followed by progressively expanded forms. Alias launches therefore need the
 * third argument or the marker names the alias instead of the real agent.
 */
import { rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import { SHELL_COMMAND_MAX_CHARS } from './shell-command-marker-template'
import { hasZsh, makeZshHome, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip
const NONCE = 'zsh-command-marker-test'
const OSC_COMMAND_PREFIX = `${String.fromCharCode(27)}]777;orca-cmd;${NONCE};`
const BEL = String.fromCharCode(7)

function decodeCommandMarkers(output: string): string[] {
  return output
    .split(OSC_COMMAND_PREFIX)
    .slice(1)
    .map((rest) => {
      const encoded = rest.slice(0, rest.indexOf(BEL))
      return Buffer.from(encoded, 'base64').toString('utf8')
    })
}

function launchEnv(home: string): Record<string, string> {
  const features = selectShellStartupFeatures({
    shellPath: ZSH_PATH,
    env: { HOME: home },
    hasStartupCommand: false,
    waitsForShellReady: false,
    emitsStartupIdentity: false,
    injectsCommandMarkers: true
  })
  expect(features).toContain('markers')
  const launch = getShellLaunchConfig(ZSH_PATH, features, { commandNonce: NONCE })
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    ...launch.env,
    // The launch config resolves this from the test process environment.
    ORCA_ORIG_ZDOTDIR: home
  }
}

describe.skipIf(process.platform === 'win32')('zsh command markers (real zsh)', () => {
  itWithZsh('names the resolved command for an aliased agent launch', async () => {
    const home = makeZshHome({ '.zshrc': 'alias cc=claude\n' })
    try {
      const { output } = await runZshPty({ env: launchEnv(home), commands: ['cc --version'] })

      expect(decodeCommandMarkers(output)).toContain('claude --version')
      expect(decodeCommandMarkers(output)).not.toContain('cc --version')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  itWithZsh('keeps a non-alias command unchanged and tolerates a user preexec hook', async () => {
    const home = makeZshHome({
      '.zshrc': 'preexec_functions=(user_preexec)\nuser_preexec() { : "$1"; }\n'
    })
    try {
      const { output } = await runZshPty({
        env: launchEnv(home),
        commands: ['claude --version']
      })

      expect(decodeCommandMarkers(output)).toContain('claude --version')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  itWithZsh('falls back safely when preexec receives fewer than three arguments', async () => {
    const home = makeZshHome({ '.zshrc': '' })
    try {
      const { output } = await runZshPty({
        env: launchEnv(home),
        commands: [
          `preexec_functions=(); __orca_osc133_preexec one-arg; __orca_osc133_preexec two-typed two-expanded; __orca_osc133_preexec; __orca_osc133_preexec ${JSON.stringify('x'.repeat(SHELL_COMMAND_MAX_CHARS + 10))}`
        ]
      })
      const markers = decodeCommandMarkers(output)

      expect(markers).toContain('one-arg')
      expect(markers).toContain('two-expanded')
      expect(markers).not.toContain('')
      expect(markers).toContain('x'.repeat(SHELL_COMMAND_MAX_CHARS))
      expect(markers.every((marker) => marker.length <= SHELL_COMMAND_MAX_CHARS)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
