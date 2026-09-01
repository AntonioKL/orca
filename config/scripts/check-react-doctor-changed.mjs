import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

const requestedBase =
  process.argv.slice(2).find((argument) => argument !== '--') ??
  process.env.ORCA_CODE_QUALITY_BASE ??
  'origin/main'
const base = resolvePullRequestDiffBase(process.cwd(), requestedBase)
// Why the shim and not a direct binary: `dlx` fetches react-doctor on demand, so
// only the pnpm CLI can run it. resolvePnpmCliInvocation picks the shell-free
// `node <pnpm cli>` form whenever npm_execpath exposes one.
const { command, prefixArgs, shell } = resolvePnpmCliInvocation()
const result = spawnSync(
  command,
  [
    ...prefixArgs,
    'dlx',
    'react-doctor@0.9.1',
    '.',
    '--yes',
    '--scope',
    'lines',
    '--base',
    base,
    '--include-untracked',
    '--no-dead-code',
    '--no-supply-chain',
    '--no-telemetry',
    '--blocking',
    'error'
  ],
  { stdio: 'inherit', shell, windowsHide: true }
)

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
