import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildNodePtyLoadProbeScript,
  checkNodePtyPrecondition,
  classifyNodePtyProbeResult,
  formatNodePtyPreconditionReport,
  probeLocalBuildToolchainHints
} from './node-pty-precondition'
import { detectNativeHostAbi } from './native-host-abi'

const require = createRequire(import.meta.url)
const REAL_NODE_PTY = dirname(require.resolve('node-pty/package.json'))

const probe = (overrides: Partial<Parameters<typeof classifyNodePtyProbeResult>[0]> = {}) =>
  classifyNodePtyProbeResult({
    code: 1,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  })

const reported = (message: string) =>
  classifyNodePtyProbeResult({
    code: 4,
    signal: null,
    stdout: `ORCA_NODE_PTY_LOAD_ERROR ${JSON.stringify(message)}\n`,
    stderr: '',
    timedOut: false
  })

describe('classifyNodePtyProbeResult', () => {
  it('accepts only a clean exit that printed the token', () => {
    expect(probe({ code: 0, stdout: 'ORCA_NODE_PTY_LOAD_OK /x/build/Release' })).toBeNull()
    // A zero exit with no token means the probe never reached the load.
    expect(probe({ code: 0, stdout: '' })?.reason).toBe('load_failed')
  })

  it('names the glibc floor for the #9902 loader message', () => {
    expect(
      reported(
        "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by /app/node_modules/node-pty/build/Release/pty.node)"
      )
    ).toEqual({
      status: 'blocked',
      reason: 'libc_floor',
      detail: 'the binary requires GLIBC_2.34'
    })
  })

  it('names a libstdc++ floor break too', () => {
    expect(reported("version `GLIBCXX_3.4.29' not found")?.reason).toBe('libc_floor')
  })

  it('separates a Node ABI mismatch from a libc mismatch', () => {
    // These need different fixes — rebuild against this Node vs. build on an older libc —
    // so collapsing them sends the operator to the wrong one.
    expect(
      reported(
        'was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127.'
      )
    ).toEqual({
      status: 'blocked',
      reason: 'abi_mismatch',
      detail: 'built for Node ABI 115, this host runs ABI 127'
    })
  })

  it('reports a signalled probe as a crash, even with no output at all', () => {
    // The uncatchable case: a binary that aborts inside the loader never reaches the
    // child's catch and often prints nothing.
    expect(probe({ code: null, signal: 'SIGSEGV' })).toEqual({
      status: 'blocked',
      reason: 'load_crashed',
      detail: 'the load probe was killed by SIGSEGV'
    })
  })

  it('distinguishes no binary anywhere from a binary the loader refused', () => {
    // "install node-pty" and "rebuild node-pty for this libc" are different instructions.
    expect(probe({ code: 3, stdout: 'ORCA_NODE_PTY_NO_BINARY\n' })).toEqual({
      status: 'blocked',
      reason: 'dependency_missing',
      detail: 'node-pty is installed but has no compiled binary for this platform'
    })
    expect(reported('dlopen(...): slice is not valid mach-o file')?.reason).toBe('load_failed')
  })

  it('ignores its own token strings echoed back inside the child stderr', () => {
    // node prints the whole `-e` source above the stack trace, and that source contains
    // every token below. Matching on stderr made a refused binary read as "not installed".
    const echoedSource =
      '[eval]:1\nif(!f){console.log("ORCA_NODE_PTY_NO_BINARY");process.exit(3)}\n' +
      '        ^\n\nError: dlopen(/app/pty.node): slice is not valid mach-o file\n'

    expect(
      classifyNodePtyProbeResult({
        code: 4,
        signal: null,
        stdout: `ORCA_NODE_PTY_LOAD_ERROR ${JSON.stringify('dlopen(/app/pty.node): slice is not valid mach-o file')}`,
        stderr: echoedSource,
        timedOut: false
      })
    ).toMatchObject({ reason: 'load_failed' })
  })

  it('reads past node\u2019s echoed source line when it can only use stderr', () => {
    const failure = probe({
      stderr:
        '[eval]:1\nprocess.dlopen({exports:{}},f);\n        ^\n\nError: something specific went wrong\n'
    })
    expect(failure?.detail).toBe('Error: something specific went wrong')
  })

  it('calls a timeout unverifiable rather than blocked', () => {
    // A probe that never answered is not evidence that node-pty is broken, and refusing
    // to boot on it would take down hosts that work.
    expect(probe({ timedOut: true })).toEqual({
      status: 'unverifiable',
      reason: 'unknown',
      detail: 'the node-pty load probe did not finish in time, so nothing was established'
    })
  })
})

describe('buildNodePtyLoadProbeScript', () => {
  it('loads through absolute paths so the child cannot resolve a different copy', () => {
    const script = buildNodePtyLoadProbeScript('/opt/app/node_modules/node-pty')
    expect(script).toContain('"/opt/app/node_modules/node-pty/lib/index.js"')
    expect(script).toContain('"/opt/app/node_modules/node-pty/lib/utils.js"')
    expect(script).toContain('loadNativeModule')
    // Windows defers conpty.node to first spawn, so requiring the package proves nothing there.
    expect(script).toContain('conpty')
    // The raw dlopen must precede requiring the package, or node-pty's own loader
    // re-wraps the loader error into a misleading "Cannot find module".
    expect(script.indexOf('process.dlopen')).toBeLessThan(script.indexOf('lib/index.js'))
  })
})

