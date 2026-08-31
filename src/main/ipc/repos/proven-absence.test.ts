import { describe, expect, it } from 'vitest'
import { isNotADirectory, isProvenAbsent } from './proven-absence'

describe('proven-absence', () => {
  it('trusts a string errno over the message', () => {
    expect(isProvenAbsent(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    // The message names ENOENT only inside a path; a definite EACCES must win.
    expect(
      isProvenAbsent(
        Object.assign(
          new Error("EACCES: denied, access '/a/ENOENT: no such file or directory/.git'"),
          {
            code: 'EACCES'
          }
        )
      )
    ).toBe(false)
  })

  it('falls back to the message when no string code survived the relay', () => {
    // The SSH relay replaces string errnos with -32000, so this is the remote shape.
    expect(
      isProvenAbsent(
        Object.assign(new Error('ENOENT: no such file or directory, stat ...'), { code: -32000 })
      )
    ).toBe(true)
  })

  it('fails closed instead of throwing on a hostile or absent error shape', () => {
    const hostile = {
      get code(): string {
        throw new Error('boom')
      }
    }
    expect(() => isProvenAbsent(hostile)).not.toThrow()
    expect(isProvenAbsent(hostile)).toBe(false)
    expect(isProvenAbsent(null)).toBe(false)
    expect(isProvenAbsent(undefined)).toBe(false)
    expect(() => isNotADirectory(null)).not.toThrow()
  })

  it('recognises ENOTDIR as a definite answer', () => {
    expect(isNotADirectory(Object.assign(new Error('x'), { code: 'ENOTDIR' }))).toBe(true)
    expect(isNotADirectory(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false)
  })
})
