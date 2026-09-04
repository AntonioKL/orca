# Relay reconnect investigation: findings and evidence

Working notes for the 2026-09-04 mobile relay reconnect incident and the cell roll that follows.
Kept current across context compactions. Newest section first. All times UTC. Host ids are log digests,
never raw ids. Nothing here is a production mutation record unless the "Mutations" section says so.

## Status board

| Item | State | Where |
|---|---|---|
| PR #18565 relay accept abandonment + lease jitter + desktop rotation spread + phone probe fail-fast | Open, CI fully green again after the doc move (05:45Z), CodeRabbit + Pullfrog cleared, 3 review rounds; not merged (owner has not asked) | https://github.com/stablyai/orca/pull/18565 |
| PR #18569 monitor `relayPostgresRetryExhausted` 0 -> 300 | **Merged** 2026-09-04 ~04:20Z as 4101505b6b | https://github.com/stablyai/orca/pull/18569 |
| Same-cap `verify` of c7 (read-only) | **Passed** run 33836527159 | confirms identities, selector gen 110, rehome gen 12, protocol 1, digests |
| Monitor dry-run #1 | Froze min 5: `relay.postgres_retries` 380 > 300 | run 33836470590 |
| Monitor dry-run #2 | Green to min 13, froze 04:49Z: `director.concurrency` 76.7 > 64 (six-cell crash storm, Finding 6) | run 33837160275 |
| Monitor dry-run #3 | Froze min 3 at 05:01Z: `relay.postgres_retries` 339 > 300; no crash, concurrency 5–8 | run 33838698725 |
| Owner decision 2026-09-04 ~05:10Z | **Option B approved**: "you can raise the bar. or remove it altogether ... whats the most logical move". Kept the bar (removal would leave contention unwatched during the roll) and recalibrated from measured data. | this thread |
| PR #18580 monitor `relayPostgresRetries` 300 -> 2000 | Open, awaiting CI; mutation-checked (300 fails the new test) | https://github.com/stablyai/orca/pull/18580 |
| PR #18565 CI | Was red on `root directory guard` because this findings file sat at repo root; moved to `cloud/docs/` in 8ebff89106 | |
| PR #18580 | **Merged** 2026-09-04 05:23Z as 79d5fb469a (Pullfrog cancelled by the merge; independent Opus review requested instead, per owner) | |
| Monitor dry-run #4 | Froze min 12 at 05:37:35Z: `cell.production-gce-c27.health`/`.ready` = 0. Retries green all 12 samples under the new 2000 bar. Cause: c27 (asia-east2) container died 3x 05:37:00–05:38:01Z, Finding 6 crash class. | run 33840364323 |
| Monitor dry-run #5 | Froze at sample 1 (05:41Z): c27 health/ready still 0. MIG autoheal `recreateInstance` on c27 fired 05:38:12Z after the 3 crashes; instance RECREATING, process up with 0 controls (was ~395). Second c27 recreate in 7 h (Finding 3 seed pattern). Waiting for c27 to settle before dry-run #6. | run 33841327879 |
| Monitor dry-run #6 | **Passed** 06:06:31Z: 16 samples, no freeze (started 05:47:42Z) | run 33841783747 attempt 1 |
| c7 `canary-apply` | **Succeeded.** Dispatched 06:07:15Z; drain 06:10Z; MIG recreate 06:16–06:23Z; new image listening 06:23:42Z; verify + trust proof passed; restored to `admission=general` 06:25:21Z; canary authority sealed. c7 is on `85bf6799…`. | run 33843071283 |
| PR #18581 doc reconcile (Aug 23 figure: 2,200–3,000 raw log lines vs 1,510 on the gate metric) | **Merged** | https://github.com/stablyai/orca/pull/18581 |
| Same-cap `verify` c7 target=519f4914 rollback=85bf6799, gen 112 | **Passed** (read-only) | run 33856355648 |
| Monitor dry-run #7 (gen 112) | Froze at sample 1 (09:05:31Z): `director.errors` 4 > 0, the four 2.0 s pg-connect 500s from the 09:00 cascade still inside the 5-min delta window. Dispatched 4 min too early. | run 33856521278 |
| Monitor dry-run #8 (gen 112) | Green for 15 of 16 samples (09:09:38–09:24), froze on the final sample 09:25:22Z: `director.errors` 1 > 0. The one 500 was `/v1/admin/evacuation-status` at 09:23:50Z, 2.01 s latency = director pg-connect timeout, called by **the monitor's own collector** (`incident-monitor-sources.ts:492`). First evacuation-status 500 since Sep 1. The gate froze on a request it made itself. | run 33856905229 |
| Monitor dry-run #9 (gen 112) | Froze: c13/c23 crashed 50 s after dispatch, then c14/c20/c9 at 09:34. | run 33858650691 |
| Monitor dry-run #10 | Dispatched 09:46:13Z; froze at sample 5 (09:56:59Z): `director.errors` 12. All twelve at 09:55:17–21Z, 0.8–2.1 s latency, 10 on `/v1/regions` + 2 on `/v1/assign`; c16 and c8 crashed at 09:55:19 in the same second. A single 4-second Postgres connect stall hit director and cells together. | run 33859947207 |
| Monitor dry-run #11 | Froze at sample 2 (10:08:07Z): `director.concurrency` 79.8 > 64, the c8/c20 re-dial. They crashed 10:05:54, 3 s before the waiter's quiet check passed (log ingestion lag). | run 33861578009 |
| Monitor dry-run #12 | Dispatched 10:17:38Z after 10 quiet min; froze at sample 2 (10:19:24Z): `cell.production-gce-c16.health` 0. c16 did **not** crash (no container die, MIG NONE/HEALTHY, readiness=true throughout, `/health` 200 in 230 ms at 10:21). At 10:19:07–16 it logged "control activity renewal failed" x4 and a burst of 1006 closes, sqlFailures 1 -> 14, sqlLatencyMsMax 2588: a pg stall on the old image that did not reach the unhandled path. The probe's single fetch (30 s timeout) came back unavailable during that stall and `unavailableIsZero` turned it into health=0. | run 33862504601 |
| Monitor dry-run #13 | Green 14 of 16 samples (10:48:38–11:03), froze 11:04:43Z: c9 crashed 11:04:23, c28 11:04:25 (then looped 11:05:04, 11:05:41); c15 probe also read 0 (stall, no crash). Missed by ~90 s. **Dispatched by hand 10:48:15Z** into a 43-min crash lull (last die 10:05:54; last director 500 10:31:49). The re-armed waiter never fired: its MIG-stable check used `grep -vc True`, which exits 1 when nothing matches, so `&&` short-circuited on the *healthy* case. Waiter armed 10:20Z: 10-min quiet + every MIG stable + 60 s recheck, then dispatch, then canary c7 on green. Held at 10:24 and 10:31 by lone director `/v1/assign` 500s (2 s pg-connect stalls, no cell crash). Director 500 events since 08:46: 6 (gaps 2.7/21/31/29/7.6 min). At 10:39 the waiter was re-armed with a 6-min director-500 window (the monitor's own delta is 5 min) instead of 10, since the gate only needs the 15 min *after* dispatch to be clean. Cell crashes have stopped since 10:05 (33+ min, longest gap since 08:40). 12 dry-runs: 1 pass (#6), 11 freezes, none on a real fleet-health regression. | Cascade gaps since 09:00: 31, 2.9, 5.1, 16.1, 4.0 min (median 5); a 15-min clean window is ~28% per attempt at this rate. | |
| Monitor dry-run #14 | Dispatched 11:26:53Z by the fixed waiter (first autonomous dispatch); c14, c23, c25, c15, c24, c19 died 11:30:59–11:31:08 (six cells, 13 min after the last cascade). Froze on c8 (and others) health/ready probes. Waiter re-armed 11:06Z (grep bug fixed: `grep -c` under `|| true`), same chain; held through the 11:17 cascade and c14/c28 recreates. 13 dry-runs: 1 pass, 12 freezes. Since 08:40: 10 cascades, 75 container dies, gaps 20/31/3/5/16/4/6.5/58/13 min; only 3 windows of >=17 clean minutes existed in 2.6 h, and dry-runs hit two of them (#6 passed, #13 lost the third by 90 s). |
| Monitor dry-run #15 | Waiter armed 11:33Z (6-min director-500 window, 8-min crash window, all MIGs stable), chained canary. 14 dry-runs: 1 pass, 13 freezes. |
| Gate decision | Owner asked at 09:36Z to choose: A keep looping / B recalibrate `directorErrors` 0 -> small n / C human bypass. Ten dry-runs, four froze on this bar. Recommendation B+A. Note: B alone would not have passed #9 or #10 (cell health probes and a 12-error burst); it fixes the single-500 false freezes (#7, #8) only. | |
| Batch roll | **Deferred by plan**: roll once with the lock-fix image instead of twice. | |
| PR #18606 lock removal (root cause) | **Merged** 09:2xZ as 7b108abf71 after review, fix, re-verify; CI green | https://github.com/stablyai/orca/pull/18606 |
| Image publish for 7b108abf71 | **Done** 08:36:49Z run 33854111305: `sha256:519f4914217f08cabcdcd34825965db8473ec37c6591553a3af0d65dcdeeb183` | |
| Director deploy on 519f4914 | **Succeeded** 08:45Z run 33854355791; serving `orca-cloud-relay-00570-siv`, rollback tag on 00569-ret (also 519f4914), 00565-fes (85bf6799) still deployable. Dispatched 08:37:45Z (blue/green; prior revision 00565-fes on 85bf6799 kept as rollback). Note: `predecessor-image-digest` is a required input even with bootstrap=false; pass the serving digest. | `cloud-deploy-relay-production-director.yml` |
| c7 on new image, 2 h in | 817 controls, **0 container die** since restore (was ~1 per 15 min on old image); `sqlLatencyMsMax` still 1.0 s = lock wait unchanged, which #18606 targets | |
| Terraform alert `relay_postgres_retry_exhausted` at `> 0` | Firing continuously since #18521; recalibration not done (own change) | `cloud/infra/terraform/relay-observability.tf:447,469` |

