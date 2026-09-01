import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * The command-line reader is a patch, not repo source, so its contract is
 * asserted against the patch's post-image. MDE scored the addon for
 * `OpenProcess(PROCESS_VM_READ)` + `ReadProcessMemory` over the whole process
 * table on a timer; these cases exist so a patch refresh cannot quietly restore
 * that primitive.
 */
const PATCH_PATH = resolve(
  import.meta.dirname,
  '../../../config/patches/@vscode__windows-process-tree@0.8.0.patch'
)

/** Reconstruct a file as the patch leaves it: context plus added lines. */
function patchedFile(patch: string, path: string): string {
  const lines = patch.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`diff --git a/${path} `))
  if (start === -1) {
    throw new Error(`${path} is not in the patch`)
  }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('diff --git '))
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((line) => line.startsWith(' ') || line.startsWith('+'))
    .filter((line) => !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}

const patch = readFileSync(PATCH_PATH, 'utf8')
const commandLineSource = patchedFile(patch, 'src/process_commandline.cc')
const processSource = patchedFile(patch, 'src/process.cc')

describe('windows-process-tree command line patch', () => {
  it('prefers ProcessCommandLineInformation over the PEB read', () => {
    // Class 60 is Windows 8.1+; Electron's floor is Windows 10, so every OS
    // Orca supports has it.
    expect(commandLineSource).toContain('kProcessCommandLineInformation = 60')
    const preferred = commandLineSource.indexOf('ReadCommandLineWithoutPeb')
    const fallback = commandLineSource.indexOf('ReadCommandLineFromPeb')
    expect(preferred).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(preferred)
  })

  it('opens the target with PROCESS_QUERY_LIMITED_INFORMATION for the preferred path', () => {
    const preferred = commandLineSource.slice(
      commandLineSource.indexOf('CommandLineOutcome ReadCommandLineWithoutPeb'),
      commandLineSource.indexOf('bool ReadCommandLineFromPeb')
    )
    expect(preferred).toContain('OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION')
    expect(preferred).not.toContain('PROCESS_VM_READ')
    expect(preferred).not.toContain('ReadProcessMemory')
  })

  it('resolves NtQueryInformationProcess dynamically rather than linking it', () => {
    expect(commandLineSource).toContain('GetModuleHandleW(L"ntdll.dll")')
    expect(commandLineSource).toContain('GetProcAddress(ntdll, "NtQueryInformationProcess")')
  })

  it('probes the buffer size before allocating', () => {
    // STATUS_INFO_LENGTH_MISMATCH / STATUS_BUFFER_TOO_SMALL carry the size.
    expect(commandLineSource).toContain(
      'kStatusInfoLengthMismatch = static_cast<NTSTATUS>(0xC0000004L)'
    )
    expect(commandLineSource).toContain(
      'kStatusBufferTooSmall = static_cast<NTSTATUS>(0xC0000023L)'
    )
    expect(commandLineSource).toMatch(
      /query\(process, kProcessCommandLineInformation, nullptr, 0, &size\)/
    )
  })

  it('keeps the PEB read reachable only when the kernel lacks the info class', () => {
    expect(commandLineSource).toContain(
      'kStatusInvalidInfoClass = static_cast<NTSTATUS>(0xC0000003L)'
    )
    expect(commandLineSource).toContain('kStatusNotSupported = static_cast<NTSTATUS>(0xC00000BBL)')
    expect(commandLineSource).toContain(
      'kStatusNotImplemented = static_cast<NTSTATUS>(0xC0000002L)'
    )
    // A pid that refuses PROCESS_QUERY_LIMITED_INFORMATION cannot grant the
    // strictly stronger PROCESS_QUERY_INFORMATION the PEB read needs, so an
    // unreachable process must not re-arm the VM_READ open.
    expect(commandLineSource).toMatch(/case kProcessUnreachable:\s*\n\s*return false;/)
    expect(commandLineSource).toContain('InterlockedExchange(&g_command_line_class_missing, 1)')
  })

  it('encodes both paths through one UTF-8 conversion', () => {
    // String identity is load-bearing: callers match agent identity on these
    // strings, so quoting and trailing whitespace must survive either path.
    const conversions = commandLineSource.match(/WideCharToMultiByte\(/g) ?? []
    expect(conversions).toHaveLength(2) // size probe + convert, both inside StoreCommandLineUtf8
    expect(commandLineSource.match(/StoreCommandLineUtf8\(process_info/g)).toHaveLength(2)
  })

  it('leaves no PROCESS_VM_READ acquisition anywhere but the PEB fallback', () => {
    // The Memory and CPU readers took VM_READ and never used it; that acquisition
    // is itself what EDR scores.
    expect(processSource).not.toMatch(/OpenProcess\([^)]*PROCESS_VM_READ/)
    expect(processSource.match(/OpenProcess\(PROCESS_QUERY_LIMITED_INFORMATION/g)).toHaveLength(2)
    const fallback = commandLineSource.slice(
      commandLineSource.indexOf('bool ReadCommandLineFromPeb')
    )
    expect(fallback.match(/OpenProcess\([^)]*PROCESS_VM_READ/g)).toHaveLength(1)
  })
})

const addonRequire = createRequire(import.meta.url)
type Addon = {
  getProcessList: (
    callback: (rows: { pid: number; commandLine?: string }[] | undefined) => void,
    flags: number
  ) => void
}

// Why so tolerant: the binary is optional, Windows-only, and normally compiled
// against Electron's ABI, so a Node-runtime load can legitimately fail.
// Skipping beats failing for reasons unrelated to the reader.
const addon: Addon | null = (() => {
  if (process.platform !== 'win32') {
    return null
  }
  try {
    const packageEntry = addonRequire.resolve('@vscode/windows-process-tree')
    return addonRequire(
      join(packageEntry, '..', '..', 'build', 'Release', 'windows_process_tree.node')
    ) as Addon
  } catch {
    return null
  }
})()

describe.runIf(addon !== null)('windows-process-tree command line addon', () => {
  const children: { kill: () => void }[] = []
  afterAll(() => {
    for (const child of children) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  })

  const scan = async (): Promise<Map<number, string>> =>
    new Promise((resolveScan) => {
      addon!.getProcessList((rows) => {
        resolveScan(new Map((rows ?? []).map((row) => [row.pid, row.commandLine ?? ''])))
      }, 2 /* ProcessDataFlag.CommandLine */)
    })

  it('recovers command lines byte-for-byte, quoting and trailing spaces included', async () => {
    const marker = `orca-cmdline-${Date.now()}`
    // Quotes and trailing whitespace are exactly what a re-quoting bug would eat.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', `"${marker}"  `], {
      windowsHide: true,
      stdio: 'ignore'
    })
    children.push(child)
    await new Promise((r) => setTimeout(r, 400))

    const rows = await scan()
    const command = rows.get(child.pid!)
    expect(command).toBeDefined()
    expect(command).toContain(marker)
    expect(command!.endsWith('  "') || command!.endsWith('  ')).toBe(true)
  })

  it('reports the querying process and most of the table', async () => {
    const rows = await scan()
    expect(rows.has(process.pid)).toBe(true)
    const recovered = [...rows.values()].filter((command) => command.length > 0)
    // Protected and cross-session processes legitimately deny a handle; a
    // wholesale regression would show up as almost nothing recovered.
    expect(recovered.length).toBeGreaterThan(rows.size * 0.25)
  })
})
