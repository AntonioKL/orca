import { describe, expect, it } from 'vitest'
import { isNativePtyException } from './daemon-native-pty-exception'

describe('isNativePtyException', () => {
  it.each([
    new Error('write EAGAIN'),
    new Error('read EIO'),
    new Error('Pty process exited'),
    Object.assign(new Error('write failed'), { code: 'EPIPE' })
  ])('contains native PTY failures without killing the daemon', (error) => {
    expect(isNativePtyException(error)).toBe(true)
  })

  it.each([new Error('database invariant failed'), new TypeError('logic bug'), 'EAGAIN'])(
    'does not suppress unrelated or malformed failures',
    (error) => {
      expect(isNativePtyException(error)).toBe(false)
    }
  )
})
