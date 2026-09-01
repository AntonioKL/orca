/**
 * Execution-policy handling for the Windows computer-use runtime script.
 *
 * Why not `Bypass` outright: it is the highest-weighted token on a
 * powershell.exe command line for Defender for Endpoint, and the shipped
 * runtime.ps1 does not need it — NSIS extraction writes no Zone.Identifier, so
 * an unsigned local script runs under `RemoteSigned`. `Restricted` is still the
 * Windows client default though, so a policy-blocked start must fall back once
 * rather than leaving computer use broken.
 */
export type WindowsExecutionPolicy = 'RemoteSigned' | 'Bypass'

export const PREFERRED_WINDOWS_EXECUTION_POLICY: WindowsExecutionPolicy = 'RemoteSigned'
export const FALLBACK_WINDOWS_EXECUTION_POLICY: WindowsExecutionPolicy = 'Bypass'

// Matches the SecurityError PowerShell emits for `-File` under a blocking policy.
const EXECUTION_POLICY_BLOCKED =
  /running scripts is disabled on this system|UnauthorizedAccess|PSSecurityException|SecurityError|about_Execution_Policies/i

export function isExecutionPolicyBlocked(text: string): boolean {
  return EXECUTION_POLICY_BLOCKED.test(text)
}

export function windowsPowerShellRuntimeArgs(
  scriptPath: string,
  policy: WindowsExecutionPolicy,
  scriptArgs: readonly string[] = []
): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    policy,
    '-File',
    scriptPath,
    ...scriptArgs
  ]
}
