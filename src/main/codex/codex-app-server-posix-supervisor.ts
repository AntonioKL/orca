import type { CodexAppServerLaunch } from './codex-app-server-connection'

/** Inline supervisor source kept dependency-free for the spawned Node child. */
export const POSIX_PROVIDER_SUPERVISOR_SCRIPT = `
const { spawn } = require('node:child_process')
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
const childEnv = { ...process.env }
delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
const originalParent = process.ppid
let timer
let ownerShutdownTimer
let ownerLost = false
const terminateOwnedGroup = () => {
  if (ownerLost) return
  ownerLost = true
  clearInterval(timer)
  try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(137) }
}
const scheduleOwnerShutdown = () => {
  if (ownerShutdownTimer) return
  // A normal close ends the provider's stdin first; allow it to flush and
  // exit before forcing the group, while still bounding an orphaned child.
  ownerShutdownTimer = setTimeout(terminateOwnedGroup, 1500)
  ownerShutdownTimer.unref()
}
process.stdin.once('end', scheduleOwnerShutdown)
process.stdin.once('close', scheduleOwnerShutdown)
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
for (const stream of [process.stdin, child.stdin, child.stdout, child.stderr]) stream.on('error', () => {})
timer = setInterval(() => {
  // A detached supervisor is reparented when its owner exits. The new parent
  // may be PID 1 or a platform subreaper, so any parent change is proof that
  // this process group no longer has a live Orca owner.
  if (process.ppid !== originalParent) {
    terminateOwnedGroup()
  }
}, 100)
timer.unref()
child.once('error', () => {
  clearInterval(timer)
  process.exit(127)
})
child.once('exit', (code, signal) => {
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
`

export function supervisedPosixLaunch(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  cwd = launch.cwd ?? process.cwd()
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const supervisorSpec = Buffer.from(
    JSON.stringify({
      command: launch.command,
      args: launch.args,
      cwd
    })
  ).toString('base64')
  return {
    command: process.execPath,
    args: ['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT],
    // Electron's executable needs Node mode for the inline supervisor. The
    // marker is removed above so providers never inherit Electron semantics.
    env: {
      ...childEnv,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_PROVIDER_SUPERVISOR_SPEC: supervisorSpec
    }
  }
}

export function createProviderSpawnSpec(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): { program: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; detached: boolean } {
  const supervised = platform === 'win32' ? null : supervisedPosixLaunch(launch, childEnv)
  return {
    program: supervised?.command ?? launch.command,
    args: supervised?.args ?? launch.args,
    env: supervised?.env ?? childEnv,
    cwd: launch.cwd ?? process.cwd(),
    detached: platform !== 'win32'
  }
}
