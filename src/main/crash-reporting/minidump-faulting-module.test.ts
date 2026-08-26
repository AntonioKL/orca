import { describe, expect, it } from 'vitest'
import { chromiumLinkedImageNames, dumpPathBasename } from './minidump-faulting-module'

// The resolver itself is covered through parseMinidumpCrashSignature, which
// exercises it against real Crashpad-layout dumps.
describe('chromiumLinkedImageNames', () => {
  it('names the app executable on Windows and Linux', () => {
    expect(chromiumLinkedImageNames('C:\\Program Files\\Orca\\Orca.exe', 'win32')).toEqual([
      'Orca.exe'
    ])
    expect(chromiumLinkedImageNames('/opt/Orca/orca', 'linux')).toEqual(['orca'])
  })

  it('names the framework on macOS, where the app executable is a stub', () => {
    expect(
      chromiumLinkedImageNames('/Applications/Orca.app/Contents/MacOS/Orca', 'darwin')
    ).toEqual(['Electron Framework'])
  })

  it('claims no product image rather than an empty name', () => {
    expect(chromiumLinkedImageNames('', 'linux')).toEqual([])
  })
})

describe('dumpPathBasename', () => {
  it('handles both separators, since a dump may be read on another OS', () => {
    expect(dumpPathBasename('C:\\Windows\\System32\\KERNELBASE.dll')).toBe('KERNELBASE.dll')
    expect(dumpPathBasename('/usr/lib/libc.so.6')).toBe('libc.so.6')
    expect(dumpPathBasename('bare')).toBe('bare')
  })
})
