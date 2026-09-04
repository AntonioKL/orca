# Relay reconnect investigation: findings and evidence

Working notes for the 2026-09-04 mobile relay reconnect incident and the cell roll that follows.
Kept current across context compactions. Newest section first. All times UTC. Host ids are log digests,
never raw ids. Nothing here is a production mutation record unless the "Mutations" section says so.

## Status board

| Item | State | Where |
|---|---|---|
| PR #18565 relay accept abandonment + lease jitter + desktop rotation spread + phone probe fail-fast | Open, CI green (23), CodeRabbit + Pullfrog cleared, 3 review rounds | https://github.com/stablyai/orca/pull/18565 |
| PR #18569 monitor `relayPostgresRetryExhausted` 0 -> 300 | **Merged** 2026-09-04 ~04:20Z as 4101505b6b | https://github.com/stablyai/orca/pull/18569 |
| Same-cap `verify` of c7 (read-only) | **Passed** run 33836527159 | confirms identities, selector gen 110, rehome gen 12, protocol 1, digests |
| Monitor dry-run #1 | Froze min 5: `relay.postgres_retries` 380 > 300 | run 33836470590 |
| Monitor dry-run #2 | Green to min 13, froze 04:49Z: `director.concurrency` 76.7 > 64 (six-cell crash storm, Finding 6) | run 33837160275 |
| Monitor dry-run #3 | Froze min 3 at 05:01Z: `relay.postgres_retries` 339 > 300; no crash, concurrency 5–8 | run 33838698725 |
| Owner decision 2026-09-04 ~05:10Z | **Option B approved**: "you can raise the bar. or remove it altogether ... whats the most logical move". Kept the bar (removal would leave contention unwatched during the roll) and recalibrated from measured data. | this thread |
| PR #18580 monitor `relayPostgresRetries` 300 -> 2000 | Open, awaiting CI; mutation-checked (300 fails the new test) | https://github.com/stablyai/orca/pull/18580 |
| PR #18565 CI | Was red on `root directory guard` because this findings file sat at repo root; moved to `cloud/docs/` in 8ebff89106 | |
| Cell canary / batch roll | **Not dispatched.** No production mutation has happened. | |
| Terraform alert `relay_postgres_retry_exhausted` at `> 0` | Firing continuously since #18521; recalibration not done (own change) | `cloud/infra/terraform/relay-observability.tf:447,469` |

## Mutations performed (complete list)

1. Merged PR #18569 to main (code/docs only).
2. Nothing else. Both monitor dispatches were `mode=dry-run` (read-only). The same-cap dispatch was `mode=verify` (read-only, confirmed by step gates `if: inputs.mode != 'verify'` on every mutating step).

## Finding 6 (2026-09-04 ~05:00Z): the old cell image crashes the whole process on a Postgres connect timeout

**This is the most important open finding.** The 23 GCE cells run image `sha256:5aedbca5…` = orca-cloud
commit e3e92d95d3 (2026-08-14). In that build `beginProof` is called as `void this.beginProof(...)`.
When `verifyCellAssignment` inside it throws (pg-pool `timeout exceeded when trying to connect`, 2 s
`connectionTimeoutMillis`), the rejection is unhandled and Node exits 1. Docker restarts the container
in ~1 s, but every control on that cell (~800 hosts) drops and re-dials `/v1/assign` at once.

Evidence, cell c7 instance 4545742188814054238, 2026-09-04:

```
04:46:47.951 stderr [orca-relay] control activity renewal failed   (x5)
04:46:49.527 stderr Error: timeout exceeded when trying to connect
             at pg-pool/index.js:45:11
             at async PostgresPoolPressure.connect (postgres-pool-pressure.js:30:20)
             at async PostgresDatabase.query (database.js:645:24)
             at async RelayAssignmentStore.verifyCellAssignment (assignment-store.js:2024:22)
             at async HostSessionRegistry.beginProof (host-session-registry.js:376:15)
04:46:49.527 stderr Node.js v24.19.0
04:46:49.835 dockerd: container die … exitCode=1 image=…relay@sha256:5aed…
04:46:50.258 dockerd: container start
04:46:52.761 stdout [orca-relay] listening on https://c7.relay.onorca.dev
```

Fleet-wide `container die … exitCode=1` on the relay image, last 48 h: **201 events on 19 instances**
(c28 x38, c29 x37, c27 x19). Hourly counts track the lock-contention curve (peak 23/h at 21Z Sep 3).
Every one has the same `Node.js v24…` crash banner. On 2026-09-04 04:46:35–04:47:41Z six cells
(c7, c8, c19, c21, c22, c25) died within 66 s: ~4,800 hosts re-dialed, `/v1/assign` returned 16,321
503s in one minute (baseline ~20), director concurrency hit 85 (Cloud Run cap 80), Cloud SQL
`new_connection_count` 119 -> 287/min. Fleet recovered by 04:51Z. That is what froze dry-run #2.

