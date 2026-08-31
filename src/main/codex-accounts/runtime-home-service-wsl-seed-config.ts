import { parseWslUncPath } from '../../shared/wsl-paths'
import { prepareSystemConfigForFreshRuntimeMirror } from '../codex/codex-config-mirror'

// Codex resolves relative config paths from its Linux-side home in WSL.
export function prepareWslRuntimeSeedConfig(
  configContents: string,
  sourceHomePath: string
): string {
  return prepareSystemConfigForFreshRuntimeMirror(
    configContents,
    parseWslUncPath(sourceHomePath)?.linuxPath ?? sourceHomePath
  )
}
