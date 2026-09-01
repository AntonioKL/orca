import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  assertOwnedClaudeManagedAuthPath,
  MISSING_MANAGED_AUTH_MESSAGE,
  type ClaudeManagedAuthVerdict
} from './claude-managed-auth-ownership'
import {
  getClaudeManagedAccountsRoot,
  MANAGED_AUTH_MARKER,
  readClaudeManagedAuthFile,
  resolveClaudeManagedAuthVerdict,
  writeClaudeManagedAuthFile
} from './managed-auth-path'
import { resolveWslManagedAuthVerdict } from './wsl-managed-auth-probe'
import {
  deleteManagedClaudeKeychainCredentials,
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from './keychain'

export type ClaudeManagedAuthLocation = {
  managedAuthPath: string
  managedAuthRuntime: 'host' | 'wsl'
  wslDistro: string | null
  wslLinuxAuthPath: string | null
}

export type ClaudeManagedAuthSnapshot = {
  credentialsJson: string | null
  oauthAccountJson: string | null
}

export type ClaudeManagedAuthTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export class ClaudeManagedAuthStorage {
  async create(
    accountId: string,
    target?: ClaudeManagedAuthTarget
  ): Promise<ClaudeManagedAuthLocation> {
    const wslAuth = await this.tryCreateWsl(accountId, target)
    if (wslAuth) {
      return wslAuth
    }
    const managedAuthPath = join(this.getRoot(), accountId, 'auth')
    mkdirSync(managedAuthPath, { recursive: true, mode: 0o700 })
    writeFileSync(join(managedAuthPath, MANAGED_AUTH_MARKER), `${accountId}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
    return {
      managedAuthPath: await this.assertOwned(managedAuthPath, accountId),
      managedAuthRuntime: 'host',
      wslDistro: null,
      wslLinuxAuthPath: null
    }
  }

  async writeAuth(
    accountId: string,
    managedAuthPath: string,
    captured: { credentialsJson: string; oauthAccount: unknown }
  ): Promise<void> {
    await this.writeCredentials(accountId, managedAuthPath, captured.credentialsJson)
    await this.writeOauthAccount(accountId, managedAuthPath, captured.oauthAccount)
  }

  async writeCredentials(
    accountId: string,
    managedAuthPath: string,
    credentialsJson: string
  ): Promise<void> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    if (process.platform === 'darwin') {
      await writeManagedClaudeKeychainCredentials(accountId, credentialsJson)
    } else {
      writeClaudeManagedAuthFile(trustedPath, '.credentials.json', credentialsJson)
    }
  }

  async writeOauthAccount(
    accountId: string,
    managedAuthPath: string,
    oauthAccount: unknown
  ): Promise<void> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    writeClaudeManagedAuthFile(
      trustedPath,
      'oauth-account.json',
      `${JSON.stringify(oauthAccount, null, 2)}\n`
    )
  }

  async readSnapshot(
    accountId: string,
    managedAuthPath: string
  ): Promise<ClaudeManagedAuthSnapshot> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    return {
      credentialsJson:
        process.platform === 'darwin'
          ? await readManagedClaudeKeychainCredentials(accountId)
          : readClaudeManagedAuthFile(trustedPath, '.credentials.json'),
      oauthAccountJson: readClaudeManagedAuthFile(trustedPath, 'oauth-account.json')
    }
  }

  async restoreCredentials(
    accountId: string,
    managedAuthPath: string,
    snapshot: ClaudeManagedAuthSnapshot
  ): Promise<void> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    if (process.platform === 'darwin') {
      await (snapshot.credentialsJson !== null
        ? writeManagedClaudeKeychainCredentials(accountId, snapshot.credentialsJson)
        : deleteManagedClaudeKeychainCredentials(accountId))
    } else if (snapshot.credentialsJson !== null) {
      writeClaudeManagedAuthFile(trustedPath, '.credentials.json', snapshot.credentialsJson)
    } else {
      rmSync(join(trustedPath, '.credentials.json'), { force: true })
    }
  }

  async restoreOauth(
    accountId: string,
    managedAuthPath: string,
    snapshot: ClaudeManagedAuthSnapshot
  ): Promise<void> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    if (snapshot.oauthAccountJson !== null) {
      writeClaudeManagedAuthFile(trustedPath, 'oauth-account.json', snapshot.oauthAccountJson)
    } else {
      rmSync(join(trustedPath, 'oauth-account.json'), { force: true })
    }
  }

  /**
   * Removal the user asked for. Their request is the authority, so this runs no
   * ownership probe: a gate that cannot complete must not turn "remove it" into
   * "quietly keep it", which leaves credentials on disk with nothing in the UI
   * still pointing at them (STA-5674 follow-up).
   *
   * Safety comes from the spelling instead, and it is stricter than the probe it
   * replaces: the old path deleted `resolve(canonicalAuthPath, '..')`, which
   * follows a symlink out of the managed root, while this deletes only the
   * directory Orca itself would have created for this account ID.
   */
  async remove(accountId: string, candidatePath: string): Promise<void> {
    const accountDir = this.resolveOwnSpellingAccountDir(accountId, candidatePath)
    if (accountDir === null) {
      console.warn(
        '[claude-accounts] Not removing a managed auth path Orca did not choose:',
        candidatePath
      )
    } else {
      try {
        // Recursive removal never traverses a symlink -- it unlinks the link --
        // so a planted link cannot redirect this outside the root.
        rmSync(accountDir, { recursive: true, force: true })
      } catch (error) {
        // Non-throwing by contract: the caller has already committed the
        // settings change and must not roll it back over a failed unlink.
        console.warn('[claude-accounts] Could not remove managed auth directory:', error)
      }
    }
    await deleteManagedClaudeKeychainCredentials(accountId)
  }

  /**
   * Cleanup Orca decided to do on its own after a failed add. Unlike an explicit
   * removal this has no user intent behind it, so only a dispositive verdict
   * authorises deleting anything -- including the keychain entry.
   */
  async removeAfterFailedAdd(accountId: string, candidatePath: string): Promise<void> {
    const verdict = await this.resolveVerdict(candidatePath, accountId)
    if (verdict.kind === 'indeterminate') {
      console.warn(
        '[claude-accounts] Leaving managed auth in place after a failed add:',
        verdict.error
      )
      return
    }
    await this.remove(accountId, candidatePath)
  }

  private resolveOwnSpellingAccountDir(accountId: string, candidatePath: string): string | null {
    const wslInfo = parseWslUncPath(candidatePath)
    if (wslInfo) {
      const suffix = `/.local/share/orca/claude-accounts/${accountId}/auth`
      return wslInfo.linuxPath.endsWith(suffix)
        ? toWindowsWslPath(wslInfo.linuxPath.slice(0, -'/auth'.length), wslInfo.distro)
        : null
    }
    const resolvedCandidate = resolve(candidatePath)
    for (const root of this.getAccountsRootSpellings()) {
      if (pathsEqual(resolvedCandidate, resolve(root, accountId, 'auth'))) {
        return resolve(root, accountId)
      }
    }
    return null
  }

  /**
   * Both spellings of the accounts root. The persisted path is canonical (the
   * gate that produced it resolved symlinks) while `getRoot()` is not, so a
   * userData directory behind a symlink makes the two disagree — and this is
   * spelling normalisation, not an ownership check, so a failed realpath just
   * leaves the lexical spelling to match against.
   */
  private getAccountsRootSpellings(): string[] {
    let root: string
    try {
      root = resolve(this.getRoot())
    } catch (error) {
      console.warn('[claude-accounts] Could not resolve the managed accounts root:', error)
      return []
    }
    try {
      const canonicalRoot = realpathSync(root)
      return pathsEqual(canonicalRoot, root) ? [root] : [root, canonicalRoot]
    } catch {
      return [root]
    }
  }

  async assertOwned(candidatePath: string, expectedAccountId?: string): Promise<string> {
    return assertOwnedClaudeManagedAuthPath(
      await this.resolveVerdict(candidatePath, expectedAccountId)
    )
  }

  /** Non-throwing view for callers that must branch on *why* the gate refused. */
  async resolveVerdict(
    candidatePath: string,
    expectedAccountId?: string
  ): Promise<ClaudeManagedAuthVerdict> {
    const wslInfo = parseWslUncPath(candidatePath)
    if (wslInfo) {
      return resolveWslManagedAuthVerdict(candidatePath, wslInfo, expectedAccountId)
    }
    try {
      this.getRoot()
    } catch (error) {
      return { kind: 'indeterminate', error }
    }
    const accountId = expectedAccountId ?? this.readAccountId(candidatePath)
    if (!accountId || (expectedAccountId && accountId !== expectedAccountId)) {
      return { kind: 'untrusted', reason: MISSING_MANAGED_AUTH_MESSAGE }
    }
    return resolveClaudeManagedAuthVerdict(accountId, candidatePath, { adoptLegacyMarker: true })
  }

  private async tryCreateWsl(
    accountId: string,
    target?: ClaudeManagedAuthTarget
  ): Promise<ClaudeManagedAuthLocation | null> {
    if (process.platform !== 'win32' || target?.runtime !== 'wsl') {
      return null
    }
    const requestedDistro = target.wslDistro?.trim() || undefined
    const info = await runWslProcess({
      distro: requestedDistro,
      loginPath: 'none',
      shell: 'bash',
      script: 'printf "%s\\n%s\\n" "$WSL_DISTRO_NAME" "$HOME"',
      timeoutMs: 5000
    })
    const [rawDistro, rawHome] =
      info.code === 0 && !info.timedOut
        ? info.stdout
            .replaceAll(String.fromCharCode(0), '')
            .split(/\r?\n/)
            .map((line) => line.trim())
        : []
    const distro = requestedDistro || rawDistro
    const home = rawHome
    if (!distro || !home?.startsWith('/')) {
      throw new Error('Could not resolve the active WSL home directory for Claude login.')
    }
    const linuxPath = `${home.replace(/\/$/, '')}/.local/share/orca/claude-accounts/${accountId}/auth`
    const created = await runWslProcess({
      distro,
      loginPath: 'none',
      shell: 'bash',
      script: 'umask 077; mkdir -p "$1" && printf \'%s\\n\' "$2" > "$1/.orca-managed-claude-auth"',
      args: [linuxPath, accountId],
      timeoutMs: 5000
    })
    if (created.code !== 0 || created.timedOut) {
      throw new Error('Could not create the managed WSL Claude auth directory.')
    }
    const managedAuthPath = toWindowsWslPath(linuxPath, distro)
    return {
      managedAuthPath: await this.assertOwned(managedAuthPath, accountId),
      managedAuthRuntime: 'wsl',
      wslDistro: distro,
      wslLinuxAuthPath: linuxPath
    }
  }

  private getRoot(): string {
    const root = getClaudeManagedAccountsRoot()
    mkdirSync(root, { recursive: true, mode: 0o700 })
    return root
  }

  private readAccountId(candidatePath: string): string | null {
    const relativePath = relative(resolve(this.getRoot()), resolve(candidatePath))
    const parts = relativePath.split(sep)
    return parts.length === 2 && parts[1] === 'auth' ? parts[0] : null
  }
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
