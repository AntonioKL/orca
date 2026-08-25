import { createHash, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'

const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
const MACOS_SECURITY = '/usr/bin/security'
const LINUX_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/ssl/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem'
]

type WindowsCertificateStore = {
  next(): Uint8Array | undefined
  done(): void
}

type WindowsCaModule = {
  Crypt32: new (store?: string) => WindowsCertificateStore
}

type ReadTextFile = (path: string, encoding: 'utf8') => Promise<string>

type CertificateSources = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  now?: number
  readFile?: ReadTextFile
  runProcess?: (spec: Parameters<typeof runProcess>[0]) => Promise<ProcessResult>
  loadWindowsCaModule?: () => Promise<WindowsCaModule>
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

function derToPem(der: Uint8Array): string {
  const body =
    Buffer.from(der)
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`
}

function readWindowsStore(module: WindowsCaModule, storeName: string): Uint8Array[] {
  const store = new module.Crypt32(storeName)
  const certificates: Uint8Array[] = []
  try {
    let certificate: Uint8Array | undefined
    while ((certificate = store.next())) {
      certificates.push(certificate)
    }
  } finally {
    store.done()
  }
  return certificates
}

async function loadWindowsCertificates(
  loadModule: NonNullable<CertificateSources['loadWindowsCaModule']>,
  now: number
): Promise<string[]> {
  const module = await loadModule()
  const disallowed = new Set(
    readWindowsStore(module, 'Disallowed').map((der) =>
      createHash('sha256').update(der).digest('hex')
    )
  )
  const trusted = readWindowsStore(module, 'ROOT')
    .filter((der) => !disallowed.has(createHash('sha256').update(der).digest('hex')))
    .map(derToPem)
  return filterCurrentCaCertificates(trusted, now)
}

async function loadMacCertificates(
  execute: NonNullable<CertificateSources['runProcess']>,
  now: number
): Promise<string[]> {
  const listed = await execute({
    program: MACOS_SECURITY,
    args: ['find-certificate', '-a', '-p'],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024 * 1024
  })
  if (listed.code !== 0 || listed.timedOut) {
    return []
  }
  const candidates = filterCurrentCaCertificates(parsePemCertificates(listed.stdout), now).filter(
    (pem) => {
      const certificate = new X509Certificate(pem)
      return certificate.checkIssued(certificate)
    }
  )
  const trusted: string[] = []
  for (const certificate of candidates) {
    const verified = await execute({
      program: MACOS_SECURITY,
      args: ['verify-cert', '-c', '/dev/stdin', '-p', 'basic', '-l', '-L', '-q'],
      input: certificate,
      timeoutMs: 5_000
    })
    if (verified.code === 0 && !verified.timedOut) {
      trusted.push(certificate)
    }
  }
  return trusted
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
  try {
    if (platform === 'darwin') {
      return await loadMacCertificates(execute, now)
    }
    if (platform === 'linux') {
      return await loadLinuxCertificates(env, loadFile, now)
    }
    if (platform === 'win32') {
      const loadModule =
        sources.loadWindowsCaModule ??
        (async () => requireFromMain('@vscode/windows-ca-certs') as WindowsCaModule)
      return await loadWindowsCertificates(loadModule, now)
    }
  } catch {
    // Bundled roots remain available if host trust enumeration fails.
  }
  return []
}
