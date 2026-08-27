import { runWslProcess } from '../wsl/wsl-runner'

const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CAPTURE_BYTES = MAX_RESPONSE_BYTES + 64 * 1024

const WSL_PROBE_SCRIPT = String.raw`
set -u
log_dir="$HOME/.gemini/antigravity-cli/log"
if [ ! -d "$log_dir" ]; then
  printf 'ORCA_AGY_NOT_RUNNING'
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  printf 'ORCA_AGY_UNVERIFIABLE'
  exit 0
fi
candidates=$(find "$log_dir" -maxdepth 1 -type f -name 'cli-*.log' -print 2>/dev/null | sort -r | sed -n '1,12p')
if [ -z "$candidates" ]; then
  printf 'ORCA_AGY_NOT_RUNNING'
  exit 0
fi
response_file=$(mktemp "\${TMPDIR:-/tmp}/orca-agy-quota.XXXXXX") || {
  printf 'ORCA_AGY_UNVERIFIABLE'
  exit 0
}
trap 'rm -f "$response_file"' EXIT HUP INT TERM
found_live=0
while IFS= read -r log_file; do
  [ -n "$log_file" ] || continue
  log_head=$(dd if="$log_file" bs=8192 count=1 2>/dev/null) || continue
  pid=$(printf '%s\n' "$log_head" | sed -n 's/.*Starting language server process with pid \([0-9][0-9]*\).*/\1/p' | sed -n '1p')
  [ -n "$pid" ] || continue
  kill -0 "$pid" 2>/dev/null || continue
  found_live=1
  http_port=$(printf '%s\n' "$log_head" | sed -n 's/.*random port at \([0-9][0-9]*\) for HTTP$/\1/p' | sed -n '1p')
  https_port=$(printf '%s\n' "$log_head" | sed -n 's/.*random port at \([0-9][0-9]*\) for HTTPS.*/\1/p' | sed -n '1p')
  for target in "http:$http_port" "https:$https_port"; do
    scheme=\${target%%:*}
    port=\${target#*:}
    [ -n "$port" ] || continue
    : > "$response_file"
    insecure=''
    [ "$scheme" = 'https' ] && insecure='--insecure'
    status=$(curl --silent --show-error $insecure --connect-timeout 2.5 --max-time 2.5 \
      --max-filesize 1048576 --output "$response_file" --write-out '%{http_code}' \
      --header 'content-type: application/json' --header 'connect-protocol-version: 1' \
      --request POST --data '{}' \
      "$scheme://127.0.0.1:$port/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary" \
      2>/dev/null)
    curl_code=$?
    if [ "$curl_code" -eq 0 ]; then
      printf 'ORCA_AGY_RESPONSE %s\n' "$status"
      cat "$response_file"
      exit 0
    fi
    if [ "$curl_code" -eq 63 ]; then
      printf 'ORCA_AGY_RESPONSE_TOO_LARGE'
      exit 0
    fi
  done
done <<ORCA_AGY_LOGS
$candidates
ORCA_AGY_LOGS
if [ "$found_live" -eq 0 ]; then
  printf 'ORCA_AGY_NOT_RUNNING'
else
  printf 'ORCA_AGY_UNVERIFIABLE'
fi
`

export type AntigravityWslProbeResult =
  | { kind: 'response'; statusCode: number; body: string }
  | { kind: 'not-running' }
  | { kind: 'unverifiable'; reason: string }

export async function probeAntigravityQuotaInWsl(
  wslDistro: string | null,
  signal?: AbortSignal
): Promise<AntigravityWslProbeResult> {
  const result = await runWslProcess({
    script: WSL_PROBE_SCRIPT,
    shell: 'sh',
    loginPath: 'preferred',
    ...(wslDistro ? { distro: wslDistro } : {}),
    timeoutMs: 30_000,
    maxOutputBytes: MAX_CAPTURE_BYTES,
    signal
  })
  if (signal?.aborted) {
    throw signal.reason
  }
  if (result.timedOut || result.code !== 0 || result.stdout === 'ORCA_AGY_UNVERIFIABLE') {
    return { kind: 'unverifiable', reason: 'Antigravity quota could not be verified in WSL' }
  }
  if (result.stdout === 'ORCA_AGY_NOT_RUNNING') {
    return { kind: 'not-running' }
  }
  if (result.stdout === 'ORCA_AGY_RESPONSE_TOO_LARGE') {
    return { kind: 'unverifiable', reason: 'Antigravity quota response too large' }
  }
  const match = /^ORCA_AGY_RESPONSE (\d{3})\n/.exec(result.stdout)
  if (!match) {
    return { kind: 'unverifiable', reason: 'Antigravity quota response was unreadable in WSL' }
  }
  const body = result.stdout.slice(match[0].length)
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    return { kind: 'unverifiable', reason: 'Antigravity quota response too large' }
  }
  return { kind: 'response', statusCode: Number(match[1]), body }
}