Fix status: `guardSessionTask` wrapping `beginProof` landed in orca-cloud #436 (2026-08-27) and is in
the target image `sha256:85bf6799…` (main 11aace8dec). The roll is the fix. Not caused by anything in
this session: the same-cap verify finished ~04:25Z and never reached a mutating step; no compute
operations exist for those instances; heap/event-loop were flat before the crash.

Implication for the gate: the monitor's `director.concurrency` freeze is *correctly* detecting these
crash storms. A dry-run only passes in a 15-minute window with no cell crash, roughly 1 in 3 windows
at current rates. Retrying in quiet hours is legitimate; the bar is not wrong.

## Finding 5: `relay.postgres_retries` at 300 is 3x under today's baseline

Retries per 5 min, cells + director, last 24 h: p50 579, p90 1039, p99 1398, max 1505; **65% of
windows over 300**. Quiet hours (03–08Z) p50 235, max 512. When the 300 bar was set (2026-08-26)
healthy bursts reached 234. Baseline has roughly tripled in 10 days. Skill notes say do not raise this
bar; I have not. Best odds for a clean 15 min are 02–04Z and 17–18Z (9/12 five-minute windows under
300 in each).

## Finding 4: exhausted-retry bar was the wrong single blocker (fixed)

`relayPostgresRetryExhausted: 0` never cleared after #18521 reached the director (22:12Z Sep 3): 236/236
five-minute windows non-zero; post-#18521 p50 42 / p90 147 / max 220; Aug 23 incident peak 467.
Recalibrated to 300 in #18569 (merged). Dry-run #1 immediately revealed Finding 5 behind it.

## Finding 3: the 00:50Z control-close wave was desktop lease rotation, not a rollout

2026-09-04 00:49–00:51Z: 2,745 control closes on 19 instances; 1157/1632 code 1006 and 973/1030 code
4408 `control rebound` had ageMs in the 53-minute bin. Relay grants a flat 55 min lease; desktops
rebind 60–120 s early; so every host that (re)connected in the same minute rebinds as one cohort
forever. Seed: c27 MIG autoheal recreate 23:23Z (`compute.instances.repair.recreateInstance`) dumped
~420 controls. Harmonics at 23:55, 00:04, 00:25, 00:49Z. Each rebind is an `activateControl`
transaction that can take the inventory lock. Fix in #18565: relay lease 55 min ± 5 min (symmetric,
so mean rebind rate unchanged), desktop early window 1–6 min.

## Finding 2: fleet-wide lock contention, worse on Sep 3

| window | 55P03 retries/h (cells) | cell sqlFailures/h |
|---|---|---|
| Sep 2 18Z – Sep 3 07Z | 660–1470 | 680–1620 |
| Sep 3 08Z–16Z | 3600–7100 | 3700–7700 |
| Sep 3 23Z | 7468 | 7585 |

100% of sampled retries are 55P03; director phase is `cell-inventory`. Every cell pins
`sqlLatencyMsMax` at 1.0–1.2 s = the pre-#18521 1 s pool `lock_timeout`. Not load (controls flat
~26k, Cloud SQL CPU 46–53%). No `cloud-*` workflow explains the 08Z step. The lock is a global
`SELECT * FROM relay_cells FOR UPDATE` (23 rows) taken by assignment, control activation, activity
acquire, and sweeps, held to COMMIT.

## Finding 1: root cause of the phone's 24 s hang (the original symptom)

`acceptClient` runs four serialized Postgres calls; the fourth (`acquireActivity`) contends for the
global lock. Under contention the cell finishes after the phone's 12 s bound, then
`PendingHostDataReservation.bind` throws `host_data_reservation_already_bound` because the phone's
close already released the reservation. Every "first frame handler failed already_bound" line is that
post-mortem (31 events 23:06–01:01Z across 12 instances). Fix in #18565: abandon the accept after each
DB step once the socket is closed; new event `orca_relay_client_accept_abandoned {stage, elapsedMs}`
and metric fields `clientAcceptsAbandonedByStageDelta` / `clientAcceptAbandonedMsMax`. Phone side:
direct probe now fails fast on `reconnecting` so relay recovery is not queued behind three doomed
LAN redials (~3.5 s saved per foreground). #18518 (merged, not yet on the phone) covers the
stage-aware dial bound.

Host 666077865f2e: stable throughout. 4408 rotation 00:27:45Z; 1006 quit 00:52:24Z on old adhoc;
sticky reassignment to c27 00:52:35Z on new build; rotation closes 01:44:55Z and 02:23:15Z with
splices intact. No drain/4404/wrong-cell.

## Finding 7 (2026-09-04 ~05:10Z): retries bar recalibration basis (PR #18580)

Chose 2000 over removal. The metric is the gate's own source (`orca_relay_postgres_retries`
log metric, director + cells summed per five minutes, ALIGN_DELTA 300 s):

