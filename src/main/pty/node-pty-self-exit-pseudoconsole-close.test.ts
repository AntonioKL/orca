import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A shell that exits by itself must still close its pseudoconsole.
 *
 * `ClosePseudoConsole` is the only thing that reaps a ConPTY's console host —
 * Orca's own job-ownership patch says so, because `CreatePseudoConsole` spawns
 * that host before the per-pty job exists and it is therefore not a job member.
 * Upstream node-pty calls it from exactly one place, `PtyKill`, which begins by
 * looking the baton up by id — and the exit watcher in `SetupExitCallback`
 * erased the baton the moment the shell died. So on the self-exit path (typing
 * `exit`, which is how panes usually close) that lookup missed, `PtyKill` did
 * nothing at all, and the pseudoconsole was never closed.
 *
 * Measured on Windows 11 / awin, 20 self-exit cycles, handles bucketed by NT
 * object type, per terminal:
 *
 *   relay spawn (no useConptyDll)   before  +1 Process +2 File   after  FLAT
 *   desktop spawn (useConptyDll)    before  +1 Process +5 File   after  +4 File
 *
 * The desktop residue is a *separate* defect in the `useConptyDll` branch of
 * `WindowsPtyAgent.kill()`, which disposes the conout worker only from an
 * `_outSocket.on('data')` handler — and no more data arrives after the shell has
 * gone. That one is tracked with F23; both are needed for the desktop to be flat.
 *
 * WHY THIS IS A PATCH-CONTENT PIN AND NOT A BEHAVIOURAL TEST: the defect is
 * only observable as a per-NT-type handle count, which needs
 * `NtQuerySystemInformation(SystemExtendedHandleInformation)`. Nothing in the
 * repo can read that, and the cheaper Windows-observable proxies do not
 * discriminate — the console host process is reaped either way (the leak is a
 * handle to an already-exited object, not an orphaned process), and the
 * `\\.\pipe\conpty-*` entries disappear either way. Both were measured and
 * rejected as assertions rather than assumed. So this pins the mechanism
 * instead, which is the real risk: a future resync of the vendored patch
 * silently dropping the hunk.
 */

const PATCH = readFileSync(join(__dirname, '../../../config/patches/node-pty@1.1.0.patch'), 'utf8')

describe('node-pty patch: pseudoconsole close on the self-exit path', () => {
  it('does not let the exit watcher free the baton while the close is still owed', () => {
    // Pinned as one block: the erase must stay INSIDE the consoleClosed guard.
    // Upstream ran it unconditionally, which is the line that caused the leak,
    // and a resync that re-flattens this is the failure mode worth catching.
    expect(PATCH).toContain(
      [
        '+      baton->shellExited = true;',
        '+      if (baton->consoleClosed) {',
        '+        const bool removed = remove_pty_baton(baton->id);',
        '+        assert(removed);',
        '+        (void)removed;',
        '+      }'
      ].join('\n')
    )
  })

  it('closes the pseudoconsole from PtyKill even after the shell has exited', () => {
    // hpc is copied out under the lock, so the close survives the baton's removal.
    expect(PATCH).toContain('+      hpc = handle->hpc;')
    expect(PATCH).toContain('+        pfnClosePseudoConsole(hpc);')
  })

  it('never terminates through a shell handle the watcher may have closed', () => {
    // The watcher nulls hShell on exit; upstream dereferenced it unconditionally.
    expect(PATCH).toContain('+      if (useConptyDll && handle->hShell != nullptr) {')
    expect(PATCH).not.toMatch(/^\+\s*TerminateProcess\(handle->hShell, 1\);/m)
  })

  it('keeps the close idempotent so a second kill cannot double-close', () => {
    expect(PATCH).toContain('+    if (handle != nullptr && !handle->consoleClosed) {')
    expect(PATCH).toContain('+      handle->consoleClosed = true;')
  })
})
