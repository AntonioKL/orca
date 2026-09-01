import { encodePowerShellCommand } from '../../shared/powershell-command-encoding'
export {
  quotePowerShellLiteral as powerShellLiteral,
  quotePowerShellNativeArgument as powerShellNativeArg
} from '../../shared/powershell-native-argument'

// Why: `-EncodedCommand` is not execution-policy gated (only `-File` is), so `-ExecutionPolicy
// Bypass` was a no-op here — and it is one of the most heavily EDR-flagged PowerShell tokens.
// The base64 stays: this string is re-parsed by the remote host's default SSH shell, which may
// be cmd.exe, PowerShell, or bash.
//
// INVARIANT — no remote payload may load a PowerShell *script file*.
//
// Execution policy has only ever gated loading script files (2.0 through 7.x). Inline
// statements, `& some.exe` and `Add-Type -TypeDefinition` are never gated, which is what makes
// dropping the switch a no-op for every payload we send today. Loading a script file is the one
// thing the dropped switch actually covered, so a payload that dot-sources, runs `& '<x>.ps1'`,
// calls `Import-Module '<x>.psm1'`, or passes `-File` would silently fail on a remote host whose
// LocalMachine policy is Restricted/AllSigned with no GPO — a break that surfaces on someone
// else's machine, not ours.
//
// If you ever need one, do NOT restore the command-line switch (it loses to a GPO scope anyway,
// so it never covered the locked-down case): set the policy in-payload at process scope, the way
// `buildWindowsStartupCommand` in src/shared/setup-agent-sequencing.ts does.
//
// Enforced by the ratchet in ssh-remote-powershell.test.ts, which scans every importer.
export function powerShellCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`
}
