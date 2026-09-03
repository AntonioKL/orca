import { delimiter, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detectCommandsInInstallDirs } from './local-agent-install-dir-detection'
import { getVersionManagerBinPaths, resolveCliCommands } from './node-cli-command-resolution'
import { buildPosixFallbackPathPrelude } from './posix-version-manager-bin-dirs'

/**
 * The install-dir fallback answers "is this agent CLI installed?" whenever the
 * login-shell PATH probe does not land. Homebrew, npm's default global prefix
 * and opencode's own installer are absolute paths, so they cannot be staged
 * under a temp home -- hence a synthetic fs rather than a fixture tree.
 *
 * Every staged path goes through `join`, because the lookup builds candidates
 * with the host's `join`: a literal `/opt/homebrew/bin/codex` would never match
 * on a Windows dev machine.
 */
const fsFixture = vi.hoisted(() => ({ executables: new Set<string>() }))

const MOCK_HOME = '/home/tester'

vi.mock('node:os', () => ({ homedir: () => MOCK_HOME }))

vi.mock('node:fs', () => ({
  constants: { X_OK: 1 },
  statSync: (target: string) => {
    if (!fsFixture.executables.has(target)) {
      throw new Error(`ENOENT: ${target}`)
    }
    return { isFile: () => true }
  },
  accessSync: (target: string) => {
    if (!fsFixture.executables.has(target)) {
      throw new Error(`EACCES: ${target}`)
    }
  },
  // No nvm install in any of these cases; the nvm walk is covered by nvm-default-alias.test.ts.
  existsSync: () => false,
  readdirSync: () => {
    throw new Error('ENOENT')
  },
  readFileSync: () => {
    throw new Error('ENOENT')
  }
}))

// The PATH a Finder/Dock-launched macOS app inherits with no login shell.
const GUI_LAUNCH_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)

function stage(...paths: string[]): void {
  for (const path of paths) {
    fsFixture.executables.add(path)
  }
}

function resolveAll(
  commands: string[],
  options: { platform: NodeJS.Platform; homePath: string }
): Record<string, string> {
  return Object.fromEntries(
    resolveCliCommands(commands, { ...options, pathEnv: GUI_LAUNCH_PATH })
  ) as Record<string, string>
}

beforeEach(() => {
  fsFixture.executables.clear()
})

describe('agent CLI install-dir fallback', () => {
  it('finds macOS CLIs installed outside a version manager', () => {
    const home = '/Users/tester'
    stage(
      join(home, '.local', 'bin', 'claude'),
      join('/opt/homebrew/bin', 'codex'),
      join('/usr/local/bin', 'cursor-agent'),
      join(home, '.opencode', 'bin', 'opencode')
    )
    expect(
      resolveAll(['claude', 'codex', 'cursor-agent', 'opencode'], {
        platform: 'darwin',
        homePath: home
      })
    ).toEqual({
      claude: join(home, '.local', 'bin', 'claude'),
      codex: join('/opt/homebrew/bin', 'codex'),
      'cursor-agent': join('/usr/local/bin', 'cursor-agent'),
      opencode: join(home, '.opencode', 'bin', 'opencode')
    })
  })

  it('finds Linux CLIs in Linuxbrew, snap and nix prefixes, not the macOS brew prefix', () => {
    const home = '/home/tester'
    stage(
      join('/home/linuxbrew/.linuxbrew/bin', 'codex'),
      join('/snap/bin', 'cursor-agent'),
      join(home, '.nix-profile', 'bin', 'opencode'),
      join('/opt/homebrew/bin', 'claude')
    )
    expect(
      resolveAll(['codex', 'cursor-agent', 'opencode', 'claude'], {
        platform: 'linux',
        homePath: home
      })
    ).toEqual({
      codex: join('/home/linuxbrew/.linuxbrew/bin', 'codex'),
      'cursor-agent': join('/snap/bin', 'cursor-agent'),
      opencode: join(home, '.nix-profile', 'bin', 'opencode'),
      // Why unresolved: /opt/homebrew is an Apple Silicon prefix; Linuxbrew uses another.
      claude: 'claude'
    })
  })

  it('leaves the win32 branch on its own install dirs', () => {
    const home = 'C:/Users/tester'
    stage(join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'), join('/usr/local/bin', 'claude'))
    expect(resolveAll(['codex', 'claude'], { platform: 'win32', homePath: home })).toEqual({
      codex: join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
      claude: 'claude'
    })
  })

  it('still lets a version-manager install outrank a system one', () => {
    const home = '/Users/tester'
    stage(
      join(home, '.volta', 'bin', 'codex'),
      join('/opt/homebrew/bin', 'codex'),
      join('/usr/local/bin', 'codex')
    )
    expect(resolveAll(['codex'], { platform: 'darwin', homePath: home })).toEqual({
      codex: join(home, '.volta', 'bin', 'codex')
    })
  })

  // Why this guard: getVersionManagerBinPaths is PREPENDED onto PATH by
  // patchPackagedProcessPath and the CLI's addAgentNodePaths, so a system dir
  // leaking into it would re-rank binaries the user already has (#18234).
  it('keeps system install dirs out of the PATH seed list', () => {
    const seeded = getVersionManagerBinPaths({ platform: 'darwin', homePath: '/Users/tester' })
    expect(seeded).not.toContain('/opt/homebrew/bin')
    expect(seeded).not.toContain('/usr/local/bin')
  })

  // Why through this entry point: it is what the `orca` CLI's agent detection
  // calls, and the "absolute path means installed" contract lives here.
  it.skipIf(process.platform === 'win32')(
    'reports a system-installed CLI as detected, not just resolved',
    () => {
      stage(join('/usr/local/bin', 'codex'), join(MOCK_HOME, '.opencode', 'bin', 'opencode'))
      expect(detectCommandsInInstallDirs(['codex', 'opencode', 'cursor-agent'])).toEqual(
        new Set(['codex', 'opencode'])
      )
    }
  )

  it('carries the system install dirs into the POSIX guest fallback prelude', () => {
    const prelude = buildPosixFallbackPathPrelude()
    for (const dir of [
      '"$HOME/.opencode/bin"',
      '"$HOME/.nix-profile/bin"',
      '"/home/linuxbrew/.linuxbrew/bin"',
      '"/snap/bin"',
      '"/nix/var/nix/profiles/default/bin"'
    ]) {
      expect(prelude).toContain(dir)
    }
    // Why absent: a WSL guest is Linux, so /opt/homebrew is never its brew prefix.
    expect(prelude).not.toContain('/opt/homebrew')
  })
})
