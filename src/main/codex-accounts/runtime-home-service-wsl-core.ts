import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  codexAuthCouldBelongToManagedAccount,
  codexAuthMatchesManagedAccount,
  codexAuthMatchesSystemDefaultIdentity,
  codexAuthIsFresher
} from './codex-auth-identity'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { CodexReadBackMatch } from './runtime-home-service-types'
import { CodexRuntimeHomeAuthProvenance } from './runtime-home-service-auth-provenance'

export abstract class CodexRuntimeHomeWslCore extends CodexRuntimeHomeAuthProvenance {
  protected getActiveAccount(
    accounts: CodexManagedAccount[],
    activeAccountId: string | null
  ): CodexManagedAccount | null {
    if (!activeAccountId) {
      return null
    }
    return accounts.find((account) => account.id === activeAccountId) ?? null
  }

  protected getWslManagedHomePath(account: CodexManagedAccount | null): string | null {
    if (!account) {
      return null
    }
    if (account.managedHomeRuntime === 'wsl' && parseWslUncPath(account.managedHomePath)) {
      return account.managedHomePath
    }
    return parseWslUncPath(account.managedHomePath) ? account.managedHomePath : null
  }

  protected findManagedAccountForRuntimeAuth(
    runtimeAuthContents: string,
    expectedAccountId?: string
  ): CodexReadBackMatch {
    const matches: {
      account: CodexManagedAccount
      managedAuthPath: string
      managedAuthContents: string
    }[] = []
    let unreadableHomeCouldOwnRuntimeAuth = false
    for (const account of this.store.getSettings().codexManagedAccounts) {
      if (expectedAccountId && account.id !== expectedAccountId) {
        continue
      }
      const managedAuthPath = join(account.managedHomePath, 'auth.json')
      if (!existsSync(managedAuthPath)) {
        continue
      }
      let managedAuthContents: string
      try {
        managedAuthContents = readFileSync(managedAuthPath, 'utf-8')
      } catch {
        // Why: an unreadable home can never be compared, but letting the read
        // throw abandons the scan for every other account — dropping a refresh
        // the runtime home holds for one of them. Only its record can rule it
        // out as the owner; when it cannot, the scan is no longer unambiguous.
        if (
          !expectedAccountId &&
          codexAuthCouldBelongToManagedAccount(runtimeAuthContents, account)
        ) {
          unreadableHomeCouldOwnRuntimeAuth = true
        }
        continue
      }
      if (codexAuthMatchesManagedAccount(runtimeAuthContents, account, managedAuthContents)) {
        matches.push({ account, managedAuthPath, managedAuthContents })
      }
    }

    if (unreadableHomeCouldOwnRuntimeAuth) {
      return { kind: 'ambiguous' }
    }
    if (matches.length === 1) {
      return { kind: 'matched', ...matches[0] }
    }
    return { kind: matches.length === 0 ? 'none' : 'ambiguous' }
  }

  protected runtimeAuthMatchesSystemDefaultIdentity(
    runtimeAuthContents: string,
    systemDefaultAuthContents: string
  ): boolean {
    return codexAuthMatchesSystemDefaultIdentity(runtimeAuthContents, systemDefaultAuthContents)
  }

  protected runtimeAuthIsFresher(
    runtimeAuthContents: string,
    managedAuthContents: string
  ): boolean {
    return codexAuthIsFresher(runtimeAuthContents, managedAuthContents)
  }
}
