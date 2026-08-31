import { describe, expect, it } from 'vitest'
import {
  buildDaemonShellReadyWrapperFiles,
  getDaemonShellReadyWrapperPaths
} from './daemon-shell-ready-wrapper-fileset'

describe('daemon shell-ready wrapper fileset', () => {
  it('keeps required paths aligned with generated files', () => {
    const root = '/tmp/orca-shell-ready'
    expect(getDaemonShellReadyWrapperPaths(root)).toEqual(
      buildDaemonShellReadyWrapperFiles(root).map(([path]) => path)
    )
  })
})
