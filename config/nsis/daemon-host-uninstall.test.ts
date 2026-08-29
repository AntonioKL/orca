import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('daemon-host-uninstall.nsh', () => {
  it('implements an idempotent DACL repair without aggressive sweeping flags', () => {
    const source = readFileSync(join(__dirname, 'daemon-host-uninstall.nsh'), 'utf-8')
    
    // Must contain the well-known S-1-15-2-2 SID to fix the DACL cluster
    expect(source).toContain('icacls "$INSTDIR" /grant *S-1-15-2-2:(OI)(CI)(RX)')
    
    // Must NOT contain sweeping or destructive flags
    expect(source).not.toMatch(/\/T\b/i)
    expect(source).not.toMatch(/\/reset\b/i)
    expect(source).not.toMatch(/\(F\)|\(M\)|\(W\)/)
    expect(source).not.toMatch(/ALL APPLICATION PACKAGES/i) // No English principal name
  })
})