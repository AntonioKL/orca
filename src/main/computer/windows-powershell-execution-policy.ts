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

/**
 * Matches the SecurityError PowerShell emits for `-File` under a blocking policy.
 *
 * The prose alternative is whitespace-tolerant because PowerShell hard-wraps
 * error text at the console width, so the sentence arrives split across lines.
 * The single-token alternatives survive that wrapping unaided and are what
 * actually carries the match in practice.
 */
const EXECUTION_POLICY_BLOCKED =
  /running\s+scripts\s+is\s+disabled|UnauthorizedAccess|PSSecurityException|about_Execution_Policies/i

export function isExecutionPolicyBlocked(text: string): boolean {
  return EXECUTION_POLICY_BLOCKED.test(text)
}

export function windowsPowerShellRuntimeArgs(
  scriptPath: string,
  policy: WindowsExecutionPolicy,
  scriptArgs: readonly string[] = []
): string[] {
  return [
    // -NoLogo: a banner on stdout would be read as a malformed response line.
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    policy,
    '-File',
    scriptPath,
    ...scriptArgs
  ]
}
