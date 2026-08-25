import { createHash, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
const MACOS_SECURITY = '/usr/bin/security'
const MACOS_TRUST_LOAD_TIMEOUT_MS = 10_000
const MACOS_TRUST_VERIFY_CONCURRENCY = 8
const LINUX_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/ssl/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem'
]

type WindowsCaModule = {
  exportSystemCertificatesAsync(options: {
    store: string
    storeTypeList: string[]
  }): Promise<string[]>
}

const WINDOWS_STORE_TYPES = ['CERT_SYSTEM_STORE_LOCAL_MACHINE', 'CERT_SYSTEM_STORE_CURRENT_USER']

type ReadTextFile = (path: string, encoding: 'utf8') => Promise<string>

type CertificateSources = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  now?: number
  readFile?: ReadTextFile
  runProcess?: (spec: Parameters<typeof runProcess>[0]) => Promise<ProcessResult>
  loadWindowsCaModule?: () => Promise<WindowsCaModule>
  trustLoadTimeoutMs?: number
}

const requireFromMain = createRequire(__filename)

function parsePemCertificates(value: string): string[] {
  return value.match(PEM_CERTIFICATE_PATTERN) ?? []
}

function isCurrentCaCertificate(pem: string, now: number): boolean {
  try {
    const certificate = new X509Certificate(pem)
    const validFrom = Date.parse(certificate.validFrom)
    const validTo = Date.parse(certificate.validTo)
    return certificate.ca && validFrom <= now && validTo > now
  } catch {
    return false
  }
}

function filterCurrentCaCertificates(certificates: string[], now: number): string[] {
  return [...new Set(certificates)].filter((pem) => isCurrentCaCertificate(pem, now))
}

function certificateDigest(pem: string): string | undefined {
  try {
    return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
  } catch {
    return undefined
  }
}

async function loadWindowsCertificates(
  loadModule: NonNullable<CertificateSources['loadWindowsCaModule']>,
  now: number
): Promise<string[]> {
  const module = await loadModule()
  const [trusted, blocked] = await Promise.all([
    module.exportSystemCertificatesAsync({ store: 'ROOT', storeTypeList: WINDOWS_STORE_TYPES }),
    module.exportSystemCertificatesAsync({
      store: 'Disallowed',
      storeTypeList: WINDOWS_STORE_TYPES
    })
  ])
  const disallowed = new Set(
    blocked.map(certificateDigest).filter((digest): digest is string => digest !== undefined)
  )
  return filterCurrentCaCertificates(trusted, now).filter((pem) => {
    const digest = certificateDigest(pem)
    return digest !== undefined && !disallowed.has(digest)
  })
}

async function loadMacCertificates(
  execute: NonNullable<CertificateSources['runProcess']>,
  now: number,
  timeoutMs: number
): Promise<string[]> {
  const signal = AbortSignal.timeout(timeoutMs)
  const listed = await execute({
    program: MACOS_SECURITY,
    args: ['find-certificate', '-a', '-p'],
    timeoutMs,
    signal,
    maxOutputBytes: 64 * 1024 * 1024
  })
  if (listed.code !== 0 || listed.timedOut || signal.aborted) {
    return []
  }
  const candidates = filterCurrentCaCertificates(parsePemCertificates(listed.stdout), now).filter(
    (pem) => {
      const certificate = new X509Certificate(pem)
      return certificate.checkIssued(certificate)
    }
  )
  const trusted = await mapWithConcurrency(
    candidates,
    MACOS_TRUST_VERIFY_CONCURRENCY,
    async (certificate): Promise<string | undefined> => {
      const verified = await execute({
        program: MACOS_SECURITY,
        args: ['verify-cert', '-c', '/dev/stdin', '-p', 'basic', '-l', '-L', '-q'],
        input: certificate,
        timeoutMs: 5_000,
        signal
      })
      return verified.code === 0 && !verified.timedOut && !signal.aborted ? certificate : undefined
    }
  )
  return trusted.filter((certificate): certificate is string => certificate !== undefined)
}

function withinDeadline<T>(operation: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs)
    timer.unref()
  })
  return Promise.race([operation, expired]).finally(() => clearTimeout(timer))
}

async function loadLinuxCertificates(
  env: NodeJS.ProcessEnv,
  loadFile: ReadTextFile,
  now: number
): Promise<string[]> {
  const paths = [...(env.SSL_CERT_FILE ? [env.SSL_CERT_FILE] : []), ...LINUX_CA_BUNDLES]
  for (const path of paths) {
    try {
      const certificates = filterCurrentCaCertificates(
        parsePemCertificates(await loadFile(path, 'utf8')),
        now
      )
      if (certificates.length > 0) {
        return certificates
      }
    } catch {
      // Try the next policy-owned bundle location.
    }
  }
  return []
}

export async function loadCaCertificateFile(path: string | undefined): Promise<string[]> {
  if (!path) {
    return []
  }
  try {
    return filterCurrentCaCertificates(
      parsePemCertificates(await readFile(path, 'utf8')),
      Date.now()
    )
  } catch {
    return []
  }
}

export async function loadLegacySystemCaCertificates(
  sources: CertificateSources = {}
): Promise<string[]> {
  const platform = sources.platform ?? process.platform
  const env = sources.env ?? process.env
  const now = sources.now ?? Date.now()
  const loadFile = sources.readFile ?? readFile
  const execute = sources.runProcess ?? runProcess
  const trustLoadTimeoutMs = sources.trustLoadTimeoutMs ?? MACOS_TRUST_LOAD_TIMEOUT_MS
  try {
    if (platform === 'darwin') {
      return await loadMacCertificates(execute, now, trustLoadTimeoutMs)
    }
    if (platform === 'linux') {
      return await loadLinuxCertificates(env, loadFile, now)
    }
    if (platform === 'win32') {
      const loadModule =
        sources.loadWindowsCaModule ??
        (async () => requireFromMain('win-export-certificate-and-key') as WindowsCaModule)
      return await withinDeadline(loadWindowsCertificates(loadModule, now), trustLoadTimeoutMs, [])
    }
  } catch {
    // Bundled roots remain available if host trust enumeration fails.
  }
  return []
}
