import { describe, expect, it } from 'vitest'
import { mobileNativeBaselineMode } from './mobile-native-baseline-mode'

describe('mobile native baseline mode', () => {
  it('allows the exact runner flag in a development build', () => {
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: '1' })).toBe(true)
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: undefined })).toBe(false)
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: 'true' })).toBe(false)
  })

  it('defaults release builds to native and development builds to hybrid', () => {
    expect(mobileNativeBaselineMode({ developmentBuild: false, requested: undefined })).toBe(true)
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: undefined })).toBe(false)
  })

  it('opts release builds into hybrid architecture explicitly', () => {
    expect(
      mobileNativeBaselineMode({
        developmentBuild: false,
        requested: undefined,
        architecture: 'hybrid'
      })
    ).toBe(false)
    expect(
      mobileNativeBaselineMode({
        developmentBuild: false,
        requested: undefined,
        architecture: 'native'
      })
    ).toBe(true)
  })

  it('does not allow the development baseline flag in production', () => {
    expect(mobileNativeBaselineMode({ developmentBuild: false, requested: '1' })).toBe(true)
  })
})
