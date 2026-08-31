import { levenshtein } from './edit-distance'

export type ServeOptionValidationInput = {
  noPairing: boolean
  mobilePairing: boolean
  recipeJson: boolean
  projectRoot: string | null | undefined
}

export function getServeOptionValidationError(options: ServeOptionValidationInput): string | null {
  if (options.noPairing && options.mobilePairing) {
    return 'Use either --mobile-pairing or --no-pairing, not both.'
  }
  if (options.recipeJson && options.noPairing) {
    return 'Recipe JSON output requires runtime pairing; remove --no-pairing.'
  }
  if (options.recipeJson && options.mobilePairing) {
    return 'Recipe JSON output requires runtime pairing; remove --mobile-pairing.'
  }
  if (options.recipeJson && !options.projectRoot) {
    return 'Recipe JSON output requires --project-root.'
  }
  return null
}

const SERVE_SECURITY_FLAG_NAMES = [
  '--no-pairing',
  '--serve-no-pairing',
  '--mobile-pairing',
  '--serve-mobile-pairing',
  '--recipe-json',
  '--serve-recipe-json',
  '--pairing-address',
  '--serve-pairing-address'
] as const

function flagName(token: string): string {
  const equalsIndex = token.indexOf('=')
  return equalsIndex === -1 ? token : token.slice(0, equalsIndex)
}

/** Reject only near-miss pairing flags; Electron/Chromium switches stay open-ended. */
export function getServeFlagTypoError(argv: readonly string[]): string | null {
  for (const token of argv) {
    if (token === '--') {
      break
    }
    if (!token.startsWith('--')) {
      continue
    }
    const name = flagName(token)
    let suggestion: string | null = null
    let bestDistance = 3
    for (const candidate of SERVE_SECURITY_FLAG_NAMES) {
      const distance = levenshtein(name, candidate)
      if (distance > 0 && distance < bestDistance) {
        suggestion = candidate
        bestDistance = distance
      }
    }
    if (suggestion) {
      return `Unknown flag ${name}. Did you mean ${suggestion}?`
    }
  }
  return null
}
