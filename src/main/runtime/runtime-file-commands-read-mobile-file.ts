// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithConstructor } from './runtime-file-commands-constructor'
import type { RuntimeFileReadResult } from '../../shared/runtime-types'
import {
  isMobileBinaryPath,
  isSafeMobileRelativePath
} from './runtime-file-commands-runtime-file-command-host-4'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import { readLocalMobileFile } from './runtime-file-commands-assert-runtime-path-does-not-exist-5'
import { truncateMobileFilePreview } from './runtime-file-commands-local-terminal-artifact-roots-6'

export class RuntimeFileCommandsWithReadMobileFile extends RuntimeFileCommandsWithConstructor {
  async readMobileFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileReadResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    if (isMobileBinaryPath(relativePath)) {
      throw new Error('binary_file')
    }

    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    const content = connectionId
      ? await this.readRemoteMobileFile(filePath, connectionId)
      : await readLocalMobileFile(filePath, store)
    const truncated = truncateMobileFilePreview(content)

    return {
      worktree: worktree.id,
      relativePath,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }
}
