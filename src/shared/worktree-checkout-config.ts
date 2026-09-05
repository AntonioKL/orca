export function worktreeCheckoutGitArgs(
  options: { wslDistro?: string } = {},
  platform: NodeJS.Platform = process.platform
): string[] {
  // Four workers halved native Mac checkout time; Git before 2.32 ignores this config.
  return platform === 'darwin' && !options.wslDistro ? ['-c', 'checkout.workers=4'] : []
}
