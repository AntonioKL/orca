import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  assertOwnedClaudeManagedAuthPath,
  MISSING_MANAGED_AUTH_MESSAGE,
  OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE,
  UNTRUSTED_MANAGED_AUTH_MESSAGE,
  type ClaudeManagedAuthVerdict
} from './claude-managed-auth-ownership'
import {
  getClaudeManagedAccountsRoot,
  MANAGED_AUTH_MARKER,
  readClaudeManagedAuthFile,
  resolveClaudeManagedAuthVerdict,
  writeClaudeManagedAuthFile
} from './managed-auth-path'
import {
  buildWslManagedAuthProbeScript,
  classifyWslManagedAuthProbe
} from './wsl-managed-auth-probe'
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

  async remove(accountId: string, candidatePath: string): Promise<void> {
    try {
      const managedAuthPath = await this.assertOwned(candidatePath, accountId)
      rmSync(resolve(managedAuthPath, '..'), { recursive: true, force: true })
    } catch (error) {
      console.warn('[claude-accounts] Refusing to remove untrusted managed auth:', error)
    }
    await deleteManagedClaudeKeychainCredentials(accountId)
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
      return this.resolveWslVerdict(candidatePath, wslInfo, expectedAccountId)
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

  private async resolveWslVerdict(
    candidatePath: string,
    wslInfo: NonNullable<ReturnType<typeof parseWslUncPath>>,
    expectedAccountId?: string
  ): Promise<ClaudeManagedAuthVerdict> {
    if (
      !wslInfo.linuxPath.includes('/.local/share/orca/claude-accounts/') ||
      !wslInfo.linuxPath.endsWith('/auth')
    ) {
      return { kind: 'untrusted', reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE }
    }
    if (process.platform !== 'win32') {
      return resolveHostVisibleGuestVerdict(candidatePath)
    }
    let probe: Awaited<ReturnType<typeof runWslProcess>>
    try {
      probe = await runWslProcess({
        distro: wslInfo.distro,
        loginPath: 'none',
        shell: 'bash',
        script: buildWslManagedAuthProbeScript(wslInfo.linuxPath, expectedAccountId),
        timeoutMs: 5000
      })
    } catch (error) {
      // A spawn failure says nothing about the directory; it says wsl.exe did
      // not run.
      return { kind: 'indeterminate', error }
    }
    return classifyWslManagedAuthProbe(probe, wslInfo.distro)
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

/**
 * A guest path that the host can address directly (a non-win32 host reading a
 * WSL-spelled record). Only a definitive absence is a verdict; an unreadable
 * directory is not evidence that it is a stranger's.
 */
function resolveHostVisibleGuestVerdict(candidatePath: string): ClaudeManagedAuthVerdict {
  for (const path of [candidatePath, join(candidatePath, MANAGED_AUTH_MARKER)]) {
    try {
      lstatSync(path)
    } catch (error) {
      return isDefinitiveAbsence(error)
        ? { kind: 'untrusted', reason: UNTRUSTED_MANAGED_AUTH_MESSAGE }
        : { kind: 'indeterminate', error }
    }
  }
  return { kind: 'owned', authPath: candidatePath }
}