describe('checkNodePtyPrecondition', () => {
  const temporaryDirs: string[] = []
  const stageNodePty = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-node-pty-'))
    temporaryDirs.push(root)
    const dir = join(root, 'node-pty')
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true })
    cpSync(join(REAL_NODE_PTY, 'lib'), join(dir, 'lib'), { recursive: true })
    cpSync(join(REAL_NODE_PTY, 'package.json'), join(dir, 'package.json'))
    return dir
  }

  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a native binary that the dynamic loader refuses', () => {
    // The whole reason the probe is a child process: this file is loaded with dlopen, and
    // an in-process require of it can take the host down before any handler runs. Reaching
    // the assertion below at all is the evidence.
    const dir = stageNodePty()
    writeFileSync(join(dir, 'build', 'Release', 'pty.node'), Buffer.from('not a native addon'))

    const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir: null })

    expect(verdict.status).toBe('blocked')
    expect(verdict.reason).toBeDefined()
    expect(verdict.reason).not.toBe('spawn_helper_missing')
  })

  it('blocks when node-pty is not resolvable at all', () => {
    const verdict = checkNodePtyPrecondition({ nodePtyDir: null, prebuildsDir: null })
    expect(verdict).toMatchObject({ status: 'blocked', reason: 'dependency_missing' })
  })

  it('agrees with whether node-pty actually loads on this host', () => {
    // Why compared against ground truth rather than asserted as 'ok': CI's test shard
    // runs `vitest` directly, so `ensure-native-runtime --runtime=node` never prepares
    // node-pty for the Node ABI and `degraded` is the CORRECT verdict there. Asserting
    // 'ok' encoded a prepared environment the shard does not have. Asserting "whatever
    // it said" would be vacuous, so this pins the verdict to an independent check.
    let loads = true
    try {
      createRequire(import.meta.url)('node-pty')
    } catch {
      loads = false
    }

    const verdict = checkNodePtyPrecondition({ prebuildsDir: null })
    expect(verdict.status).toBe(loads ? 'ok' : 'degraded')
    expect(verdict.slot).toBe(
      process.platform === 'linux'
        ? `linux-${process.arch}-${verdict.abi.libc}`
        : `${process.platform}-${process.arch}`
    )
  })

  it.runIf(process.platform !== 'win32')(
    'degrades rather than blocks when only spawn-helper is missing',
    () => {
      // node-pty posix_spawns spawn-helper, so this host loads fine and then fails ENOENT
      // the first time someone opens a terminal. Everything else it serves still works.
      const dir = stageNodePty()
      cpSync(
        join(REAL_NODE_PTY, 'build', 'Release', 'pty.node'),
        join(dir, 'build', 'Release', 'pty.node')
      )

      const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir: null })

      expect(verdict).toMatchObject({ status: 'degraded', reason: 'spawn_helper_missing' })
    }
  )

  it('installs the matching shipped prebuilt slot when nothing is compiled', () => {
    const dir = stageNodePty()
    const abi = detectNativeHostAbi()
    const slot =
      abi.libc === 'none'
        ? `${abi.platform}-${abi.arch}`
        : `${abi.platform}-${abi.arch}-${abi.libc}`
    const prebuildsDir = mkdtempSync(join(tmpdir(), 'orcad-prebuilds-'))
    temporaryDirs.push(prebuildsDir)
    mkdirSync(join(prebuildsDir, slot), { recursive: true })
    cpSync(
      join(REAL_NODE_PTY, 'build', 'Release', 'pty.node'),
      join(prebuildsDir, slot, 'pty.node')
    )
    if (process.platform !== 'win32') {
      cpSync(
        join(REAL_NODE_PTY, 'build', 'Release', 'spawn-helper'),
        join(prebuildsDir, slot, 'spawn-helper')
      )
    }

    const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir })

    expect(verdict.prebuilt).toMatchObject({ installed: true, slot })
    expect(verdict.status).toBe('ok')
  })
})

describe('formatNodePtyPreconditionReport', () => {
  it('names the host, the slot and the action', () => {
    const report = formatNodePtyPreconditionReport(
      {
        status: 'blocked',
        slot: 'linux-x64-musl',
        abi: {
          platform: 'linux',
          arch: 'x64',
          libc: 'musl',
          glibcVersion: null,
          nodeAbi: '127'
        },
        reason: 'dependency_missing',
        prebuilt: { installed: false, slot: 'linux-x64-musl', why: 'no-slot' }
      },
      'Terminals are unavailable on this host.',
      ['  sudo apk add build-base python3']
    )

    expect(report).toContain('platform linux/x64')
    expect(report).toContain('libc musl')
    expect(report).toContain('prebuild slot linux-x64-musl')
    expect(report).toContain('No shipped prebuilt matches slot linux-x64-musl.')
    expect(report).toContain('sudo apk add build-base python3')
  })
})

describe('probeLocalBuildToolchainHints', () => {
  it('gives macOS the Xcode command line tools, not a Linux package manager', () => {
    // The relay's hint list answers with a cross-distro apt/dnf/pacman/apk menu when it
    // finds no package manager. On macOS every line of that menu is wrong.
    const hints = probeLocalBuildToolchainHints('darwin')
    expect(hints).toEqual(['  xcode-select --install'])
    expect(hints.join('\n')).not.toMatch(/apt-get|dnf|pacman|apk/)
  })

  it('says nothing on Windows, where node-pty ships prebuilds', () => {
    expect(probeLocalBuildToolchainHints('win32')).toEqual([])
  })

  it.runIf(process.platform === 'linux')('reuses the relay diagnosis on Linux', () => {
    expect(probeLocalBuildToolchainHints('linux').length).toBeGreaterThan(0)
  })
})
