# Early local fleet projection inventory

## Existing production consumers retained

- `orchestration.workerList` is registered through `ORCHESTRATION_WORKER_RELEASE_METHODS` and consumed by `src/cli/handlers/orchestration/worker-terminal-handlers.ts`. The response keeps the existing `workers` and `counts` fields; each bounded worker row gains `projection`, and the response gains `page`.
- `src/main/runtime/orca-runtime.ts#buildAgentOrchestrationByPaneKey` remains the source of runtime-authoritative Dispatch context published by `syncWindowGraph`.
- `src/renderer/src/runtime/sync-runtime-graph.ts` continues writing that publication through `setRuntimeAgentOrchestrationByPaneKey` into the existing agent-status slice.
- `src/renderer/src/store/slices/agent-status.ts` continues merging runtime context into its existing live and retained status maps.
- `src/renderer/src/components/sidebar/worktree-agent-orchestration-index.ts` continues indexing those maps for worktree consumers. No renderer polling or second fleet store was added.

## New composition boundary

- `src/shared/orchestration-fleet-projection.ts` is a pure, renderer-independent projection. It joins durable worker-list rows to the existing push-fed agent-status snapshot by stable pane key or terminal handle.
- `src/main/runtime/rpc/methods/orchestration-worker-release.ts` is the only new production caller. It performs no terminal reads, liveness probes, federated show/read calls, or per-worker remote calls.
- The RPC returns stable Dispatch/Task/Run IDs, worker role and parent Task, provider/model metadata, opaque host/workspace identity, durable and live stage evidence, `live`/`unverifiable`/`exited` liveness, typed resource absence, and a conservative next action.

## Bounds and deferred work

- Pages are capped at 100 rows and continue after a stable Dispatch ID. Push rows are indexed once per call, then joined in linear time.
- Prompt, tool input, assistant-message, interactive-prompt, provider-session, and transcript bodies never enter the returned projection.
- Remote batching, negotiated capabilities, partial-host budgets, and notification policy are intentionally unchanged and remain later validation work.
