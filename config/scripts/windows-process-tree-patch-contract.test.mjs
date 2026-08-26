import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')

describe('Windows process-tree patch contract', () => {
  it('keeps the patch byte-compatible with its CRLF sources', () => {
    const patchBytes = readFileSync(
      join(projectDir, 'config/patches/@vscode__windows-process-tree@0.8.0.patch')
    )
    const patchHash = createHash('sha256')
      .update(patchBytes.toString('utf8').replaceAll('\r\n', '\n'))
      .digest('hex')
    const lockfile = readFileSync(join(projectDir, 'pnpm-lock.yaml'), 'utf8')

    expect(
      patchBytes.includes(Buffer.from('-          "msvs_configuration_attributes": {\r\n'))
    ).toBe(true)
    expect(
      patchBytes.includes(
        Buffer.from(
          '-    } while (process_count < 1024 && Process32Next(snapshot_handle, &process_entry));\r\n'
        )
      )
    ).toBe(true)
    expect(lockfile).toContain(`hash: ${patchHash}`)
  })
})
