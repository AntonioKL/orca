import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { _internals } from './legacy-wsl-runtime-auth-drain'

const isWindows = process.platform === 'win32'

const SOURCE_AUTH = '{"tokens":{"expires_at":2000}}\n'
const TARGET_AUTH = '{"tokens":{"expires_at":1000}}\n'
const NEWER_AUTH = '{"tokens":{"expires_at":3000}}\n'
// Codex truncates before it writes, so a read landing mid-rotation sees this.
const TORN_AUTH = '{"tokens":{"exp'
const SOURCE_CREDENTIALS = '{"server":{"access_token":"source"}}\n'
const TORN_CREDENTIALS = '{"server":'
const RETIRED_SESSION = '{"session":"retired"}\n'
const RETIRED_SESSION_SEGMENTS = ['sessions', '2026', '08', '26', 'retired.jsonl']

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

/**
 * Runs the real guest script under `sh`, with `sha256sum` shimmed so a chosen
 * hash call can rewrite the source underneath the script. That is the only way
 * to land Codex's in-place rotation inside the window the script itself opens.
 */
function runApplyScript(
  options: {
    crossFilesystemBridge?: boolean
    deleteSource?: boolean
    killAfterDestinationInstall?: boolean
    killBeforeDestinationRecoveryLink?: boolean
    killAfterSessionLink?: boolean
    killAfterSourceRemoval?: boolean
    killDuringSessionCommit?: boolean
    promoteAuth?: boolean
    replaceTargetAfterSessionLink?: boolean
    replaceTargetBeforeRecovery?: boolean
    rewriteAfterHashCall?: number
    rewriteBytes?: string
    rewriteQuarantineAfterSessionLink?: boolean
    rewriteQuarantineBeforeRecovery?: boolean
    rewriteSourceAfterSessionLink?: boolean
    rewriteTargetAfterSessionLink?: boolean
    rewriteTarget?: 'source-auth' | 'source-credentials' | 'target-auth'
    sourceAuthSymlink?: boolean
    sourceSession?: string
    sourceCredentials?: string
  } = {}
): {
  legacyAuth: string | null
  markerExists: boolean
  status: number
  targetAuth: string
  targetCredentials: string | null
  targetMode: number
  targetSession: string | null
  sourceQuarantineAuth: string | null
  sourceRecoveryAuth: string | null
  destinationRecoveryAuth: string | null
  destinationRecoveryPathExists: boolean
  sessionCommitMarkerExists: boolean
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-drain-apply-'))
  const legacyHome = join(root, 'legacy')
  const targetHome = join(root, 'account')
  const binDir = join(root, 'bin')
  for (const dir of [legacyHome, targetHome, binDir]) {
    mkdirSync(dir, { recursive: true })
  }
  const legacyAuthPath = join(legacyHome, 'auth.json')
  const targetAuthPath = join(targetHome, 'auth.json')
  const legacyCredentialsPath = join(legacyHome, '.credentials.json')
  const targetCredentialsPath = join(targetHome, '.credentials.json')
  const markerPath = join(root, 'drain-marker.json')
  writeFileSync(legacyAuthPath, SOURCE_AUTH)
  writeFileSync(targetAuthPath, TARGET_AUTH)
  if (options.sourceAuthSymlink) {
    const sourceAuthTarget = join(root, 'linked-source-auth.json')
    renameSync(legacyAuthPath, sourceAuthTarget)
    symlinkSync(sourceAuthTarget, legacyAuthPath)
  }
  if (options.sourceCredentials !== undefined) {
    writeFileSync(legacyCredentialsPath, options.sourceCredentials)
  }
  if (options.sourceSession !== undefined) {
    const sessionPath = join(legacyHome, ...RETIRED_SESSION_SEGMENTS)
    mkdirSync(join(sessionPath, '..'), { recursive: true })
    writeFileSync(sessionPath, options.sourceSession)
  }

  const counterPath = join(root, 'hash-calls')
  writeFileSync(counterPath, '0')
  const shimPath = join(binDir, 'sha256sum')
  writeFileSync(
    shimPath,
    `#!/usr/bin/env node
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const file = process.argv[process.argv.length - 1]
process.stdout.write(
  createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + file + '\\n'
)
const calls = Number(fs.readFileSync(process.env.HASH_COUNTER, 'utf8')) + 1
fs.writeFileSync(process.env.HASH_COUNTER, String(calls))
if (process.env.REWRITE_AFTER && calls === Number(process.env.REWRITE_AFTER)) {
  fs.writeFileSync(process.env.REWRITE_TARGET, process.env.REWRITE_BYTES)
}
`
  )
  chmodSync(shimPath, 0o755)
  if (options.killAfterDestinationInstall || options.killAfterSourceRemoval) {
    const mvShimPath = join(binDir, 'mv')
    writeFileSync(
      mvShimPath,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
const result = spawnSync('/bin/mv', args, { stdio: 'inherit' })
const from = args.at(-2) ?? ''
const to = args.at(-1) ?? ''
const sourceInstalled =
  process.env.KILL_SOURCE === '1' &&
  from.endsWith('/legacy/auth.json') &&
  to.endsWith('.orca-drain-live-source')
const destinationInstalled =
  process.env.KILL_DESTINATION === '1' &&
  from.includes('/account/auth.json.orca-drain-snapshot-') &&
  to.endsWith('/account/auth.json')
if (result.status === 0 && (sourceInstalled || destinationInstalled)) {
  process.kill(process.ppid, 'SIGKILL')
}
process.exit(result.status ?? 1)
`
    )
    chmodSync(mvShimPath, 0o755)
  }
  if (options.killDuringSessionCommit) {
    const rmShimPath = join(binDir, 'rm')
    writeFileSync(
      rmShimPath,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
const result = spawnSync('/bin/rm', args, { stdio: 'inherit' })
const target = args.at(-1) ?? ''
if (
  result.status === 0 &&
  fs.existsSync(process.env.SESSION_COMMIT_MARKER) &&
  target.includes('/account/sessions/') &&
  target.includes('.orca-bridge-')
) {
  const parent = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(process.ppid)], {
    encoding: 'utf8'
  })
  process.kill(Number(parent.stdout.trim()), 'SIGKILL')
}
process.exit(result.status ?? 1)
`
    )
    chmodSync(rmShimPath, 0o755)
  }
  if (
    options.crossFilesystemBridge ||
    options.killBeforeDestinationRecoveryLink ||
    options.killAfterSessionLink ||
    options.replaceTargetAfterSessionLink ||
    options.rewriteQuarantineAfterSessionLink ||
    options.rewriteSourceAfterSessionLink ||
    options.rewriteTargetAfterSessionLink
  ) {
    const lnShimPath = join(binDir, 'ln')
    writeFileSync(
      lnShimPath,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
if (
  process.env.KILL_DESTINATION_RECOVERY === '1' &&
  args.at(-1)?.endsWith('.orca-drain-destination')
) {
  process.kill(process.ppid, 'SIGKILL')
  process.exit(1)
}
if (
  process.env.CROSS_FILESYSTEM_BRIDGE === '1' &&
  args.at(-2)?.includes('.orca-drain-session-stage') &&
  args.at(-1)?.includes('.orca-bridge-')
) {
  process.exit(1)
}
const result = spawnSync('/bin/ln', args, { stdio: 'inherit' })
if (
  result.status === 0 &&
  args.at(-1)?.includes('/account/sessions/') &&
  args.at(-1)?.endsWith('/retired.jsonl')
) {
  if (process.env.KILL_SESSION_LINK === '1') {
    const parent = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(process.ppid)], {
      encoding: 'utf8'
    })
    process.kill(Number(parent.stdout.trim()), 'SIGKILL')
  } else if (process.env.REWRITE_AFTER_SESSION_LINK === '1') {
    if (process.env.REPLACE_TARGET === '1') {
      const replacement = process.env.REWRITE_SESSION_AUTH + '.replacement'
      fs.writeFileSync(replacement, process.env.REWRITE_BYTES)
      fs.renameSync(replacement, process.env.REWRITE_SESSION_AUTH)
    } else {
      if (process.env.REWRITE_QUARANTINE === '1') {
        fs.chmodSync(process.env.REWRITE_SESSION_AUTH, 0o600)
      }
      fs.writeFileSync(process.env.REWRITE_SESSION_AUTH, process.env.REWRITE_BYTES)
    }
  }
}
process.exit(result.status ?? 1)
`
    )
    chmodSync(lnShimPath, 0o755)
  }

  let status = 0
  try {
    execFileSync(
      '/bin/sh',
      [
        '-c',
        _internals.applyLegacyAuthScript,
        'sh',
        legacyHome,
        join(root, 'absent-active-home'),
        markerPath,
        targetHome,
        sha256(SOURCE_AUTH),
        sha256(TARGET_AUTH),
        options.promoteAuth === false ? '0' : '1',
        options.deleteSource ? '1' : '0',
        options.sourceCredentials === undefined ? 'missing' : sha256(options.sourceCredentials),
        'full'
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HASH_COUNTER: counterPath,
          CROSS_FILESYSTEM_BRIDGE: options.crossFilesystemBridge ? '1' : '0',
          KILL_DESTINATION: options.killAfterDestinationInstall ? '1' : '0',
          KILL_DESTINATION_RECOVERY: options.killBeforeDestinationRecoveryLink ? '1' : '0',
          KILL_SESSION_LINK: options.killAfterSessionLink ? '1' : '0',
          KILL_SOURCE: options.killAfterSourceRemoval ? '1' : '0',
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SESSION_COMMIT_MARKER: `${markerPath}.orca-drain-session-commit`,
          REWRITE_AFTER: options.rewriteAfterHashCall ? String(options.rewriteAfterHashCall) : '',
          REWRITE_AFTER_SESSION_LINK:
            options.replaceTargetAfterSessionLink ||
            options.rewriteQuarantineAfterSessionLink ||
            options.rewriteSourceAfterSessionLink ||
            options.rewriteTargetAfterSessionLink
              ? '1'
              : '0',
          REWRITE_BYTES: options.rewriteBytes ?? TORN_AUTH,
          REWRITE_QUARANTINE: options.rewriteQuarantineAfterSessionLink ? '1' : '0',
          REPLACE_TARGET: options.replaceTargetAfterSessionLink ? '1' : '0',
          REWRITE_SESSION_AUTH:
            options.rewriteTargetAfterSessionLink || options.replaceTargetAfterSessionLink
              ? targetAuthPath
              : options.rewriteQuarantineAfterSessionLink
                ? `${markerPath}.orca-drain-live-source`
                : legacyAuthPath,
          REWRITE_TARGET:
            options.rewriteTarget === 'source-credentials'
              ? legacyCredentialsPath
              : options.rewriteTarget === 'target-auth'
                ? targetAuthPath
                : legacyAuthPath
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000
      }
    )
  } catch (error) {
    status = (error as { status?: number }).status ?? -1
  }
  if (
    options.killAfterDestinationInstall ||
    options.killBeforeDestinationRecoveryLink ||
    options.killAfterSessionLink ||
    options.killAfterSourceRemoval ||
    options.killDuringSessionCommit
  ) {
    if (options.rewriteQuarantineBeforeRecovery) {
      const quarantinePath = `${markerPath}.orca-drain-live-source`
      chmodSync(quarantinePath, 0o600)
      writeFileSync(quarantinePath, NEWER_AUTH)
    }
    if (options.replaceTargetBeforeRecovery) {
      const replacementPath = `${targetAuthPath}.replacement`
      writeFileSync(replacementPath, NEWER_AUTH)
      renameSync(replacementPath, targetAuthPath)
    }
    try {
      execFileSync(
        '/bin/sh',
        [
          '-c',
          _internals.inspectLegacyAuthScript,
          'sh',
          legacyHome,
          join(root, 'absent-active-home'),
          markerPath
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }
      )
    } catch {
      // Recovery succeeds before inspect continues and emits the pending auth payload.
    }
  }
  return {
    legacyAuth: existsSync(legacyAuthPath) ? readFileSync(legacyAuthPath, 'utf8') : null,
    markerExists: existsSync(markerPath),
    status,
    targetAuth: readFileSync(targetAuthPath, 'utf8'),
    targetCredentials: existsSync(targetCredentialsPath)
      ? readFileSync(targetCredentialsPath, 'utf8')
      : null,
    targetMode: statSync(targetAuthPath).mode & 0o777,
    targetSession: existsSync(join(targetHome, ...RETIRED_SESSION_SEGMENTS))
      ? readFileSync(join(targetHome, ...RETIRED_SESSION_SEGMENTS), 'utf8')
      : null,
    sourceQuarantineAuth: existsSync(`${markerPath}.orca-drain-live-source`)
      ? readFileSync(`${markerPath}.orca-drain-live-source`, 'utf8')
      : null,
    sourceRecoveryAuth: existsSync(`${markerPath}.orca-drain-source`)
      ? readFileSync(`${markerPath}.orca-drain-source`, 'utf8')
      : null,
    destinationRecoveryAuth: existsSync(`${markerPath}.orca-drain-destination`)
      ? readFileSync(`${markerPath}.orca-drain-destination`, 'utf8')
      : null,
    destinationRecoveryPathExists: existsSync(`${markerPath}.orca-drain-destination-path`),
    sessionCommitMarkerExists: existsSync(`${markerPath}.orca-drain-session-commit`)
  }
}

function runRecoveryScript(options: {
  destinationRecovery?: boolean
  markerPresent: boolean
  pathMetadata?: boolean
  script: string
}): {
  destinationMode: number
  destinationRecoveryExists: boolean
  destinationRecoveryPathExists: boolean
  markerExists: boolean
  sourceAuth: string | null
  sourceRecoveryExists: boolean
  status: number
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-drain-recovery-'))
  const legacyHome = join(root, 'legacy')
  const targetHome = join(root, 'account')
  mkdirSync(legacyHome)
  mkdirSync(targetHome)
  const markerPath = join(root, 'drain-marker.json')
  const sourceRecoveryPath = `${markerPath}.orca-drain-source`
  const destinationRecoveryPath = `${markerPath}.orca-drain-destination`
  const destinationRecoveryTargetPath = `${markerPath}.orca-drain-destination-path`
  const sourceAuthPath = join(legacyHome, 'auth.json')
  const destinationAuthPath = join(targetHome, 'auth.json')
  writeFileSync(sourceRecoveryPath, SOURCE_AUTH, { mode: 0o400 })
  writeFileSync(destinationAuthPath, TARGET_AUTH, { mode: 0o400 })
  if (options.destinationRecovery !== false) {
    linkSync(destinationAuthPath, destinationRecoveryPath)
  }
  if (options.pathMetadata !== false) {
    writeFileSync(destinationRecoveryTargetPath, `${destinationAuthPath}\0`, { mode: 0o600 })
  }
  if (options.markerPresent) {
    writeFileSync(markerPath, '{"completed":true}\n')
  }
  let status = 0
  try {
    execFileSync(
      '/bin/sh',
      ['-c', options.script, 'sh', legacyHome, join(root, 'absent-active-home'), markerPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }
    )
  } catch (error) {
    status = (error as { status?: number }).status ?? -1
  }
  return {
    destinationMode: statSync(destinationAuthPath).mode & 0o777,
    destinationRecoveryExists: existsSync(destinationRecoveryPath),
    destinationRecoveryPathExists: existsSync(destinationRecoveryTargetPath),
    markerExists: existsSync(markerPath),
    sourceAuth: existsSync(sourceAuthPath) ? readFileSync(sourceAuthPath, 'utf8') : null,
    sourceRecoveryExists: existsSync(sourceRecoveryPath),
    status
  }
}

function runAbsentLegacyHomeScript(options: {
  activeHomeOnly?: boolean
  createLegacyHome: boolean
  markerParentMissing?: boolean
  script: string
}): {
  markerExists: boolean
  status: number
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-drain-absent-home-'))
  const legacyHome = join(root, 'legacy')
  const activeHome = join(root, 'absent-active-home')
  const markerPath = options.markerParentMissing
    ? join(root, 'marker-parent', 'drain-marker.json')
    : join(root, 'drain-marker.json')
  if (options.createLegacyHome) {
    const sessionHome = options.activeHomeOnly ? activeHome : legacyHome
    mkdirSync(join(sessionHome, ...RETIRED_SESSION_SEGMENTS.slice(0, -1)), { recursive: true })
    writeFileSync(join(sessionHome, ...RETIRED_SESSION_SEGMENTS), RETIRED_SESSION)
  }
  let status = 0
  try {
    execFileSync('/bin/sh', ['-c', options.script, 'sh', legacyHome, activeHome, markerPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000
    })
  } catch (error) {
    status = (error as { status?: number }).status ?? -1
  }
  return { markerExists: existsSync(markerPath), status }
}

describe.skipIf(isWindows)('legacy WSL auth drain apply script', () => {
  it('distinguishes an absent legacy home from an authless retained home', () => {
    const absent = runAbsentLegacyHomeScript({
      createLegacyHome: false,
      script: _internals.inspectLegacyAuthScript
    })
    const retained = runAbsentLegacyHomeScript({
      createLegacyHome: true,
      script: _internals.inspectLegacyAuthScript
    })

    expect(absent.status).toBe(22)
    expect(retained.status).toBe(21)
  })

  it('resolves an active-home-only legacy layout as retained', () => {
    const outcome = runAbsentLegacyHomeScript({
      activeHomeOnly: true,
      createLegacyHome: true,
      script: _internals.inspectLegacyAuthScript
    })

    expect(outcome.status).toBe(21)
    expect(outcome.markerExists).toBe(false)
  })

  it('does not finalize while an authless legacy home still holds sessions', () => {
    const outcome = runAbsentLegacyHomeScript({
      createLegacyHome: true,
      script: _internals.finalizeAbsentAuthScript
    })

    expect(outcome.status).toBe(47)
    expect(outcome.markerExists).toBe(false)
  })

  it('creates the completion-marker parent when the retired tree never existed', () => {
    const outcome = runAbsentLegacyHomeScript({
      createLegacyHome: false,
      markerParentMissing: true,
      script: _internals.finalizeAbsentAuthScript
    })

    expect(outcome.status).toBe(0)
    expect(outcome.markerExists).toBe(true)
  })

  it('promotes the validated source into the account home', () => {
    const outcome = runApplyScript()
    expect(outcome.targetAuth).toBe(SOURCE_AUTH)
  })

  it('leaves the legacy home untouched while promoting', () => {
    // One-directional: the promote step must never write back to the old home.
    expect(runApplyScript().legacyAuth).toBe(SOURCE_AUTH)
  })

  it('refuses torn bytes and leaves the account home intact', () => {
    // Hash call 1 is the source pre-check; rotating right after it means `cp`
    // reads bytes freshness never judged. Pre-guard, those reached the target.
    const outcome = runApplyScript({ rewriteAfterHashCall: 1 })
    expect(outcome.status).toBe(42)
    expect(outcome.targetAuth).toBe(TARGET_AUTH)
  })

  it('refuses a symlinked live source before the destructive path can retire it', () => {
    const result = runApplyScript({ deleteSource: true, sourceAuthSymlink: true })

    expect(result.status).toBe(46)
    expect(result.legacyAuth).toBe(SOURCE_AUTH)
    expect(result.markerExists).toBe(false)
    expect(result.targetAuth).toBe(TARGET_AUTH)
  })

  it('refuses MCP credentials that changed after host validation', () => {
    const outcome = runApplyScript({
      rewriteAfterHashCall: 2,
      rewriteBytes: TORN_CREDENTIALS,
      rewriteTarget: 'source-credentials',
      sourceCredentials: SOURCE_CREDENTIALS
    })
    expect(outcome.status).toBe(43)
    expect(outcome.targetCredentials).toBeNull()
  })

  it('does not overwrite auth changed after the destination hash check', () => {
    const outcome = runApplyScript({
      rewriteBytes: NEWER_AUTH,
      rewriteAfterHashCall: 4,
      rewriteTarget: 'target-auth'
    })
    expect(outcome.status).toBe(39)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
  })

  it('keeps the source pending when an unpromoted destination changes before deletion', () => {
    // Hash call 3 is the pinned destination check; the quarantine recheck must
    // observe this in-place rewrite before removing the source.
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteAfterHashCall: 3,
      rewriteBytes: NEWER_AUTH,
      rewriteTarget: 'target-auth'
    })

    expect(outcome.status).toBe(45)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.markerExists).toBe(false)
  })

  it('keeps the source pending when the destination changes after final precommit validation', () => {
    // Hash call 9 validates the independent snapshot. A rewrite immediately
    // afterward races the atomic cutover and must be detected on the old inode.
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteAfterHashCall: 9,
      rewriteBytes: NEWER_AUTH,
      rewriteTarget: 'target-auth'
    })

    expect(outcome.status).toBe(45)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.markerExists).toBe(false)
  })

  it('blocks destination rewrites after the final locked validation', () => {
    // Hash call 12 is the installed read-only destination check. The shim's
    // attempted in-place rewrite must fail before the source is retired.
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteAfterHashCall: 12,
      rewriteTarget: 'target-auth'
    })

    expect(outcome.status).toBe(0)
    expect(outcome.legacyAuth).toBeNull()
    expect(outcome.targetAuth).toBe(TARGET_AUTH)
    expect(outcome.markerExists).toBe(true)
  })

  it('recovers the source and destination mode after abrupt interruption', () => {
    const outcome = runApplyScript({ deleteSource: true, killAfterSourceRemoval: true })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetMode).toBe(0o600)
    expect(outcome.markerExists).toBe(false)
  })

  it('can unlock the destination after interruption during atomic installation', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killAfterDestinationInstall: true
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetMode).toBe(0o600)
    expect(outcome.markerExists).toBe(false)
  })

  it('cleans path metadata when interrupted before destination recovery is linked', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killBeforeDestinationRecoveryLink: true
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.destinationRecoveryAuth).toBeNull()
    expect(outcome.destinationRecoveryPathExists).toBe(false)
    expect(outcome.markerExists).toBe(false)
  })

  it('restores verified source recovery instead of mutable quarantine after a crash', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killAfterSourceRemoval: true,
      rewriteQuarantineBeforeRecovery: true
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.sourceRecoveryAuth).toBeNull()
    expect(outcome.sourceQuarantineAuth).toBe(NEWER_AUTH)
    expect(outcome.markerExists).toBe(false)
  })

  it('retains verified destination recovery when the target inode changed after a crash', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killAfterSourceRemoval: true,
      replaceTargetBeforeRecovery: true
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.destinationRecoveryAuth).toBe(SOURCE_AUTH)
    expect(outcome.destinationRecoveryPathExists).toBe(true)
    expect(outcome.markerExists).toBe(false)
  })

  it('preserves a source rewrite that lands before quarantine', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteAfterHashCall: 6,
      rewriteBytes: NEWER_AUTH,
      rewriteTarget: 'source-auth',
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(40)
    expect(outcome.legacyAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('bridges retired sessions while a legacy pane still owns the source', () => {
    const outcome = runApplyScript({
      deleteSource: false,
      promoteAuth: false,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetSession).toBe(RETIRED_SESSION)
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back retained-pane links when source ownership changes during the bridge', () => {
    const outcome = runApplyScript({
      deleteSource: false,
      promoteAuth: false,
      rewriteBytes: NEWER_AUTH,
      rewriteSourceAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(40)
    expect(outcome.legacyAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back retained-pane links when destination ownership changes during the bridge', () => {
    const outcome = runApplyScript({
      deleteSource: false,
      promoteAuth: false,
      rewriteBytes: NEWER_AUTH,
      rewriteTargetAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(45)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back retired links when ownership changes during the bridge', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteBytes: NEWER_AUTH,
      rewriteSourceAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(40)
    expect(outcome.legacyAuth).toBe(NEWER_AUTH)
    expect(outcome.sourceRecoveryAuth).toBe(SOURCE_AUTH)
    expect(outcome.sourceQuarantineAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back when an atomic rename replaces the destination during the bridge', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      replaceTargetAfterSessionLink: true,
      rewriteBytes: NEWER_AUTH,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(45)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('retires auth after bridging sessions across guest filesystems', () => {
    const outcome = runApplyScript({
      crossFilesystemBridge: true,
      deleteSource: true,
      promoteAuth: false,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(0)
    expect(outcome.legacyAuth).toBeNull()
    expect(outcome.targetSession).toBe(RETIRED_SESSION)
    expect(outcome.markerExists).toBe(true)
  })

  it('restores the verified recovery when an open writer mutates the quarantined inode', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteBytes: NEWER_AUTH,
      rewriteQuarantineAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(40)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.sourceRecoveryAuth).toBeNull()
    expect(outcome.sourceQuarantineAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back a published session link after abrupt interruption', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('finishes a durable session-link commit after abrupt interruption', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killDuringSessionCommit: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetSession).toBe(RETIRED_SESSION)
    expect(outcome.sessionCommitMarkerExists).toBe(false)
    expect(outcome.markerExists).toBe(false)
  })

  it('finishes durable cleanup when inspection finds a committed marker', () => {
    const outcome = runRecoveryScript({
      markerPresent: true,
      script: _internals.inspectLegacyAuthScript
    })

    expect(outcome.status).toBe(20)
    expect(outcome.destinationMode).toBe(0o600)
    expect(outcome.destinationRecoveryExists).toBe(false)
    expect(outcome.destinationRecoveryPathExists).toBe(false)
    expect(outcome.sourceRecoveryExists).toBe(false)
  })

  it('finishes durable cleanup when apply finds a committed marker', () => {
    const outcome = runRecoveryScript({
      markerPresent: true,
      script: _internals.applyLegacyAuthScript
    })

    expect(outcome.status).toBe(0)
    expect(outcome.destinationMode).toBe(0o600)
    expect(outcome.destinationRecoveryExists).toBe(false)
    expect(outcome.destinationRecoveryPathExists).toBe(false)
    expect(outcome.sourceRecoveryExists).toBe(false)
  })

  it('refuses absent-source finalization while a durable recovery copy exists', () => {
    const outcome = runRecoveryScript({
      markerPresent: false,
      script: _internals.finalizeAbsentAuthScript
    })

    expect(outcome.status).toBe(46)
    expect(outcome.sourceAuth).toBe(SOURCE_AUTH)
    expect(outcome.destinationMode).toBe(0o600)
    expect(outcome.destinationRecoveryExists).toBe(false)
    expect(outcome.destinationRecoveryPathExists).toBe(false)
    expect(outcome.sourceRecoveryExists).toBe(false)
    expect(outcome.markerExists).toBe(false)
  })

  it('fails closed when destination recovery has no target-path metadata', () => {
    const outcome = runRecoveryScript({
      markerPresent: false,
      pathMetadata: false,
      script: _internals.inspectLegacyAuthScript
    })

    expect(outcome.status).toBe(46)
    expect(outcome.destinationRecoveryExists).toBe(true)
    expect(outcome.destinationRecoveryPathExists).toBe(false)
  })

  it('deletes a promoted source only while the destination remains intact', () => {
    const changedDestination = runApplyScript({
      deleteSource: true,
      rewriteAfterHashCall: 7,
      rewriteBytes: NEWER_AUTH,
      rewriteTarget: 'target-auth'
    })
    expect(changedDestination.status).toBe(45)
    expect(changedDestination.legacyAuth).toBe(SOURCE_AUTH)
    expect(changedDestination.markerExists).toBe(false)

    const outcome = runApplyScript({ deleteSource: true })

    expect(outcome.status).toBe(0)
    expect(outcome.legacyAuth).toBeNull()
    expect(outcome.targetAuth).toBe(SOURCE_AUTH)
    expect(outcome.markerExists).toBe(true)
  })
})
