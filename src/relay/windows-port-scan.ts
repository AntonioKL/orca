import { readWindowsProcessTable } from '../main/windows/windows-process-table'
import { runProcess } from '../shared/child-process/run-process'
import {
  windowsPowerShellPath,
  windowsSystem32Binary
} from '../shared/child-process/windows-system-binary'
import { getProcessOutputFields } from '../shared/process-output-field-scanner'
import type { DetectedPort } from './port-scan-handler'
import { buildRelayCommandEnv } from './relay-command-env'

const SYSTEM_PORTS_TO_EXCLUDE = new Set([22])
const MAX_DETECTED_PORTS = 50
const WINDOWS_PORT_SCAN_TIMEOUT_MS = 5_000
// Wide enough for `netstat -ano` on a busy host: it prints every connection, not
// just the listeners, and a truncated table silently drops the tail.
const WINDOWS_PORT_SCAN_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Listening TCP ports, attributed to their owning process.
 *
 * `netstat.exe -ano` answers all of it except the process name, and the name
 * comes from the shared native process table -- so the ordinary scan starts no
 * PowerShell at all. It used to start one first: `-ExecutionPolicy Bypass
 * -EncodedCommand <base64>` wrapping `Get-NetTCPConnection` joined to
 * `Get-Process`. Base64 beside a policy override is the highest-weighted token
 * pair Defender for Endpoint scores on a PowerShell command line, and listing
 * listeners with their owners reads as network discovery (T1049) on top of it.
 * That payload survives only as the last resort below, without the override.
 */
export async function scanWindowsListeningPorts(signal?: AbortSignal): Promise<DetectedPort[]> {
  const netstatPorts = await readWindowsNetstatPorts(signal)
  if (netstatPorts) {
    return normalizeWindowsDetectedPorts(await attachWindowsProcessNames(netstatPorts))
  }
  if (signal?.aborted) {
    return []
  }
  try {
    const json = await runWindowsPortScanPowerShell(signal)
    return normalizeWindowsDetectedPorts(parseWindowsPowerShellPortRows(json))
  } catch {
    return []
  }
}

/** Rows, or null when netstat could not answer and the fallback should run. */
async function readWindowsNetstatPorts(signal?: AbortSignal): Promise<DetectedPort[] | null> {
  let stdout: string
  try {
    const result = await runProcess({
      program: windowsSystem32Binary('netstat.exe'),
      // No `-p tcp`: on Windows that protocol name means TCP over IPv4 only, so
      // it hides every `[::]` listener the retired PowerShell payload reported.
      args: ['-ano'],
      env: buildRelayCommandEnv(),
      timeoutMs: WINDOWS_PORT_SCAN_TIMEOUT_MS,
      maxOutputBytes: WINDOWS_PORT_SCAN_MAX_OUTPUT_BYTES,
      signal
    })
    if (result.timedOut || result.code !== 0) {
      return null
    }
    stdout = result.stdout
  } catch {
    return null
  }
  const ports = parseWindowsNetstatOutput(stdout)
  // Windows always has a listener (RPC endpoint mapper, SMB), so an exit-0 scan
  // that parses to nothing is a reader that was blocked, not an idle host.
  return ports.length > 0 ? ports : null
}

/**
 * Fill in owning-process names from the shared native snapshot.
 *
 * Names are optional data — the panel renders host/port/pid without them — so a
 * host that cannot read the table keeps its rows rather than forking a shell of
 * its own. See docs/reference/windows-process-enumeration.md.
 */
async function attachWindowsProcessNames(ports: DetectedPort[]): Promise<DetectedPort[]> {
  const pids = new Set(ports.flatMap((port) => (port.pid == null ? [] : [port.pid])))
  if (pids.size === 0) {
    return ports
  }
  let names: Map<number, string>
  try {
    const rows = await readWindowsProcessTable()
    names = new Map(
      rows.flatMap((row) =>
        pids.has(row.pid) && row.name ? [[row.pid, stripExecutableSuffix(row.name)] as const] : []
      )
    )
  } catch {
    return ports
  }
  return ports.map((port) => {
    const processName = port.pid == null ? undefined : names.get(port.pid)
    return processName ? { ...port, processName } : port
  })
}

// The process table reports `sshd.exe`; the retired `Get-Process` payload
// reported `sshd`. The sshd filter below and every client that already renders
// these rows read the bare name, so keep publishing that spelling.
function stripExecutableSuffix(name: string): string {
  return name.replace(/\.exe$/i, '')
}

/**
 * Single line so it survives as one argv element regardless of how the
 * shell-less spawn hands it to PowerShell's `-Command` parser. Exported so
 * windows-port-scan.win32.test.ts can run it: a missing `;` between statements
 * is a parse error the mocked tests cannot see.
 */
