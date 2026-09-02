# Pane-agent ladder decision table

This table is the review gate for the ladder-unification plan. It uses the exhaustive signal model
from PR #17711 at `d288820ee3`: seven slots (focused live hook, sibling live hook, focused
completed hook, sibling completed hook, foreground process, sleeping session, and launch record),
each taking `∅`, agent A, or agent B; four title kinds (blank, neutral/no-agent, A, B); and local
or remote scope: `3^7 × 4 × 2 = 17,496` shapes. A fresh process proof names the foreground-process
slot and includes all required freshness fields (`capturedAgeMs` and `validForMs`).

## Exhaustive result

| Canonical rung selected in a disagreeing shape | Signal class (remaining slots are unrestricted) | What the shipping tab ladder selected | Canonical decision | Count |
| --- | --- | --- | --- | ---: |
| `launch` | Launch is A or B; foreground process has no value; no live focused hook. The old result is the completed-hook agent opposite launch. | Completed hook | Launch record | 396 |
| `launch` | Launch is A or B; foreground process has no value; no live focused hook. The old result is the sleeping-session agent opposite launch. | Sleeping session | Launch record | 144 |
| `launch` | Launch is A or B; foreground process has no value; no live focused hook. The old result is the title agent opposite launch. | Title | Launch record | 72 |
| `completed-hook` | Launch and foreground process have no value; completed hook is A or B; no sleeping-session identity. The old result is the title agent opposite the completed hook. | Title | Completed hook | 36 |
| **Total** |  |  |  | **648** |

Counts include both agent names, both local/remote values, all sibling values, and the four title
kinds. They are intentionally grouped by the rung selected by the canonical side, so a reviewer can
rule on each conflict without relying on an aggregate disagreement counter. No residual shape has a
valid process proof: where one exists, the process rung is selected before launch and the old and
canonical process answers agree.

## Process-versus-launch rule

The 1,872 shapes that flip when a valid proof is supplied are the process-starvation artifact in the
proof-free input. In every shape where the host proves a recognized foreground process, that proof
wins over launch (and over completed/sleeping/title evidence); a matching launch and process name is
the same answer, and an absent/expired/mismatched proof does not promote a bare process name. This is
the answer to the central question: **a fresh host proof wins over a launch record; the 648 residual
shapes are the no-process-proof surface in which launch or completed-hook wins over weaker evidence.**

For the record, the same harness produces the supplied totals:

| Process proof | Disagreements | Canonical source breakdown |
| --- | ---: | --- |
| Omitted (proof-free input) | 2,520 | launch 1,908; completed-hook 468; sleeping-session 144 |
| Fresh and valid | 648 | launch 612; completed-hook 36; sleeping-session 0 |
| Answer changes when proof is added | 1,872 | process rung (the starved-rung artifact) |

If `capturedAgeMs` or `validForMs` is omitted from the fixture, freshness rejects the proof and the
harness incorrectly reproduces 2,520 instead of 648. The test must write its result artifact with
`writeFileSync` (Vitest intercepts console output) and fail on either total or source breakdown.
