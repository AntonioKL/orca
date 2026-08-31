import { describe, expect, it } from 'vitest'
import { getServeOptions } from './serve-options'
import { normalizeServeModeArgv } from './serve-mode-argv'

describe('getServeOptions', () => {
  it('parses a valid launch', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-port', '6768', '--serve-no-pairing'])
    ).toEqual({
      json: false,
      wsPort: 6768,
      pairingAddress: null,
      noPairing: true,
      mobilePairing: false,
      recipeJson: false,
      projectRoot: null
    })
  })

  it('accepts equals-form values in the normalized shape', () => {
    expect(
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-port=6768',
        '--serve-pairing-address=127.0.0.1',
        '--serve-project-root=/tmp/repo'
      ])
    ).toMatchObject({
      wsPort: 6768,
      pairingAddress: '127.0.0.1',
      projectRoot: '/tmp/repo'
    })
  })

  it('shares cross-flag validation with the CLI-form launch', () => {
    const argv = normalizeServeModeArgv([
      '/opt/orca/orca-ide',
      'serve',
      '--no-pairing',
      '--mobile-pairing'
    ])
    expect(() => getServeOptions(argv)).toThrow(/either --mobile-pairing or --no-pairing/i)
  })

  it('rejects recipe JSON without runtime pairing and a project root', () => {
    expect(() =>
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-recipe-json',
        '--serve-no-pairing',
        '--serve-project-root',
        '/tmp/repo'
      ])
    ).toThrow(/requires runtime pairing.*--no-pairing/i)
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-recipe-json'])).toThrow(
      /requires --project-root/i
    )
  })

  it('rejects a security-shaped typo while allowing Chromium switches', () => {
    const normalized = normalizeServeModeArgv(['/AppRun', 'serve', '--no-pairng'])
    expect(() => getServeOptions(normalized)).toThrow(/Unknown flag --no-pairng.*--no-pairing/i)
    expect(
      getServeOptions(['/AppRun', '--serve', '--disable-gpu', '--disable-features=Vulkan'])
        .noPairing
    ).toBe(false)
  })

  it('ignores serve-looking arguments after the terminator', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--', '--serve-port', '1', '--serve-no-pairing'])
    ).toEqual({
      json: false,
      pairingAddress: null,
      noPairing: false,
      mobilePairing: false,
      recipeJson: false,
      projectRoot: null
    })
  })

  it('requires a port value', () => {
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-port'])).toThrow(
      'Missing value for --serve-port.'
    )
  })

  it.each(['', '--serve-json', '--'])('rejects an unusable port value %j', (value) => {
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-port', value])).toThrow(
      'Missing value for --serve-port.'
    )
  })
})
