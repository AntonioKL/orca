/**
 * How long a command line may get before `CreateProcess` refuses it.
 *
 * Windows caps a command line at 32767 characters, and *everything* shares that
 * one budget: the binary, `wsl.exe -d <distro> --exec`, the login-shell wrapper
 * and the payload. So the number only means anything when it is measured on the
 * FINISHED line. Two shipped defects came from measuring a part instead: a
 * script-only threshold in the WSL runner, where a multi-KB login PATH pushed a
 * legal-looking script over the real limit, and count-only chunking of bulk git
 * pathspecs, where the login-shell wrapper tripled the line behind our back.
 *
 * The 2767-character margin absorbs what we do not model exactly (the distro
 * name, libuv's requoting of the outer argv).
 */
export const MAX_COMMAND_LINE_CHARS = 30_000

/**
 * The much smaller cap that applies once cmd.exe is in the chain.
 *
 * cmd.exe refuses a longer line outright — exit 1 and a localized "The command
 * line is too long" — and it is in the chain more often than it looks: Windows
 * OpenSSH runs every exec request through sshd's `DefaultShell`, which is
 * cmd.exe on a stock install. So a command Orca sends to a Windows SSH host is
 * charged this budget, not the 32767 one, and `-EncodedCommand` spends 2.67
 * characters per script character on the way there.
 */
export const CMD_EXE_MAX_COMMAND_LINE_CHARS = 8_191

/**
 * What `CreateProcess` will count.
 *
 * libuv escapes every `"` and doubles a backslash run before a quote, so a
 * quote-dense script costs more than its length. Charging one extra character
 * per `"` or `\\` keeps the estimate on the safe side of the cap; an earlier
 * version claimed to over-count and in fact under-counted, which put a
 * quote-heavy ~26KB script on argv and over the real limit.
 */
export function commandLineLength(args: readonly string[]): number {
  return args.reduce((total, arg) => total + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0), 0)
}
