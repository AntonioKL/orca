import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectChangedFiles,
  findProvenanceMarkers,
  main,
  PROVENANCE_MARKERS
} from './check-local-reference-provenance.mjs'

// Why split: a spelled-out marker would make this file trip the gate it pins.
function marker(...parts) {
  return parts.join('')
}

const TRIPS = [
  {
    markerId: 'local-checkout-path',
    text: marker(' *   ~/pro', 'jects/ghostty/src/input/keyboard.zig:25-57 (Layout enum)')
  },
  {
    markerId: 'reference-implementation-citation',
    text: marker(' * Reference imple', 'mentation in Ghostty:')
  },
  {
    markerId: 'reference-repo-citation',
    text: marker('// Behaviour confirmed in the refer', 'ence repos.')
  },
  {
    markerId: 'precedent-audit',
    text: marker('- Preced', 'ent audit: two projects solve this the same way.')
  },
  {
    markerId: 'absence-claim',
    text: marker('- Preced', 'ent check: no pri', 'or art for this shape.')
  },
  {
    markerId: 'repo-survey-claim',
    text: marker('// Surve', 'yed the OSS repos before choosing this name.')
  }
]

// Real lines from the tree that name public projects Orca integrates with, cite
// Orca's own history, or use home-dir fixture paths. All must stay passing.
const MUST_NOT_TRIP = [
  " * we could run). We match Ghostty's taxonomy: US / US-International map to",
  ' * explicit override. Matches Ghostty (Ghostty only whitelists',
  ' * com.apple.keylayout.US and com.apple.keylayout.USInternational).',
  ' * `detectOptionAsAlt`, which whitelists only `com.apple.keylayout.US`',
  '    // Matches Ghostty: only US and USInternational-PC are allowlisted;',
  '// Reference implementation: the old eager rolling-string append the buffer',
  "    coordinator.observeTitle('~/projects/app')",
  "    const b = project('b', 'scratch', '~/src/scratch')",
  "      expectedPath: '~/src/file.ts'",
  "    expect(getAgentLabel('~/projects/codex-scratch')).toBeNull()",
  "await writeFile(join(realSkill, 'SKILL.md'), '# ref-oss\\n\\nUse local OSS reference repos.')",
  '  // must not count as snapshot-backed (changed from the ported prior art).',
  '// This split is without precedent in the renderer, so it ships behind a flag.'
]

const tempDirs = []

function git(root, args) {
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'gate',
      GIT_AUTHOR_EMAIL: 'gate@example.invalid',
      GIT_COMMITTER_NAME: 'gate',
      GIT_COMMITTER_EMAIL: 'gate@example.invalid'
    }
  })
}

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-reference-provenance-'))
  tempDirs.push(root)
  git(root, ['init'])
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  writeFileSync(path.join(root, 'note.ts'), '// Matches Ghostty behaviour.\n', 'utf8')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'base'])
  return {
    root,
    baseSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('local reference provenance markers', () => {
  it.each(TRIPS)('flags $markerId', ({ markerId, text }) => {
    expect(findProvenanceMarkers(text).map((finding) => finding.markerId)).toContain(markerId)
  })

  it('covers every declared marker with a tripping fixture', () => {
    expect(TRIPS.map((trip) => trip.markerId).sort()).toEqual(
      PROVENANCE_MARKERS.map((declared) => declared.id).sort()
    )
  })

  it.each(MUST_NOT_TRIP)('leaves legitimate line alone: %s', (line) => {
    expect(findProvenanceMarkers(line)).toEqual([])
  })

  // Why: the gate scans its own sources whenever they change, so an unassembled
  // marker in either file would make editing the gate impossible to land.
  it.each(['check-local-reference-provenance.mjs', 'check-local-reference-provenance.test.mjs'])(
    'keeps %s free of its own markers',
    (file) => {
      const source = readFileSync(path.join(import.meta.dirname, file), 'utf8')
      expect(findProvenanceMarkers(source)).toEqual([])
    }
  )
})

describe('changed-file gate', () => {
  it('fails on a changed file carrying provenance and passes once removed', () => {
    const { root, baseSha } = makeRepo()
    writeFileSync(
      path.join(root, 'note.ts'),
      `// Matches Ghostty behaviour.\n${TRIPS[0].text}\n`,
      'utf8'
    )
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'leak'])
    expect(main(root, baseSha)).toBe(1)

    writeFileSync(path.join(root, 'note.ts'), '// Matches Ghostty behaviour.\n', 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'clean'])
    expect(main(root, baseSha)).toBe(0)
  })

  it('scans new untracked files and skips unchanged ones', () => {
    const { root } = makeRepo()
    writeFileSync(path.join(root, 'untouched.md'), `${TRIPS[1].text}\n`, 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'pre-existing'])

    const { files: unchangedFiles } = collectChangedFiles(root, 'main')
    expect(unchangedFiles).toEqual([])
    expect(main(root, 'main')).toBe(0)

    writeFileSync(path.join(root, 'new-note.md'), `${TRIPS[2].text}\n`, 'utf8')
    expect(collectChangedFiles(root, 'main').files).toContain('new-note.md')
    expect(main(root, 'main')).toBe(1)
  })
})
