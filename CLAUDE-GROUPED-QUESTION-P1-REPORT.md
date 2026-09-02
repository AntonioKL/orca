# Claude grouped-question P1

## Outcome

Implemented the narrow renderer/native-chat fix on top of integrated parent
`256d037d2bc73fbbc812082124e43d064213a391` (the child commit SHA is recorded
after commit). Claude structured question items now retain every grouped
question, per-question multi-select state, per-question free-text capability,
and one shared grouped-answer payload; legacy single-question journal rows keep
their existing option/free-text route.

## Reproduction and coverage

The first red reproduction was `NativeChatQuestionCard > applies free-text
capability per question in a grouped prompt`: the pre-fix card treated a
boolean-array capability as truthy and rendered free text for a listed-only
question. Focused coverage now includes grouped card rendering and answer
selection, shared grouped-answer encode/decode and validation, grouped
multi-select Claude callback settlement, and legacy single-question routing.

## Verification

- Focused Claude/native-chat/shared Vitest: 152 files passed, 1,447 tests
  passed, 2 skipped.
- Node typecheck: `tsc --noEmit -p config/tsconfig.node.json` passed.
- Web typecheck: `tsc --noEmit -p config/tsconfig.tc.web.json` passed.
- Changed-file native and type-aware oxlint passed with no warnings.
- Changed-file `oxfmt --check` passed.
- `pnpm-lock.yaml` is byte-identical to the parent baseline and is not part
  of the change.

## Files

- `src/renderer/src/components/native-chat/NativeChatQuestionCard.test.tsx`
- `src/renderer/src/components/native-chat/NativeChatQuestionCard.tsx`
- `src/renderer/src/components/native-chat/NativeChatStructuredSession.test.tsx`
- `src/renderer/src/components/native-chat/NativeChatStructuredSession.tsx`
- `src/shared/agent-session-question-answer.test.ts`

## Readiness notes

The change only consumes the established journal grouped-question shape and
shared answer codec; no RPC/stream opcode, lease/fence, journal identity,
provider session/leaf, stale-tail, restart/reconnect, SSH, or platform wire
contract was changed. No mobile-facing source was touched; existing mixed
version behavior remains additive through the journal's optional `questions`
field and the legacy top-level projection.

Residual risk: a live Electron/Claude TUI run was not requested for this
implementation; the adapter and renderer contract tests cover the provider
callback and answer payload boundaries.
