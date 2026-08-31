import { describe, expect, it } from 'vitest'
import { parseOrcaYaml } from '../shared/orca-yaml'
import { resolveWorktreeDependencySeedPlan } from './worktree-dependency-seed-plan'

describe('resolveWorktreeDependencySeedPlan', () => {
  it('uses defaults when dependency seed settings are omitted', () => {
    expect(resolveWorktreeDependencySeedPlan(null)).toEqual({ paths: ['node_modules'] })
    expect(resolveWorktreeDependencySeedPlan({ scripts: {} })).toEqual({ paths: ['node_modules'] })
    expect(resolveWorktreeDependencySeedPlan({ scripts: {}, worktree: {} })).toEqual({
      paths: ['node_modules']
    })
  })

  it('preserves explicit empty arrays as opt-out settings', () => {
    const hooks = parseOrcaYaml(
      ['worktree:', '  dependencySeedPaths: []', '  dependencySeedInputs: []'].join('\n')
    )

    expect(resolveWorktreeDependencySeedPlan(hooks)).toEqual({
      paths: [],
      fingerprintPaths: []
    })
  })

  it('filters unsafe entries while retaining explicit array presence', () => {
    const hooks = parseOrcaYaml(
      [
        'worktree:',
        '  dependencySeedPaths:',
        '    - ../escape',
        '    - /etc/passwd',
        '  dependencySeedInputs:',
        '    - .git/config',
        '    - ./../secret'
      ].join('\n')
    )

    expect(resolveWorktreeDependencySeedPlan(hooks)).toEqual({
      paths: [],
      fingerprintPaths: []
    })
  })

  it('keeps the parser collection bound for oversized path arrays', () => {
    const paths = Array.from({ length: 101 }, (_, index) => `deps/path-${index}`)
    const inputs = Array.from({ length: 101 }, (_, index) => `inputs/file-${index}.json`)
    const hooks = parseOrcaYaml(
      [
        'worktree:',
        '  dependencySeedPaths:',
        ...paths.map((path) => `    - ${path}`),
        '  dependencySeedInputs:',
        ...inputs.map((path) => `    - ${path}`)
      ].join('\n')
    )
    const plan = resolveWorktreeDependencySeedPlan(hooks)

    expect(plan.paths).toHaveLength(100)
    expect(plan.paths).toContain('deps/path-99')
    expect(plan.paths).not.toContain('deps/path-100')
    expect(plan.fingerprintPaths).toHaveLength(100)
    expect(plan.fingerprintPaths).toContain('inputs/file-99.json')
    expect(plan.fingerprintPaths).not.toContain('inputs/file-100.json')
  })

  it('does not collapse nested fingerprint input files', () => {
    const hooks = parseOrcaYaml(
      [
        'worktree:',
        '  dependencySeedInputs:',
        '    - lockfiles',
        '    - lockfiles/pnpm-lock.yaml'
      ].join('\n')
    )
    expect(resolveWorktreeDependencySeedPlan(hooks).fingerprintPaths).toEqual([
      'lockfiles',
      'lockfiles/pnpm-lock.yaml'
    ])
  })
})
