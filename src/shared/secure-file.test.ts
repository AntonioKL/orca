import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, runProcessSync } from './child-process/run-process'
import {
  __getSecureFileHardeningCacheStateForTests,
  __resetSecureFileHardenedPathsForTests,
  __resetSecureFileWindowsUserSidForTests,
  hardenExistingSecureFile,
  hardenSecurePath,
  writeSecureFile
} from './secure-file'

const posixModeIt = process.platform === 'win32' ? it.skip : it

vi.mock('./child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

type FakeSpec = { program: string; args?: readonly string[] }

// Rights handed to the last /grant:r pass per path, so the verify pass can echo a matching readback.
const grantedRights = new Map<string, string>()

/**
 * Stands in for icacls across all three passes. The verify pass has to answer with a real-shaped
 * `icacls <path>` readback or every harden would report failure, so this models the format.
 */
function fakeIcacls(spec: FakeSpec): typeof OK {
  const args = spec.args ?? []
  const path = args[0] ?? ''
  const grantIndex = args.indexOf('/grant:r')
  if (grantIndex !== -1) {
    const grant = args[grantIndex + 1]!
    grantedRights.set(path, grant.slice(grant.lastIndexOf(':(') + 1))
    return OK
  }
  if (args.length > 1) {
    return OK // /reset
  }
  const rights = grantedRights.get(path) ?? '(F)'
  const principals = ['host\\me', 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators']
  const aceLines = principals.map((name, index) =>
    index === 0 ? `${path} ${name}:${rights}` : `      ${name}:${rights}`
  )
  return {
    ...OK,
    stdout: `${aceLines.join('\r\n')}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`
  }
}

describe('hardenSecurePath', () => {
  const originalSystemRoot = process.env.SystemRoot
  const originalWindir = process.env.WINDIR
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const tempDirs: string[] = []

  beforeEach(() => {
    process.env.SystemRoot = 'C:\\Windows'
    delete process.env.WINDIR
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
    vi.mocked(runProcessSync).mockReset()
    vi.mocked(runProcess).mockReset()
    grantedRights.clear()
    // runProcessSync serves whoami.exe (SID lookup) and the SYNCHRONOUS icacls file-ACL path
    // used by writeSecureFile. Directory + read-path re-hardens use async runProcess.
    vi.mocked(runProcessSync).mockImplementation((spec) => {
      if (spec.program === 'C:\\Windows\\System32\\whoami.exe') {
        return { ...OK, stdout: '"USER","S-1-5-21-1000"' }
      }
      return fakeIcacls(spec)
    })
    vi.mocked(runProcess).mockImplementation((spec) => Promise.resolve(fakeIcacls(spec)))
  })

  afterEach(() => {
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot
    } else {
      process.env.SystemRoot = originalSystemRoot
    }
    if (originalWindir === undefined) {
      delete process.env.WINDIR
    } else {
      process.env.WINDIR = originalWindir
    }
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rewrites Windows ACLs through icacls, purging explicit ACEs before granting', async () => {
    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })
    await flushAsyncAcl()

    // whoami.exe called synchronously to obtain SID
    expect(vi.mocked(runProcessSync).mock.calls[0]![0]).toMatchObject({
      program: 'C:\\Windows\\System32\\whoami.exe',
      args: ['/user', '/fo', 'csv', '/nh']
    })

    const specs = vi.mocked(runProcess).mock.calls.map(([spec]) => spec)
    expect(specs.map((spec) => spec.program)).toEqual([
      'C:\\Windows\\System32\\icacls.exe',
      'C:\\Windows\\System32\\icacls.exe',
      'C:\\Windows\\System32\\icacls.exe'
    ])
    expect(specs[0]!.args).toEqual(['C:\\Users\\me\\.orca\\secret.json', '/reset', '/q'])
    expect(specs[1]!.args).toEqual([
      'C:\\Users\\me\\.orca\\secret.json',
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-21-1000:(F)',
      '/grant:r',
      '*S-1-5-18:(F)',
      '/grant:r',
      '*S-1-5-32-544:(F)',
      '/q'
    ])
    // The apply is read back: a loosened ACL has to be detectable, not just overwritten.
    expect(specs[2]!.args).toEqual(['C:\\Users\\me\\.orca\\secret.json'])
    expect(specs[1]!.timeoutMs).toBe(5000)
  })

  it('reports failure when the applied ACL does not read back as expected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(runProcess).mockImplementation((spec) => {
      if ((spec.args ?? []).length === 1) {
        // An inherited ACE survived: the DACL was never protected — the shipped failure mode.
        return Promise.resolve({
          ...OK,
          stdout: `${spec.args![0]} host\\me:(I)(F)\r\n\r\nSuccessfully processed 1 files\r\n`
        })
      }
      return Promise.resolve(OK)
    })

    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })
    await flushAsyncAcl()

    expect(warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({ stage: 'verify' })
    )
    warn.mockRestore()
  })

  // The async branch cannot return its outcome, so a failed apply must not stay cached as success.
  it('re-hardens on the next read when an async apply failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')
    vi.mocked(runProcess).mockResolvedValue({ ...OK, code: 5, stderr: 'Access is denied.' })

    hardenExistingSecureFile(targetPath)
    await flushAsyncAcl()
    hardenExistingSecureFile(targetPath)
    await flushAsyncAcl()

    // Both the directory and the file are retried rather than trusted from the failed first pass.
    expect(getHardenAclCalls().map(getAclTarget)).toEqual([
      userDataPath,
      targetPath,
      userDataPath,
      targetPath
    ])
    warn.mockRestore()
  })

  // /c makes icacls exit 0 while printing "Failed processing 1 files" — a silent no-op by another route.
  it('never passes the icacls /c continue-on-error flag', async () => {
    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })
    await flushAsyncAcl()

    for (const [spec] of vi.mocked(runProcess).mock.calls) {
      expect(spec.args).not.toContain('/c')
    }
  })

  it('adds inheritable rules when hardening a Windows directory', async () => {
    hardenSecurePath('C:\\Users\\me\\.orca', { isDirectory: true, platform: 'win32' })
    await flushAsyncAcl()

    const grantArgs = vi.mocked(runProcess).mock.calls[1]![0].args as string[]
    expect(grantArgs).toContain('*S-1-5-21-1000:(OI)(CI)(F)')
    expect(grantArgs).toContain('*S-1-5-18:(OI)(CI)(F)')
  })

  it('keeps Windows hardening best-effort when ACL rewriting fails', async () => {
    vi.mocked(runProcess).mockRejectedValue(new Error('access denied'))

    expect(() =>
      hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
        isDirectory: false,
        platform: 'win32'
      })
    ).not.toThrow()
    await expect(flushAsyncAcl()).resolves.toBeUndefined()
  })

  // The old PowerShell command line never reached the grant step at all, so a failure had to be
  // visible somewhere; "best effort" may not mean "undetectable".
  it('logs when a Windows ACL apply fails instead of swallowing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(runProcess).mockResolvedValue({ ...OK, code: 5, stderr: 'Access is denied.' })

    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })
    await flushAsyncAcl()

    expect(warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({
        targetPath: 'C:\\Users\\me\\.orca\\secret.json',
        stage: 'reset',
        detail: 'Access is denied.'
      })
    )
    warn.mockRestore()
  })

  it('reports a failed synchronous ACL apply to the caller and the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.mocked(runProcessSync).mockImplementation((spec) => {
      if (spec.program === 'C:\\Windows\\System32\\whoami.exe') {
        return { ...OK, stdout: '"USER","S-1-5-21-1000"' }
      }
      return { ...OK, code: 5, stderr: 'Access is denied.' }
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)

    writeSecureFile(join(userDataPath, 'secret.json'), 'contents')

    expect(warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({ stage: 'reset', detail: 'Access is denied.' })
    )
    warn.mockRestore()
  })

  // Paths past MAX_PATH make icacls report "cannot find the path specified"; the extended prefix is the escape.
  it('uses the extended-length prefix for paths past MAX_PATH', async () => {
    const longPath = `C:\\Users\\me\\.orca\\${'d'.repeat(300)}\\secret.json`
    hardenSecurePath(longPath, { isDirectory: false, platform: 'win32' })
    await flushAsyncAcl()

    for (const [spec] of vi.mocked(runProcess).mock.calls) {
      expect(spec.args![0]).toBe(`\\\\?\\${longPath}`)
    }
  })

  it('caches successful existing-file hardening within a process', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

    // dir hardened once (path-cached), file hardened once (metadata-cached) — 2 total
    expect(getHardenAclCalls()).toHaveLength(2)
    expect(getHardenAclCalls().map(getAclTarget)).toEqual([userDataPath, targetPath])
  })

  it('LRU-evicts Windows file hardening entries and safely re-hardens an evicted path', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __resetSecureFileHardenedPathsForTests({
      maxEntries: 2,
      maxKeyBytes: 4096,
      maxTotalKeyBytes: 8192
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const paths = ['first.json', 'second.json', 'third.json'].map((name) =>
      join(userDataPath, name)
    )
    for (const path of paths) {
      writeFileSync(path, '{}')
      hardenExistingSecureFile(path)
    }

    hardenExistingSecureFile(paths[0]!)

    const fileTargets = getHardenAclCalls()
      .map(getAclTarget)
      .filter((path) => paths.includes(path))
    expect(fileTargets).toEqual([...paths, paths[0]])
    expect(__getSecureFileHardeningCacheStateForTests().paths).toMatchObject({
      entries: 2
    })
  })

  it('LRU-evicts Windows directory hardening entries instead of retaining every path', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __resetSecureFileHardenedPathsForTests({
      maxEntries: 2,
      maxKeyBytes: 4096,
      maxTotalKeyBytes: 8192
    })
    const root = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(root)
    const directories = ['first', 'second', 'third'].map((name) => join(root, name))
    const files = directories.map((dir) => {
      mkdirSync(dir)
      const file = join(dir, 'secret.json')
      writeFileSync(file, '{}')
      return file
    })
    for (const file of files) {
      hardenExistingSecureFile(file)
    }

    hardenExistingSecureFile(files[0]!)

    const directoryTargets = getHardenAclCalls()
      .map(getAclTarget)
      .filter((path) => directories.includes(path))
    expect(directoryTargets).toEqual([...directories, directories[0]])
    expect(__getSecureFileHardeningCacheStateForTests().directories).toMatchObject({
      entries: 2
    })
  })

  it('re-hardens an existing file when its metadata changes after caching', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    await waitForFileTimestampTick()
    writeFileSync(targetPath, '{"changed":true}')
    hardenExistingSecureFile(targetPath)

    // call 1: dir + file. call 2: dir skipped (path-cached), file re-hardened (new mtime)
    expect(getHardenAclCalls()).toHaveLength(3)
    expect(getHardenAclCalls().map(getAclTarget)).toEqual([
      userDataPath,
      targetPath,
      targetPath
    ])
  })

  it('keeps post-rename target hardening on every write while caching the directory', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'first')
    writeSecureFile(targetPath, 'second')

    // The DIRECTORY is hardened async + path-cached: exactly once across both writes.
    const asyncTargets = getHardenAclCalls().map(getAclTarget)
    expect(asyncTargets).toEqual([userDataPath])

    // The credential FILES (tmpFile + renamed target) are hardened SYNCHRONOUSLY on each write.
    // write 1: tmpFile(1) + targetFile(1) = 2; write 2: tmpFile(1) + targetFile(1) = 2; total 4.
    const syncTargets = getSyncHardenAclCalls().map(getAclTarget)
    expect(syncTargets).toHaveLength(4)
    expect(syncTargets.filter((entry) => entry === targetPath)).toHaveLength(2)
    // No directory should be hardened via the synchronous path.
    expect(syncTargets.filter((entry) => entry === userDataPath)).toHaveLength(0)
  })

  // Regression test: #4901 — env-store reads at ~2×/s caused an ACL-spawn storm because the
  // parent directory mtime churned (every secure write updates it), so the mtime-keyed cache
  // never matched. Directories must be path-cached for the process lifetime.
  it('does not re-harden the parent directory when its mtime changes between reads', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    // Simulate the env-store read loop: hardenExistingSecureFile called many times while
    // another part of Orca writes to the same directory (changing its mtime).
    hardenExistingSecureFile(targetPath)
    await waitForFileTimestampTick()
    // Simulate a write to another file in the same dir (changes dir mtime)
    writeFileSync(join(userDataPath, 'other.json'), '{}')
    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

    // The parent directory must be hardened exactly ONCE despite its mtime changing
    const dirCalls = getHardenAclCalls().filter(
      (call) => getAclTarget(call) === userDataPath
    )
    expect(dirCalls).toHaveLength(1)
  })

  it('does not re-harden an unchanged file on repeated reads', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)
    hardenExistingSecureFile(targetPath)

    const fileCalls = getHardenAclCalls().filter(
      (call) => getAclTarget(call) === targetPath
    )
    expect(fileCalls).toHaveLength(1)
  })

  it('applies the read-path ACL asynchronously without blocking (async runProcess)', () => {
    hardenSecurePath('C:\\Users\\me\\.orca\\secret.json', {
      isDirectory: false,
      platform: 'win32'
    })

    // The default (read/dir) path must launch icacls via runProcess (async), never sync.
    expect(getSyncHardenAclCalls()).toHaveLength(0)
    expect(getHardenAclCalls()).toHaveLength(1)
  })

  // Security regression guard (#5006 review finding): writeSecureFile must restrict the
  // credential FILE's ACL SYNCHRONOUSLY before returning. On Windows writeFileSync({mode})
  // is a no-op, so an async file ACL would leave the credential briefly readable under the
  // parent's inherited (broader) ACL for the duration of the spawn.
  it('hardens the credential file synchronously while keeping the directory async', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'contents')

    // Directory: async only.
    expect(getHardenAclCalls().map(getAclTarget)).toEqual([userDataPath])
    // File (tmpFile + renamed target): synchronous only — no async file ACL window.
    const syncTargets = getSyncHardenAclCalls().map(getAclTarget)
    expect(syncTargets).toContain(targetPath)
    expect(syncTargets.filter((entry) => entry === userDataPath)).toHaveLength(0)
    // The final published target's ACL must have been applied via the synchronous path.
    expect(getHardenAclCalls().map(getAclTarget)).not.toContain(targetPath)
  })

  // Nit #1 (review): the synchronous file path must cache as hardened ONLY on confirmed
  // success, so a failed ACL apply is retried on the next write instead of being silently
  // trusted.
  it('retries the credential-file ACL on the next write when the sync apply fails', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    // First write: the synchronous icacls ACL apply throws for every icacls call.
    vi.mocked(runProcessSync).mockImplementation((spec) => {
      if (spec.program === 'C:\\Windows\\System32\\whoami.exe') {
        return { ...OK, stdout: '"USER","S-1-5-21-1000"' }
      }
      throw new Error('access denied')
    })
    expect(() => writeSecureFile(targetPath, 'first')).not.toThrow()
    const firstWriteTargetCalls = getSyncHardenAclCalls()
      .map(getAclTarget)
      .filter((entry) => entry === targetPath)
    expect(firstWriteTargetCalls).toHaveLength(1)

    // Second write: ACL apply now succeeds. Because the failed apply was NOT cached, the
    // target file is hardened again rather than skipped.
    vi.mocked(runProcessSync).mockImplementation((spec) => {
      if (spec.program === 'C:\\Windows\\System32\\whoami.exe') {
        return { ...OK, stdout: '"USER","S-1-5-21-1000"' }
      }
      return OK
    })
    writeSecureFile(targetPath, 'second')
    const allTargetCalls = getSyncHardenAclCalls()
      .map(getAclTarget)
      .filter((entry) => entry === targetPath)
    expect(allTargetCalls).toHaveLength(2)
  })

  // Nit #2 (review) / hardening: the process-lifetime directory cache hardens a directory
  // exactly once even when its mtime churns across many writes (the #4901 storm condition,
  // exercised through the write path rather than the read path).
  it('hardens the directory exactly once across many writes despite mtime churn', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)

    for (let i = 0; i < 5; i++) {
      // Each write changes the directory's mtime (a new file lands in it).
      writeSecureFile(join(userDataPath, `secret-${i}.json`), `contents-${i}`)
    }

    const dirCalls = getHardenAclCalls().filter(
      (call) => getAclTarget(call) === userDataPath
    )
    expect(dirCalls).toHaveLength(1)
  })

  // win32-only guard: on non-win32 platforms no icacls is ever spawned (sync or async);
  // POSIX hardening uses chmodSync only.
  it('never spawns icacls on non-win32 platforms', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')

    writeSecureFile(targetPath, 'contents')
    hardenExistingSecureFile(targetPath)

    expect(getHardenAclCalls()).toHaveLength(0)
    expect(getSyncHardenAclCalls()).toHaveLength(0)
  })

  posixModeIt('re-hardens a POSIX directory when its metadata changes after caching', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    expect(statMode(userDataPath)).toBe(0o700)

    chmodSync(userDataPath, 0o755)
    hardenExistingSecureFile(targetPath)

    expect(statMode(userDataPath)).toBe(0o700)
  })

  posixModeIt('LRU-bounds POSIX hardening entries while keeping recent paths cached', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    __resetSecureFileHardenedPathsForTests({
      maxEntries: 2,
      maxKeyBytes: 4096,
      maxTotalKeyBytes: 8192
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(userDataPath)
    const firstPath = join(userDataPath, 'first.json')
    const secondPath = join(userDataPath, 'second.json')
    writeFileSync(firstPath, '{}')
    writeFileSync(secondPath, '{}')

    hardenExistingSecureFile(firstPath)
    hardenExistingSecureFile(secondPath)
    expect(__getSecureFileHardeningCacheStateForTests().paths.paths).toEqual([
      userDataPath,
      secondPath
    ])

    hardenExistingSecureFile(firstPath)
    expect(__getSecureFileHardeningCacheStateForTests().paths.paths).toEqual([
      userDataPath,
      firstPath
    ])
  })
})

// Each harden is two icacls passes (/reset then /inheritance:r + grants); counting the /reset
// pass keeps "one harden = one entry" and stays observable synchronously on the async path.
function isAclResetSpec(spec: { program: string; args?: readonly string[] }): boolean {
  return spec.program.endsWith('icacls.exe') && (spec.args?.includes('/reset') ?? false)
}

// Async icacls calls (directory hardening + read-path file re-harden).
function getHardenAclCalls(): { args?: readonly string[] }[] {
  return vi
    .mocked(runProcess)
    .mock.calls.map(([spec]) => spec)
    .filter(isAclResetSpec)
}

// Synchronous icacls calls (credential-file ACL on the write path).
function getSyncHardenAclCalls(): { args?: readonly string[] }[] {
  return vi
    .mocked(runProcessSync)
    .mock.calls.map(([spec]) => spec)
    .filter(isAclResetSpec)
}

function getAclTarget(spec: { args?: readonly string[] }): string {
  return spec.args![0]!
}

// The async harden awaits three icacls passes, so let the chain settle before asserting on it.
async function flushAsyncAcl(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function waitForFileTimestampTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}
