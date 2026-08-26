import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { openTerminalContextMenu } from './helpers/terminal-pane-title-actions'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries
} from './helpers/terminal-pty-write-spy'
import {
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type FakeAgentReport = {
  composerReady: boolean
  contractOk: boolean
  hasBracketedPasteFrame: boolean
  inputChunksHex: string[]
  inputHex: string
  markerReceived: boolean
  prematureEnters: number
  receivedEnters: number
  submitted: boolean
}

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-quick-command-agent-submit-'))
const fixtureBin = path.join(fixtureRoot, 'bin')
const fixtureReport = path.join(fixtureRoot, 'report.json')
const fixtureMarker = `ORCA_QUICK_COMMAND_SUBMIT_${process.pid}`
const fixtureScript = path.join(process.cwd(), 'tests', 'tools', 'repro-terminal-send-submit.mjs')
const fakeCodex = path.join(fixtureBin, process.platform === 'win32' ? 'codex.cmd' : 'codex')
const prompt = `${fixtureMarker} ${'deterministic quick command payload '.repeat(16)}`
const normalizedPrompt = prompt.trim()

mkdirSync(fixtureBin)
if (process.platform === 'win32') {
  writeFileSync(
    fakeCodex,
    `@echo off\r\n"${process.execPath}" "${fixtureScript}" --fake-agent --report "${fixtureReport}" --marker "${fixtureMarker}" --allow-unframed-paste %*\r\n`,
    'utf8'
  )
} else {
  symlinkSync(process.execPath, fakeCodex)
}
const fakeCodexCommand =
  process.platform === 'win32'
    ? buildFakeAgentCommandOverride(fakeCodex)
    : [
        fakeCodex,
        fixtureScript,
        '--fake-agent',
        '--report',
        fixtureReport,
        '--marker',
        fixtureMarker
      ]
        .map((value) => buildFakeAgentCommandOverride(value))
        .join(' ')

test.use({
  orcaAppExtraEnv: {
    PATH: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`
  }
})

test.afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function readReport(): FakeAgentReport | null {
  try {
    return JSON.parse(readFileSync(fixtureReport, 'utf8')) as FakeAgentReport
  } catch {
    return null
  }
}

test('Quick Command submits a settled prompt to an active Codex TUI', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(90_000)
  rmSync(fixtureReport, { force: true })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const tabId = await orcaPage.evaluate(
    async ({ fakeCodexCommand, prompt, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      const state = store.getState()
      await state.updateSettings({
        terminalQuickCommands: [
          {
            id: 'e2e-agent-submit',
            label: 'Submit deterministic prompt',
            scope: { type: 'global' },
            action: 'terminal-command',
            command: prompt,
            appendEnter: true
          }
        ]
      })
      const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: 'codex' })
      state.queueTabStartupCommand(tab.id, {
        command: fakeCodexCommand,
        launchAgent: 'codex',
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'tab_bar_quick_launch',
          request_kind: 'new'
        }
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
      return tab.id
    },
    { fakeCodexCommand, prompt, worktreeId }
  )

  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await expect
    .poll(() => getTerminalContent(orcaPage), { message: 'Fake Codex TUI did not render' })
    .toContain('OpenAI Codex')
  await installTerminalPtyWriteSpy(electronApp)
  await clearTerminalPtyWriteLog(electronApp)

  await openTerminalContextMenu(orcaPage)
  await orcaPage.getByRole('menuitem', { name: 'Quick Commands' }).hover()
  await orcaPage.getByRole('menuitem', { name: 'Submit deterministic prompt' }).click()

  await expect
    .poll(readReport, { message: 'Fake TUI did not emit a complete state report' })
    .toMatchObject({ submitted: true })
  const report = readReport()
  const writes = (await readTerminalPtyWriteEntries(electronApp))
    .filter((entry) => entry.id === ptyId)
    .map((entry) => entry.data)
  const receivedChunks = report?.inputChunksHex.map((hex) => Buffer.from(hex, 'hex').toString())
  console.log(JSON.stringify({ tabId, ptyId, writes, receivedChunks, report }))

  // The fake TUI records the exact bytes observed on its PTY stdin. The main-process
  // IPC spy is intentionally only diagnostic here because settled runtime sends can
  // write directly through the provider rather than the renderer IPC channel.
  expect(report?.inputHex).toBe(
    Buffer.from(`\x1b[200~${normalizedPrompt}\x1b[201~\r`, 'utf8').toString('hex')
  )
  expect(receivedChunks).toEqual([`\x1b[200~${normalizedPrompt}\x1b[201~`, '\r'])
  expect(report).toMatchObject({
    composerReady: true,
    contractOk: true,
    hasBracketedPasteFrame: true,
    markerReceived: true,
    prematureEnters: 0,
    receivedEnters: 1,
    submitted: true
  })
  await expect
    .poll(() => getTerminalContent(orcaPage), { message: 'Visible TUI submission marker missing' })
    .toContain('ORCA_TERMINAL_SEND_REPORT ok')
})