| window | p50 | p90 | p99 | max | > 300 |
|---|---|---|---|---|---|
| 2026-09-01 | 56 | 105 | 206 | 456 | 0% |
| 2026-09-02 | 109 | 186 | 294 | 377 | 1% |
| 2026-09-03 | 430 | 924 | 1320 | 1504 | 55% |
| 2026-09-04 to 05Z | 285 | 1012 | 1211 | 1211 | 44% |

15-minute pass rate, last 24 h: bar 300 -> 22%, 800 -> 66%, 1000 -> 86%, 1500 -> 99%, 2000 -> 100%.
Aug 23 incident on this metric: 1510 then 646 (single windows), so retries no longer separate an
incident from baseline; exhausted (467 vs bar 300; healthy 72 h max 184), director concurrency,
and pool bars carry that role. Note: my earlier "p99 1398 / 65% over 300" in Finding 5 came from
raw log line counts; the metric-based numbers above are what the gate actually evaluates.
Baseline tripled between Sep 2 and Sep 3 with no deploy; still unexplained (Finding 2).

## Decision needed from the owner (resolved: B)

The same-cap roll is blocked only by the monitor gate, and the gate is blocked by `relayPostgresRetries: 300`
(Finding 5: 65% of windows breach it; even the 04:55Z quiet window hit 339). Three options:

- A. Keep waiting for a naturally quiet 15 min. Odds per attempt ~1 in 3 in quiet hours, lower by day.
  Each attempt is free and read-only. Could take hours.
- B. Recalibrate `relayPostgresRetries` from measured data, same method as #18569: 24 h p99 is 1398, the
  Aug 23 incident ran 2200–3000, so ~1500 clears healthy windows with ~1.5–2x incident separation
  (less margin than the exhausted bar had). Overrides the "do not raise" note in the skill facts.
  Argument for: the roll being gated is the thing that reduces retries. Argument against: the bar is
  doing its job of saying contention is high.
- C. A human dispatches the roll with a different gate policy. Not something I can or should do.

My recommendation: B, with the number chosen from the table in Finding 5 and the roll following
immediately so the bar can be re-tightened after the fleet is on the 500 ms lock wait.

## Recommended next steps (in order)

1. Resolve the gate decision above, then: monitor dry-run -> c7 `canary-apply` only -> verify -> stop.
   Each rolled cell leaves the Finding 6 crash class.
2. Merge #18565; publish; a later same-cap roll carries it to cells.
3. Remove the global inventory lock from per-connection paths (`acquireActivity` existing-lease
   branch, `activateControl` superseded-control cleanup, `changeActivity`) by using the existing
   `adjustCellReservationAtomically` single-row update. Own PR, after the roll.
4. Recalibrate the Terraform alert `relay_postgres_retry_exhausted` to 300/300 s (observability root).
5. Whether to raise `relayPostgresRetries` is a human call; the data is in Finding 5.

## Roll inputs (verified by the read-only `verify` run)

- target-image-digest `sha256:85bf67993869a769642995d0863f4c2b6b569c3850c2d8390ec2ca5f2b179e28`
- rollback-image-digest `sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563`
- target/rollback rehome protocol 1 / 1; expected-rehome-generation 12; selector generation 110
- existing-only c1,c11,c12,c2,c3,c4,c5,c6; migration-only c17,c18; general c10,c13–c16,c19–c29,c7,c8,c9
- confirmation for canary: `ROLL_RELAY_SAME_CAP <target-digest> production-gce-c7`
- monitor evidence is single-use and must be < 5 min old at dispatch (plus 75 min per predecessor wave)
- monitor dry-run dispatch (read-only, runs at `main` head so a merged bar change applies immediately):
  `gh workflow run cloud-monitor-relay-production.yml --ref main -f mode=dry-run -f expected-selector-generation=110
  -f expected-existing-only-cells=<existing-only list> -f expected-migration-only-cells=production-gce-c17,production-gce-c18
  -f expected-general-cells=<general list> -f migration-policy=strict -f recovery-source-cell-id=none -f capacity-cell-id=none`

## Queries that worked (copy-paste)

- Cell metrics: `resource.type="gce_instance" AND jsonPayload.event="orca_relay_runtime_metrics"`
- Container crashes: `resource.type="gce_instance" AND jsonPayload.MESSAGE:"container die" AND jsonPayload.MESSAGE:"relay@sha256"`
- Crash banner: `resource.type="gce_instance" AND jsonPayload.message:"Node.js v24"`
- Retries: `jsonPayload.event="orca_relay_postgres_transaction_retry"` (no resource filter to get both)
- Director lines are `textPayload`; cell lines are `jsonPayload.message`
- Cloud Run concurrency: Monitoring API `run.googleapis.com/container/max_request_concurrencies`
- Dry-run final state: download artifact `relay-monitor-dry-run-<run>-<attempt>`, read `*.state.json` (the log's `schemaVersion` lines are only checkpoints, not the final verdict)