## Mutations performed (complete list)

1. Merged PR #18569 to main (code/docs only).
2. Merged PR #18580 and #18581 to main (monitor bar + docs).
2b. Merged PR #18606 to main (relay lock change; no serving effect until the image is deployed).
2c. Dispatched `cloud-publish-relay-production` for 7b108abf71 (builds and pushes an image; changes nothing serving). Done: 519f4914.
2d. Dispatched `cloud-deploy-relay-production-director` on 519f4914 (preserve placement, no prune, rehome gen 12). Succeeded 08:45Z; serving revision 00570-siv. Rollback: `gcloud run services update-traffic orca-cloud-relay --region us-central1 --to-revisions orca-cloud-relay-00565-fes=100` (85bf6799, still Ready). Not needed so far.
3. 2026-09-04 06:07:15Z: dispatched `cloud-deploy-relay-production-same-cap` `canary-apply` for production-gce-c7 only (run 33843071283). Completed successfully 06:26Z: c7 isolated, drained (807 controls re-dialed), template + MIG rolled to 85bf6799, verified, restored to general admission. Selector generation advanced 110 -> 112 (isolate + restore).
4. Nothing else. Both monitor dispatches were `mode=dry-run` (read-only). The same-cap dispatch was `mode=verify` (read-only, confirmed by step gates `if: inputs.mode != 'verify'` on every mutating step).

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

