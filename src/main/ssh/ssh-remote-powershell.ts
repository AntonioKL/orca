import { encodePowerShellCommand } from '../../shared/powershell-command-encoding'
export {
  quotePowerShellLiteral as powerShellLiteral,
  quotePowerShellNativeArgument as powerShellNativeArg
} from '../../shared/powershell-native-argument'

// Why: `-EncodedCommand` is not execution-policy gated (only `-File` is), so `-ExecutionPolicy
// Bypass` was a no-op here — and it is one of the most heavily EDR-flagged PowerShell tokens.
// The base64 stays: this string is re-parsed by the remote host's default SSH shell, which may
// be cmd.exe, PowerShell, or bash.
export function powerShellCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`
}
