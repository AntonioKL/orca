import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { _internals } from './legacy-wsl-runtime-auth-drain'

const isWindows = process.platform === 'win32'
const SOURCE = '{"tokens":{"expires_at":2000}}\n'
const TARGET = '{"tokens":{"expires_at":1000}}\n'
const NEWER = '{"tokens":{"expires_at":3000}}\n'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function runApply(rewriteAfterHashCall?: number) {
  const root = mkdtempSync(join(tmpdir(), 'orca-drain-race-'))
  const legacy = join(root, 'legacy')
  const target = join(root, 'target')
  const bin = join(root, 'bin')
  mkdirSync(legacy)
  mkdirSync(target)
  mkdirSync(bin)
  const sourcePath = join(legacy, 'auth.json')
  const targetPath = join(target, 'auth.json')
  const marker = join(root, 'marker')
  writeFileSync(sourcePath, SOURCE)
  writeFileSync(targetPath, TARGET)
  const counter = join(root, 'counter')
  writeFileSync(counter, '0')
  const shim = join(bin, 'sha256sum')
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs=require('node:fs'); const crypto=require('node:crypto'); const file=process.argv.at(-1)
process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')+'  '+file+'\\n')
const n=Number(fs.readFileSync(process.env.COUNTER))+1; fs.writeFileSync(process.env.COUNTER,String(n))
if(process.env.REWRITE && n===Number(process.env.REWRITE)) fs.writeFileSync(process.env.TARGET, process.env.BYTES)
`
  )
  chmodSync(shim, 0o755)
  let status = 0
  try {
    execFileSync(
      '/bin/sh',
      [
        '-c',
        _internals.applyLegacyAuthScript,
        'sh',
        legacy,
        join(root, 'active'),
        marker,
        target,
        sha256(SOURCE),
        sha256(TARGET),
        '0',
        '1',
        'missing'
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          COUNTER: counter,
          REWRITE: rewriteAfterHashCall ? String(rewriteAfterHashCall) : '',
          TARGET: targetPath,
          BYTES: NEWER
        },
        stdio: 'ignore'
      }
    )
  } catch (error) {
    status = (error as { status?: number }).status ?? -1
  }
  return {
    status,
    source: existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : null,
    target: readFileSync(targetPath, 'utf8'),
    marker: existsSync(marker)
  }
}

describe.skipIf(isWindows)('legacy WSL auth drain race guard', () => {
  it('retires an unchanged source', () =>
    expect(runApply()).toEqual({ status: 0, source: null, target: TARGET, marker: true }))
  it('retains source when destination is rewritten during validation', () => {
    const outcome = runApply(3)
    expect(outcome.status).toBe(45)
    expect(outcome.source).toBe(SOURCE)
    expect(outcome.target).toBe(NEWER)
    expect(outcome.marker).toBe(false)
  })
})
