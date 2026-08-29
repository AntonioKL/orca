import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Windows CI lane runs a fixed list of specs on `windows-2022`, and every one of them removes
 * a temporary tree when it is done. On Windows those removals race a handle the OS has not
 * released yet — a just-exited child, an indexer, a dlopen'd native module — so a raw
 * `rmSync(dir, { recursive: true, force: true })` throws EPERM after the test's assertions have
 * all passed, and the lane reports a green test as a failure.
 *
 * `removeTree`/`removeTreeSync` carry the repo's `maxRetries: 8` policy. This keeps the lane on
 * them: a new spec that hand-rolls the removal fails here rather than intermittently on Windows.
 */
const REPO_ROOT = join(__dirname, '..', '..')
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'pr.yml')
const WINDOWS_STEP_NAME = 'Test Windows-specific boundaries'

/** The spec paths the `package (windows)` job passes to vitest, read from the workflow itself. */
function readWindowsLaneSpecs(): string[] {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8')
  const stepIndex = workflow.indexOf(`- name: ${WINDOWS_STEP_NAME}`)
  expect(stepIndex, `${WORKFLOW_PATH} no longer has a "${WINDOWS_STEP_NAME}" step`).toBeGreaterThan(
    -1
  )
  const nextStepIndex = workflow.indexOf('\n      - name:', stepIndex + 1)
  const step = workflow.slice(stepIndex, nextStepIndex === -1 ? undefined : nextStepIndex)
  return step
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(src|tests|config)\/.+\.(test|spec)\.(ts|tsx|mjs)$/.test(line))
}

/** Every recursive removal that does not go through the retrying helper. */
function findRawRecursiveRemovals(source: string): number[] {
  const offenders: number[] = []
  const call = /(?<![\w$.])(?:fs\.)?rm(?:Sync)?\(/g
  let match: RegExpExecArray | null
  while ((match = call.exec(source)) !== null) {
    // Read to the call's closing paren so multi-line option objects are covered.
    let depth = 0
    let end = match.index + match[0].length - 1
    for (; end < source.length; end += 1) {
      if (source[end] === '(') {
        depth += 1
      } else if (source[end] === ')') {
        depth -= 1
        if (depth === 0) {
          break
        }
      }
    }
    const args = source.slice(match.index, end + 1)
    if (!args.includes('recursive')) {
      continue
    }
    if (args.includes('maxRetries')) {
      continue
    }
    offenders.push(source.slice(0, match.index).split('\n').length)
  }
  return offenders
}

describe('windows lane tree removal', () => {
  const specs = readWindowsLaneSpecs()

  it('reads a non-trivial spec list out of the workflow', () => {
    // A parser that silently matched nothing would make every assertion below vacuous.
    expect(specs.length).toBeGreaterThan(10)
    expect(specs).toContain('config/scripts/rebuild-native-deps.test.mjs')
  })

  it('actually detects a raw recursive removal', () => {
    // Without this the scan below passes for any reason at all, including not scanning.
    expect(findRawRecursiveRemovals('rmSync(dir, { recursive: true, force: true })')).toEqual([1])
    expect(
      findRawRecursiveRemovals(
        'await rm(dir, {\n  recursive: true,\n  force: true,\n  maxRetries: 8\n})'
      )
    ).toEqual([])
    // A single-file removal is not this rule's business.
    expect(findRawRecursiveRemovals('rmSync(file, { force: true })')).toEqual([])
  })

  it('removes trees through the retrying helper, never a raw recursive rm', () => {
    const offenders = specs.flatMap((spec) => {
      const source = readFileSync(join(REPO_ROOT, spec), 'utf8')
      return findRawRecursiveRemovals(source).map((line) => `${spec}:${line}`)
    })

    expect(
      offenders,
      'these teardowns can throw EPERM on Windows after their assertions have passed; use removeTree/removeTreeSync from src/shared/windows-transient-lock-removal.ts'
    ).toEqual([])
  })
})
