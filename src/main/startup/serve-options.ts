import {
  getServeFlagTypoError,
  getServeOptionValidationError
} from '../../shared/serve-option-validation'

export type ServeOptions = {
  json: boolean
  wsPort?: number
  pairingAddress: string | null
  noPairing: boolean
  mobilePairing: boolean
  recipeJson: boolean
  projectRoot: string | null
}

function optionsBeforeTerminator(argv: readonly string[]): readonly string[] {
  const terminatorIndex = argv.indexOf('--')
  return terminatorIndex === -1 ? argv : argv.slice(0, terminatorIndex)
}

function valueAfter(argv: readonly string[], flag: string, required: boolean): string | null {
  const assignmentPrefix = `${flag}=`
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token.startsWith(assignmentPrefix)) {
      const value = token.slice(assignmentPrefix.length)
      if (value || !required) {
        return value || null
      }
      throw new Error(`Missing value for ${flag}.`)
    }
    if (token !== flag) {
      continue
    }
    const value = argv[index + 1]
    if (value && !value.startsWith('--')) {
      return value
    }
    if (required) {
      throw new Error(`Missing value for ${flag}.`)
    }
    return null
  }
  return null
}

export function getServeOptions(argv: readonly string[]): ServeOptions {
  const optionsArgv = optionsBeforeTerminator(argv)
  const typoError = getServeFlagTypoError(optionsArgv)
  if (typoError) {
    throw new Error(typoError)
  }

  const rawPort = valueAfter(optionsArgv, '--serve-port', true)
  let wsPort: number | undefined
  if (rawPort) {
    const parsedPort = Number(rawPort)
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid --serve-port value: ${rawPort}`)
    }
    wsPort = parsedPort
  }

  const options: ServeOptions = {
    json: optionsArgv.includes('--serve-json'),
    ...(wsPort !== undefined ? { wsPort } : {}),
    pairingAddress: valueAfter(optionsArgv, '--serve-pairing-address', false),
    noPairing: optionsArgv.includes('--serve-no-pairing'),
    mobilePairing: optionsArgv.includes('--serve-mobile-pairing'),
    recipeJson: optionsArgv.includes('--serve-recipe-json'),
    projectRoot: valueAfter(optionsArgv, '--serve-project-root', false)
  }
  const validationError = getServeOptionValidationError(options)
  if (validationError) {
    throw new Error(validationError)
  }
  return options
}