export const WINDOWS_PORT_SCAN_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  'Get-NetTCPConnection -State Listen | ForEach-Object {',
  '$connection = $_; $name = $null;',
  'try { $name = (Get-Process -Id $connection.OwningProcess -ErrorAction Stop).ProcessName } catch { };',
  '[pscustomobject]@{ host = [string]$connection.LocalAddress; port = [int]$connection.LocalPort;',
  'pid = [int]$connection.OwningProcess; processName = $name }',
  '} | ConvertTo-Json -Compress -Depth 3'
].join(' ')

async function runWindowsPortScanPowerShell(signal?: AbortSignal): Promise<string> {
  let lastError: unknown

  for (const program of [windowsPowerShellPath(), 'pwsh.exe']) {
    try {
      const result = await runProcess({
        program,
        // No `-ExecutionPolicy` override: the policy gates script *files*, never
        // `-Command`. Verified on Windows 11 — `-ExecutionPolicy Restricted
        // -Command` still runs, while `-File` against an unsigned .ps1 does not.
        args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PORT_SCAN_SCRIPT],
        env: buildRelayCommandEnv(),
        timeoutMs: WINDOWS_PORT_SCAN_TIMEOUT_MS,
        maxOutputBytes: WINDOWS_PORT_SCAN_MAX_OUTPUT_BYTES,
        signal
      })
      if (signal?.aborted) {
        throw new Error('windows port scan aborted')
      }
      if (result.timedOut || result.code !== 0) {
        lastError ??= new Error(
          `windows port scan PowerShell failed (code=${result.code} timedOut=${result.timedOut})`
        )
        continue
      }
      return result.stdout
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      lastError ??= error
    }
  }

  throw lastError ?? new Error('PowerShell unavailable')
}

export function parseWindowsPowerShellPortRows(json: string): DetectedPort[] {
  const trimmed = json.trim()
  if (!trimmed) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) => parseWindowsPortRow(row))
}

export function parseWindowsNetstatOutput(output: string): DetectedPort[] {
  const rows: DetectedPort[] = []

  for (const line of output.split(/\r?\n/)) {
    const fields = getProcessOutputFields(line, 5)
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') {
      continue
    }
    if (fields[3].toUpperCase() !== 'LISTENING') {
      continue
    }
    const hostPort = parseWindowsNetstatAddress(fields[1])
    const pid = Number.parseInt(fields[4], 10)
    if (!hostPort || !Number.isSafeInteger(pid) || pid <= 0) {
      continue
    }
    rows.push({ ...hostPort, pid })
  }

  return rows
}

function parseWindowsPortRow(row: unknown): DetectedPort[] {
  if (!row || typeof row !== 'object') {
    return []
  }
  const value = row as {
    host?: unknown
    LocalAddress?: unknown
    port?: unknown
    LocalPort?: unknown
    pid?: unknown
    OwningProcess?: unknown
    processName?: unknown
    ProcessName?: unknown
  }
  const host = readString(value.host ?? value.LocalAddress)
  const port = readInteger(value.port ?? value.LocalPort)
  const pid = readInteger(value.pid ?? value.OwningProcess)
  const processName = readString(value.processName ?? value.ProcessName)
  if (!host || port == null || pid == null) {
    return []
  }
  return [
    {
      host,
      port,
      pid,
      ...(processName ? { processName } : {})
    }
  ]
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseWindowsNetstatAddress(value: string): { host: string; port: number } | null {
  const ipv6Match = /^\[(.*)\]:(\d+)$/.exec(value)
  const portText = ipv6Match?.[2] ?? value.slice(value.lastIndexOf(':') + 1)
  const port = Number.parseInt(portText, 10)
  if (!Number.isSafeInteger(port) || port <= 0) {
    return null
  }
  if (ipv6Match) {
    return { host: ipv6Match[1], port }
  }
  const idx = value.lastIndexOf(':')
  if (idx <= 0) {
    return null
  }
  return { host: value.slice(0, idx), port }
}

function normalizeWindowsDetectedPorts(ports: DetectedPort[]): DetectedPort[] {
  const seen = new Set<string>()
  const relayPid = process.pid
  const relayParentPid = process.ppid
  const normalized: DetectedPort[] = []

  for (const port of ports) {
    const processName = port.processName?.toLowerCase()
    const key = `${port.host}:${port.port}:${port.pid ?? ''}`
    if (
      seen.has(key) ||
      SYSTEM_PORTS_TO_EXCLUDE.has(port.port) ||
      port.pid === relayPid ||
      port.pid === relayParentPid ||
      processName === 'sshd'
    ) {
      continue
    }
    seen.add(key)
    normalized.push(port)
  }

  normalized.sort((a, b) => a.port - b.port || a.host.localeCompare(b.host))
  return normalized.slice(0, MAX_DETECTED_PORTS)
}