2026-09-04 05:36:59–05:38:01Z: c27 died 3x in 62 s plus one other instance (5464389947731541178); this froze dry-run #4 on c27's health probe.

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

Autoheal amplifier: MIG health check is `/health` every 10 s, timeout 5 s, unhealthy after 3, so a
crash loop of ~30 s+ triggers `compute.instances.repair.recreateInstance`. All ~20 recreates in the
48 h to 2026-09-04 05:40Z were the three Asia cells (c27 x6, c28 x7, c29 x8; gcloud prints local
-07:00 times). c27 recreated 05:38:12Z after 3 crashes in 62 s; its ~395 controls went to 0 and the
monitor's `cell.production-gce-c27.health/ready` probe read 0 for the whole recreate (~several min),
freezing dry-runs #4 and #5. Each recreate also seeds a Finding 3 rotation cohort. Rolling the Asia
cells early in the batch phase should be weighed against the canary-first rule; c7 stays the canary.

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

## Plan agreed with the owner (2026-09-04 ~06:45Z), in execution order

Owner: "feel free to improve operations to make things more effective ... continue driving everything e2e
until this process is complete." Owner has had multi-day experiences with cell rolls and does not want a
9-hour sequential roll.

1. **Lock-removal PR** (root cause). *Status 08:55Z: pushed as branch `relay-single-row-reservation`
   (2 commits). Opus adversarial review found one real defect: `acquireActivity` moving a client-chosen
   activity id across cells locked the old cell's row before the new one, cycling with placement's
   ascending inventory lock (reviewer reproduced it as paired 55P03s on real Postgres; no 40P01 because
   lock_timeout == deadlock_timeout == 1 s). Fixed with `lockCellRows` (ordered, 500 ms bound); census now
   fails on any inline `relay_cells FOR UPDATE` outside the named helpers. Three-cell Postgres test moves
   an activity high->low while the target row is held; 5/5 revert-mutants fail it. 480 SQLite tests +
   tsc green. Also fixed a pre-existing test leak (`relay_cell_connection_snapshots`) that made
   `assignment-control-supersession-postgres` fail on reruns. Reviewer re-verified 65569be3de: cycle
   repro completes in 7 ms (was 1022 ms + paired 55P03); no remaining out-of-order pair in the store;
   flagged two evasions in the new census guard, closed in the third commit (whole-statement scan,
   covers query() too, mutation-checked with both evasions). Headroom Postgres test's one failure is
   pre-existing on main (verified by swapping in main's store).* Make `activateControl` superseded-control cleanup, `acquireActivity`
   existing-lease branch, and `changeActivity` use the existing single-row
   `adjustCellReservationAtomically` instead of the 23-row `lockCellInventory`. Keep the global lock only
   for placement (`resolve`/assignment) and sweeps. Real-Postgres contention test on port 55440.
2. **Faster same-cap rollout workflow.** (a) paced drain instead of `graceMs: 0` so a cell's ~800 hosts
   re-dial over minutes, not one second (director cap is 5 x 80 = 400 in-flight); (b) cells in a batch run
   in parallel once drains are paced; (c) post-canary batches use a short freshness check instead of a new
   15-min dry-run, since the in-job safety recheck already runs before each drain; (d) job timeout > 75 min.
   Target: 22 cells in ~6 batches x ~25 min.
3. **Build image** with (1) merged, then one roll of the fleet with (2). Asia cells c27/c28/c29 first.
4. Re-tighten the monitor retries bar; recalibrate the Terraform exhausted alert.
5. Consider deleting the 55-min control lease rebind entirely (no recorded reason; liveness is the 75 s
   watchdog + 90 s activity lease). Separate PR after (1) so its effect is measurable.

## Faster same-cap rollout: design (step 2 of the plan), from reading the real limits

What actually bounds parallelism today (measured on the c7 canary, run 33843071283):

| step | c7 duration | bound by |
|---|---|---|
| prechecks (recheck, backend init, resolve, verify) | 43 s | none |
| isolate + drain + transition wait | 7 min | drain is `graceMs: 0`; `verify-relay-capacity-transition --activity restart-safe` polls until leases drain |
| Terraform template + MIG recreate + wait-until stable | 8 min | GCE recreate; per cell, independent |
| verify new incarnation + trust proof + restore | 1.5 min | none |

Real constraints: (1) the director is 5 x 80 = 400 in-flight `/v1/assign`; a `graceMs: 0` drain of ~800
hosts pins it at cap for ~2 min (observed 79.75/84.75 p99). (2) `production-cloud-sql-rollout` lease and
workflow concurrency group serialise the whole run, by design, and the per-cell job shares it via
`holder-key`. Nothing else forbids parallel cells.

Changes, smallest first:
1. **Paced drain.** `HostSessionRegistry.drain(graceMs)` already sends `drain {graceMs}` and closes each
   session after `graceMs`, but the desktop's `handleDrain` re-dials immediately regardless of graceMs
   (`relay-origin-pool.ts:150-162`), so graceMs only delays the *close*, not the stampede. Fix on the
   cell: stagger the drain *send* across sessions over a window (e.g. 800 sessions over 120 s = ~7/s),
   which needs no desktop change and works for every desktop version in the field. New admin body field
   `spreadMs` (optional, default 0 keeps today's behaviour); canary script passes `spreadMs: 120000`.
   Requires the cell to be on an image with the change, so it applies to batches after the first
   post-lock-fix roll, not to this one.
2. **Parallel cells in a batch.** In `cloud-deploy-relay-production-same-cap.yml` make `cell_2..cell_4`
   `needs: [gate]` instead of chaining, gated on the same evidence (drop the `+75 min x wave-index`
   allowance, it exists only because of chaining). Each job already takes the rollout lease with the
   run's `holder-key`, so they re-enter it rather than fail. With paced drains, 4 cells x ~800 hosts
   over 120 s is ~27 dials/s, well under the director cap. Raise `timeout-minutes` to 90.
3. **Post-canary batches skip the 15-min dry-run.** The in-job "Recheck aggregate SQL, pool,
   reconnect, migration, and selector safety" step (`pnpm incident:relay-preflight`) already runs a
   live one-shot check before each drain. For `batch-apply` with a sealed `canary-run-id` from the
   same commit, accept a dry-run of any age (the canary's) plus that live recheck; keep the 15-min
   requirement for `canary-apply`. Change lands in `relay-monitor-evidence.mjs verify-authority` +
   `relay-production-same-cap-wave.mjs` + their node:test suites.

**Correction after reading the cell job (07:35Z):** (2) parallel cells is not a flag flip. Each cell job
asserts the exact selector generation `expected + 2 x wave-index` and exact memberships derived from
predecessors having completed (`ISOLATED_*`/`RESTORED_*` in the job, `applyExactAdmissionSelector`
compare-and-swap), and all cells share one Terraform state lock. Making that concurrent means a batch-level
isolate/restore in the gate and a rewrite of the 650-line job's expectations. That is the multi-day trap
the owner described. Deferred.

What is cheap and removes most of the wall-clock: (3). The per-batch 15-min dry-run costs 15 min each
*and* fails ~50% of the time on old-image crashes, which is where hours go. Implement: `batch-apply` with a
verified canary authority accepts a passed dry-run up to 6 h old and may re-use one already consumed
(the consumed-marker check exists to stop replaying stale evidence; the canary binding plus the in-job
live preflight at drain time replace it). Files: `relay-monitor-evidence.mjs` (`--after-canary`),
`incident-live-preflight-cli.ts` (same flag), the same-cap workflow + job, and both test suites.
Revised expectation: 22 cells = 6 sequential batches x ~70 min = ~7 h wall-clock but *unattended-safe*
and with one dry-run total, versus today's 6 dry-runs at ~50% each. (1) paced drain rides the lock-fix
image.

## Recommended next steps (superseded by the plan above; kept for history)

1. Resolve the gate decision above, then: monitor dry-run -> c7 `canary-apply` only -> verify -> stop.
   Each rolled cell leaves the Finding 6 crash class.
2. Merge #18565; publish; a later same-cap roll carries it to cells.
3. Remove the global inventory lock from per-connection paths (`acquireActivity` existing-lease
   branch, `activateControl` superseded-control cleanup, `changeActivity`) by using the existing
   `adjustCellReservationAtomically` single-row update. Own PR, after the roll.
4. Recalibrate the Terraform alert `relay_postgres_retry_exhausted` to 300/300 s (observability root).
5. Whether to raise `relayPostgresRetries` is a human call; the data is in Finding 5.

## Canary blast radius (read before dispatching c7)

- What `canary-apply` does to c7, in order: isolate (selector -> migration-only, no new
  assignments), `/v1/admin/drain graceMs:0` (every control on c7 re-dials the director and is
  reassigned), Terraform template + MIG update to the target image, wait stable, verify new
  incarnation + exact digest + protocol, prove per-host trust, restore c7 to general admission.
  On any failure c7 is left isolated (migration-only) with rehome disabled; nothing else is touched.
- c7 at 05:20Z: 788 controls, 5 splices, 800 connections. So ~790 desktops re-dial once. The fleet
  already absorbs this exact event 201 times / 48 h uncontrolled (Finding 6); the controlled version
  isolates first, so no new assignment lands on c7 mid-roll. Expect a director concurrency blip, not
  a freeze-class one (six cells at once gave 85; one cell should stay well under 64).
- Precedent: the identical workflow (pre-move, in orca-cloud) ran 9 successful `apply` canaries and
  batches on 2026-08-27 (last: c20 -> 5aedbca5). Its failures that day all stopped at the read-only
  "Recheck aggregate SQL..." or "Require durable rehome disabled" step, before `MUTATION_STARTED`.
  The moved copy in this repo has one run: the read-only `verify` of c7 (passed, including WIF auth).
- c7 side note: MIG autoheal recreated the c7 instance four times on 2026-09-01 08:02-08:42 PDT
  at ~13 min spacing. Same crash class as Finding 6 (health check failing during restart loops).

### Canary observed effect (c7 drain, 2026-09-04 06:10Z)

- c7 807 controls -> 0 between 06:08:52Z and 06:10:52Z. Director `/v1/assign`: 200s 32 (06:09) -> 2628 (06:10)
  -> 340 (06:11); 5xx 1969 (06:10) -> 31 (06:11). Director max-concurrency p99 7.9 -> 79.75 (06:10) -> 84.75
  (06:11), i.e. at the Cloud Run cap of 80 for ~2 min. My pre-dispatch estimate ("well under 64") was wrong.
- Confounder: c10 (us-central1, instance 2803000337345335589) crashed 06:09:56Z on the old-image class
  (Node.js banner + container die), so ~1,600 hosts re-dialed in the same minute, not ~800. Coincidental;
  the fleet has one of these every ~15 min.
- Recovery: 06:13 903 / 06:14 1471 assign 200s from 640 distinct desktop IPs; 503s 78 -> 183 -> 29/min.
  No cell crash 06:12–06:16Z. Drain step passed ~06:16Z; template/MIG apply started.
- 06:16:03–06:17:08Z, during c7's template apply (not its drain): c27 (x4) and c29 (x3) crash-looped on the
  old-image pg-pool connect timeout in `beginProof`, both MIGs autoheal-recreated (c27's second recreate in
  40 min). Fleet 23 -> 21 reporting cells, controls 13286 -> 12462, assign 503s 1000/min at 06:17, director
  concurrency p99 74.8. Cloud SQL CPU 0.70 max, backends 174 max (bar 250). Same multi-cell pattern occurred
  at 01:31Z (4 cells) and 04:47Z (5 cells) with nothing rolling; the c7 drain's SQL load 6 min earlier may
  have nudged the pool timeouts but the class is pre-existing. c7 MIG RECREATING onto new template
  `…20260904061618…` = the expected image swap.
- 06:20Z: 849 assign 503s. Closes 06:19:30–06:21: 162x1006 age<5min (hosts bouncing off the recreating
  c27/c29), 73x4408 + 53x1006 in the 50-min age bin (Finding 3 rotation cohort). Not roll-caused.
  c7 MIG `recreating=1` on the new template since 06:16:18Z; c27 and c29 MIGs also RECREATING (autoheal).
- 06:23:16Z c7 instance restarted in place (MIG RECREATE keeps name/id relay-c7-bwjc / 4545742188814054238),
  pulled `relay@sha256:85bf6799…` 06:23:37Z, listening + readiness true 06:23:42Z. Apply step passed 06:24Z;
  verify step running. Isolate -> ready on new image took ~14 min end to end.
- Post-restore c7 on new image (06:25:42–06:26:42Z): controls 143 -> 273 -> 377 refilling, sqlQueries
  ~1,500/30 s, `sqlLatencyMsMax` 518 -> 1003 -> 1155 ms, still 55P03 `cell-inventory` retries. So the new
  image alone does not remove lock waits; the request-path 500 ms cap from #18521 applies to the director's
  paths, and cell-side `acquireActivity`/`activateControl` still ride the global lock (step 3 in next steps).
  Watch: does c7's sqlLatencyMsMax settle below the old 1.0–1.2 s pin once refill finishes, and does c7 stop
  appearing in `container die` (the real win: guardSessionTask).
- 08:25Z (2 h after restore): c7 817 controls, 0 crashes since 06:25Z. Fleet crashes last 2 h: c27 x6,
  c28 x5, all old-image Asia cells. The new image stops the crash class as predicted; it does not move
  lock latency (c7 sqlLatencyMsMax 1005 ms), which is #18606's job.
- Implication for the batch phase: every drain will push director concurrency past the monitor's 64 bar
  for ~1-2 min. The batch job rechecks safety *before* it drains (read-only step), so that is fine per wave,
  but never run a monitor dry-run concurrently with a wave, and prefer batches of 2 over 4 until the fleet
  is on the new image and the crash class is gone.

## Post-merge dispatch plan for #18606 (image -> director -> cells)

1. `gh workflow run cloud-publish-relay-production.yml --ref main -f mode=publish` (after the squash lands
   on main). Resolve the digest by tag, never by parsing the log (it mixes relay and fence-broker digests):
   `gcloud artifacts docker images describe us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay:sha-<merge-sha> --format='value(image_summary.digest)'`.
2. Director: `gh workflow run cloud-deploy-relay-production-director.yml --ref main -f image-digest=<new>
   -f regional-placement-mode=preserve -f prune-incompatible-revisions=false -f expected-rehome-generation=12
   -f bootstrap-runtime-identity=false -f predecessor-image-digest=<currently serving digest>`
   (no monitor evidence needed; requires rehome disabled at gen 12, which it is). Last run 33826514754 used
   the same shape. Watch director `orca_relay_postgres_transaction_retry` per minute before/after.
3. Cells: same-cap `verify` c7 with target=<new>, rollback=85bf6799; fresh dry-run; `canary-apply` c7;
   then batches (3 per batch, Asia c27/c29/c28 first). Each batch: new dry-run unless the batch-reuse
   change (design section above) has shipped.

## Finding 8 (2026-09-04 08:40Z): ten-cell crash cascade during the director deploy, not caused by it

Timeline: candidate revision 00570-siv created 08:38:39Z, first log 08:39:20Z; traffic still 100% on
00565-fes through 08:43 (assign logs by revision). Cell crashes: c28 (5031087219978409220) looped 08:37:55–
08:40:07 (9x), then at 08:40:20–08:40:45Z **ten** instances died within 25 s (c10 2803…, 5110…, 532…, 5464…,
7536…, 7726…, 8671…, 8928…, 8966…). All old-image `beginProof` pg-pool timeouts. Fleet controls 13,423 ->
6,157 by 08:43; assign 503s 3,912 (08:42) and 4,624 (08:43) per minute, director concurrency 85 (cap 80),
Cloud Run autoscaled 5 -> 10 instances, Cloud SQL CPU 0.55 -> 0.99. Deploy finished cleanly at 08:45Z with
the new director taking the tail of the storm; by 08:46 503s were ~30/15 s, controls 7,913 and rising,
director lock retries 29/min (vs 105–157/min pre-deploy) and exhausted 2/min (vs 65/min at 08:36).
Same class as 01:31Z (4 cells) and 04:47Z (5 cells) today; this was the biggest. c7, on the new image
since 06:25Z, did not crash. What triggered the pool timeouts fleet-wide at 08:40 is not established; Cloud
SQL CPU was 0.78–0.88 in the minutes before, the highest of the day, so the cells' 2 s connect timeout is
the plausible tipping point under a busy database. Every cell still on 5aedbca5 remains exposed to this.

## Finding 9 (2026-09-04 08:56Z): #18606 on the director cut lock retries ~10x

`orca_relay_postgres_retries` per 5 min, director only: 08:21–08:41 windows 419–689 (old image, incl. the
crash storm); 08:46/08:51/08:56 (new image 519f4914, refilling ~7k hosts): **61 / 69 / 54**. Exhausted:
104–178 -> **11 / 14 / 12**. Inventory hold p95 ~200 ms, max 255 ms, ~366 holds/min. Cells (still old
image) 17–44 -> 0–3, because the director no longer holds the 23-row lock on their behalf. This is the
first direct measurement of the root-cause fix under real load. Cloud SQL CPU peaked 0.99 during the
cascade and is decaying (0.86 at 08:55); the monitor freezes above 0.80, so no dry-run until it clears.

Fourth cascade 09:00:12–09:00:18Z: c23, c8, c16, c26, c22 (five cells, 11 container-die events in 6 s,
all `5aedbca5`, exitCode 1, Node banner, pg-pool `client closed the connection` burst right before). Cloud
SQL CPU 0.84 -> 0.78 in the preceding minutes, director concurrency 18–22 (idle), so this one fired
*without* a database or director spike. Fleet had just recovered to 13,015. Cadence today: 01:31 (4),
04:47 (5), 08:40 (10), 09:00 (5), 09:31 (c13, c23), 09:34 (c23 again, c14, c20, c9; c14/c20 crash-looping),
09:39 (c21, c24), 09:55 (c16, c8), 09:59 (c20), 10:05 (c8, c20), 10:19 (c16 stalled, no crash), then a 58-min
lull, 11:04 (c9; c28 died 13x in 4 min, autoheal recreate 11:09Z, its 3rd recreate today), 11:17 (c10, c28
again, c22, c23, c14 x9 looping; 23 dies in ~90 s; fleet 13.3k -> 10.8k), 11:31 (c14, c23, c25, c15, c24, c19), 11:34 (c20, c26, c29 x4, c14, c27 x3, c25; fleet 13.1k -> 10.3k).
Three cascades in 17 min. 11:38–11:45 c27 crash-looped 17x and c28 4x (Asia cells), c29 recreating.
Every cell that has died today is on 5aedbca5; c7 (85bf6799, 5 h) has not. Cell dies per hour today:
01Z 5, 02Z 7, 03Z 4, 04Z 7, 05Z 4, 06Z 9, 07Z 11, 08Z 30, 09Z 26, 10Z 2, 11Z 68+ (to 11:42).
Director concurrency pinned at 85 for 09:32–09:33; 503s 4,141 and 4,396 per minute. 09:39: c21, c24
(2,870 503s). Crashes per instance 08:10–09:40Z: c28 x14, c27 x5, c23 x5, c22 x4, c14 x4, c13/c20 x3,
then c26/c9/c24/c16/c8 x2. Mean gap between cascades since 08:40: ~12 min. Every 15-min gate attempt
now has well under even odds; the c7-style canary that ends this needs a gate it can pass. The old image is now cascading roughly hourly regardless of load; the
only cell on a fixed image (c7) has 0 crashes in 2.5 h across all four.

Director 500s: 4 in the 09:00 window, all 2.0 s latency on `/v1/assign` or `/v1/resolve` = pg-pool connect
timeout surfacing as a 500. Pre-existing (Sep 3: 03h/08h/16h one each, same 2.0 s shape; 06:09Z today on
the old image during the c7 drain). The monitor's `directorErrors: 0` bar freezes on any of these, so a
dry-run needs a 15-min window with none; at ~1 per cascade that is a real but modest constraint.

**Gate observation (09:26Z):** `directorErrors: 0` counts every non-503 5xx on the director, including
the monitor's own admin calls. The director on 519f4914 still sees an occasional 2.0 s pg-pool connect
timeout (~1 per 20 min under today's Cloud SQL load), which surfaces as a 500 on whichever request drew
it. Two consecutive dry-runs (#7, #8) froze on exactly this: one, isolated, 2 s 500. That bar was set for
"unexpected director 5xx"; a single connect timeout that the client retries is not an incident. Candidate
recalibration (own PR, not done): `directorErrors` 0 -> 2 per 5 min, or exclude the monitor's own
user-agent. Not changing it unasked; noting that at ~3 per hour the 15-min gate passes ~1 in 2 attempts.

**Did the director deploy make cells crash more? (checked 09:45Z)** Cell `container die` per 30 min:
06:00 9, 07:00 2, 07:30 9, **08:30 30** (director candidate 08:38, traffic 08:43–08:45; the 10-cell burst
was 08:40:20, before the move), 09:00 11, 09:30 12. Per hour today 05:4 06:9 07:11 08:30 09:23 vs Sep 3
same hours 2/7/8. So today is 2–3x worse than yesterday and was rising before the deploy; after the deploy
it is ~11–12 per 30 min, in line with 06:00–07:30. Cloud SQL backends (~230 max) and new connections
(~5k/30 min) are flat across the deploy. Latest crash (c21 09:39:11) is `Connection terminated due to
connection timeout` with cause `Connection terminated unexpectedly` in `verifyCellAssignment` <-
`beginProof`, the same unhandled path. Conclusion: no evidence the deploy worsened it; the old image's
crash rate simply climbed all day. Director lock retries stayed ~10x lower after the deploy.

**Checkpoint-phase check (10:00Z, negative result):** Postgres checkpoints complete every 5 min at ~:07.
Cell crashes bucketed by phase within that 5-min cycle show a mild :00–:29 s cluster today (22 of 103)
that is absent on Sep 3 (7 of 114), so checkpoints are not the trigger. Disk write bytes in cascade
minutes are at or below the median except 09:00. Cloud SQL memory 0.47, transaction rate flat. The
09:55 stall (11 director + 4 cell pg-connect timeouts in the same 4 s) came with `could not obtain lock
on row in relation "relay_cells"` from a NOWAIT sweep at 09:55:36, i.e. someone was holding the full
inventory at that moment. On the new director that can only be placement or a sweep; on the old cells it
is still every rebind. What stalls *connections* (not locks) for 2 s fleet-wide remains unexplained;
Cloud SQL is `db-custom-4-15360` REGIONAL PD_SSD 49 GB at 0.5–0.75 CPU when it happens.

**Stall census (10:01Z):** 33 pg-connect-timeout stall events today (clusters of timeouts < 20 s apart).
Before 08:35 they were 1–9 timeouts each and 10–60 min apart; from 08:35 the big ones are 16, 22, 21,
17 timeouts and 5–30 min apart. No second-of-minute phase (start seconds spread across all buckets), so
not a fixed timer. Cloud SQL backends by state at 09:55: active peaked 42 at 09:52, idle-in-transaction
≤ 10, nothing near the 400 ceiling; memory 0.47; disk normal. Each stall is a few seconds where *new*
connections to Cloud SQL (via the auth proxy socket) time out at the 2 s `connectionTimeoutMillis`,
hitting every process that happens to need a fresh pool connection in that window. Old-image cells die
on it (unhandled), new-image director logs a 2 s 500 and continues. Root cause of the stall itself is
outside the relay code (Cloud SQL proxy or instance); not chased further here.

## Roll inputs (verified by the read-only `verify` run)

- target-image-digest `sha256:519f4914217f08cabcdcd34825965db8473ec37c6591553a3af0d65dcdeeb183` (lock fix; supersedes 85bf6799 as target)
- previous target `sha256:85bf67993869a769642995d0863f4c2b6b569c3850c2d8390ec2ca5f2b179e28` (c7 is on this; use as c7's rollback)
- rollback-image-digest `sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563`
- target/rollback rehome protocol 1 / 1; expected-rehome-generation 12; selector generation **112** (110 before the c7 canary)
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
