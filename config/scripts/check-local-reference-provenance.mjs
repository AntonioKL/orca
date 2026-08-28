import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'

// Why this gate exists: the `ref-oss` workflow reads open-source projects from
// local checkouts. Its output — home-directory checkout citations, headers that
// name the source that was read, and precedent/absence findings —
// must never reach a shipped file. PR #909 carried such citations into the
// renderer for four months because nothing looked at comment text.
//
// Naming a public project is NOT the leak and must keep passing: Orca
// integrates with several, and behavioural claims about them are real
// documentation. Only the reading-session provenance is rejected.

// Why assembled from fragments: this file is itself a changed file whenever the
// marker set is edited, so a spelled-out marker here would trip its own gate.
function phrase(...words) {
  return words.join(String.raw`\s+`)
}

export const PROVENANCE_MARKERS = [
  {
    id: 'local-checkout-path',
    hint: 'Local reference-checkout path. Cite the public project by name instead.',
    // Two path segments after the prefix: `~/projects/app` is an ordinary
    // fixture path, `~/projects/<repo>/<file>` is a citation into a checkout.
    pattern: /~[\\/](?:projects|repos|src|code|dev|work|oss|github)[\\/][\w.-]+[\\/][\w.-]/i
  },
  {
    id: 'reference-implementation-citation',
    hint: 'Reading-session citation header. State the behaviour, not the source you read.',
    pattern: new RegExp(phrase('reference', 'implementation', 'in') + String.raw`\b`, 'i')
  },
  {
    id: 'reference-repo-citation',
    hint: 'Citation pointing at a local reference checkout.',
    pattern: new RegExp(
      String.raw`\b(?:in|from|across|against|per|within)\s+(?:the\s+|our\s+|these\s+|those\s+)?(?:local\s+)?(?:oss\s+)?` +
        phrase('reference', 'repos?') +
        String.raw`\b`,
      'i'
    )
  },
  {
    id: 'precedent-audit',
    hint: 'Precedent-audit framing from a reference sweep.',
    pattern: /\bprecedent (?:audit|check|sweep|survey)\b/i
  },
  {
    id: 'absence-claim',
    hint: 'Absence claim sourced from a reference sweep.',
    pattern:
      /\b(?:no|zero|found no)\s+(?:known\s+)?(?:precedent|prior art)\b|\bprior[- ]art\s+(?:survey|audit|check|sweep)\b/i
  },
  {
    id: 'repo-survey-claim',
    hint: 'Survey-of-repositories framing from a reference sweep.',
    pattern:
      /\b(?:surveyed|audited|reviewed)\s+(?:all\s+|\d+\s+|the\s+)?(?:local\s+)?(?:oss|open[- ]source|reference)\s+repos?\b|\b(?:none|neither)\s+of\s+the\s+(?:surveyed|reference|audited)\s+repos?\b/i
  }
]

const SCANNABLE_FILE_PATTERN =
  /\.(?:[cm]?[jt]sx?|md|mdx|json|jsonc|ya?ml|txt|sh|zsh|bash|ps1|py|rs|go|css|html|toml)$/i
// Why a size cap rather than a name list: generated manifests and lockfiles are
// the only files this large, and a cap needs no maintenance as they are renamed.
const MAX_SCANNED_BYTES = 1024 * 1024

export function findProvenanceMarkers(text) {
  const findings = []
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    for (const marker of PROVENANCE_MARKERS) {
      if (marker.pattern.test(line)) {
        findings.push({
          markerId: marker.id,
          hint: marker.hint,
          line: index + 1,
          text: line.trim()
        })
      }
    }
  }
  return findings
}

function runGit(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function splitNullDelimited(output) {
  return output.split('\0').filter(Boolean)
}

function resolveBase(root, requestedBase) {
  for (const candidate of [
    requestedBase,
    process.env.ORCA_PROVENANCE_BASE,
    'origin/main',
    'main'
  ]) {
    if (!candidate) {
      continue
    }
    const result = spawnSync('git', ['rev-parse', '--verify', `${candidate}^{commit}`], {
      cwd: root,
      stdio: 'ignore'
    })
    if (result.status === 0) {
      return candidate
    }
  }
  throw new Error('Pass the pull request base SHA or make origin/main available locally.')
}

export function collectChangedFiles(root, requestedBase) {
  const base = resolveBase(root, requestedBase)
  const mergeBase = runGit(root, ['merge-base', base, 'HEAD']).trim()
  const comparisonBase = resolvePullRequestDiffBase(root, mergeBase)
  const changed = splitNullDelimited(
    runGit(root, ['diff', '--name-only', '-z', '--diff-filter=ACMRTUB', comparisonBase, '--'])
  )
  const untracked = splitNullDelimited(
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
  const files = [...new Set([...changed, ...untracked])].filter((file) => {
    if (!SCANNABLE_FILE_PATTERN.test(file)) {
      return false
    }
    const absolutePath = path.join(root, file)
    return existsSync(absolutePath) && statSync(absolutePath).size <= MAX_SCANNED_BYTES
  })
  return { base, comparisonBase, files }
}

function annotationValue(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

export function main(
  root = process.cwd(),
  requestedBase = process.argv.slice(2).find((argument) => argument !== '--')
) {
  const { base, comparisonBase, files } = collectChangedFiles(root, requestedBase)
  if (files.length === 0) {
    console.log(`Reference-provenance gate: no changed text files since ${base}.`)
    return 0
  }

  let failures = 0
  for (const file of files) {
    const findings = findProvenanceMarkers(readFileSync(path.join(root, file), 'utf8'))
    for (const finding of findings) {
      failures += 1
      const message = `${finding.hint} (${finding.markerId})`
      console.error(
        `::error file=${annotationValue(file)},line=${finding.line},title=${annotationValue('local reference provenance')}::${annotationValue(message)}`
      )
      console.error(`${file}:${finding.line} ${finding.markerId}: ${finding.hint}`)
    }
  }

  if (failures > 0) {
    console.error(
      `Reference-provenance gate failed with ${failures} finding(s) across ${files.length} changed file(s). Remove the citation; keep the technical claim.`
    )
    return 1
  }
  console.log(
    `Reference-provenance gate passed across ${files.length} changed file(s) since ${comparisonBase.slice(0, 12)}.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
