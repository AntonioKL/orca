import { describe, expect, it } from 'vitest'
import { getServeFlagTypoError, getServeOptionValidationError } from './serve-option-validation'

const validOptions = {
  noPairing: false,
  mobilePairing: false,
  recipeJson: false,
  projectRoot: null
}

describe('getServeOptionValidationError', () => {
  it('accepts compatible options', () => {
    expect(getServeOptionValidationError(validOptions)).toBeNull()
  })

  it.each([
    [{ noPairing: true, mobilePairing: true }, /either --mobile-pairing or --no-pairing/i],
    [
      { recipeJson: true, noPairing: true, projectRoot: '/tmp/repo' },
      /requires runtime pairing.*--no-pairing/i
    ],
    [
      { recipeJson: true, mobilePairing: true, projectRoot: '/tmp/repo' },
      /requires runtime pairing.*--mobile-pairing/i
    ],
    [{ recipeJson: true }, /requires --project-root/i]
  ])('rejects incompatible options', (override, expected) => {
    expect(
      getServeOptionValidationError({ ...validOptions, ...override } as typeof validOptions)
    ).toMatch(expected)
  })
})

describe('getServeFlagTypoError', () => {
  it('accepts exact serve flags and arbitrary Chromium switches', () => {
    expect(
      getServeFlagTypoError([
        '/opt/orca/orca-ide',
        '--serve',
        '--serve-no-pairing',
        '--disable-gpu',
        '--disable-features=Vulkan'
      ])
    ).toBeNull()
  })

  it.each(['--no-pairng', '--no-paring', '--mobile-pairng'])(
    'suggests the intended pairing flag for %s',
    (flag) => {
      expect(getServeFlagTypoError(['/opt/orca/orca-ide', '--serve', flag])).toMatch(
        /Unknown flag .*Did you mean --(?:no-pairing|mobile-pairing)\?/i
      )
    }
  )

  it('does not reinterpret tokens after --', () => {
    expect(getServeFlagTypoError(['/opt/orca/orca-ide', '--serve', '--', '--no-pairng'])).toBeNull()
  })
})
