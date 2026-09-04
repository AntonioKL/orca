# Relay improvement: implementation checklist, lanes, and disruption

Companion to [`relay-improvement-roadmap-2026-09.md`](./relay-improvement-roadmap-2026-09.md) (item numbers
match). This file answers three questions per item: what are the concrete steps, what can run in parallel,
and will a user notice.

## Uplift ranking (reliability gained per unit of effort)

| Rank | Item | Why it ranks here |
|---|---|---|
| 1 | 1.1 cell image roll | Removes the only crash mode we have seen in production. 22 of 23 cells still have it. One afternoon. |
| 2 | 3.1 refresh rotation grace window | Turns the entire "slow auth → mass sign-out" class into a slowdown. One day. |
| 3 | 4.1 inventory lock contention | The floor under every 503 and slow phone accept, every day, not just incidents. One week. |
| — | 2.2 relay/auth database split | **Deferred 2026-09-04** to ~2026-11-01. Biggest structural fix, but the concrete cause is fixed and alerts now page; see roadmap 2.2 for re-open triggers. |
| 4 | 1.2 + 1.3 pruning and reclaim | Defuses the 63 M-row time bomb. Low effort, mostly waiting. |
| 5 | 5.1 + 5.2 crash alert, page a human | Cheapest detection uplift; today's incident ran 4 h unpaged. |
| 6 | 2.1 private IP | Durable version of a fix that already landed (dynamic NAT ports). Do it on the existing instance. |
| 7 | 4.3 + 3.2 desktop hardening | Small, ride the normal desktop release. |
| 8 | 4.2, 4.4, 5.4, 1.4, 1.5 | Housekeeping and quality-of-life. |

## The shared bottleneck: cell rolls

Every change to what runs on a cell (image, proxy flag, env, relay code) needs a same-cap roll: drain →
recreate → verify, one wave at a time, gated by the 15-minute monitor, about an afternoon. Each wave forces
the desktops on that cell to re-dial (c7 canary: 807 controls re-dialed in ~10 s) and phones on those
desktops reconnect on their normal retry. Users see a few seconds of "reconnecting" per wave.

So batch. Two rolls, not five:

- **Roll 1 (now):** current image only (1.1). Do not wait for anything else.
- **Roll 2 (week 2–3):** proxy `--private-ip` (2.1) + relay pool `statement_timeout` (2.3) + lock-contention
  fix (4.1), all in one image/template. Prerequisite: 2.1's peering and private IP exist first.

## Lanes (independent; different people can own them)

```
Lane A  data plane   1.1 roll ──────────────────► Roll 2 (2.1 flag + 2.3 + 4.1) ──► 4.4 recalibrate
Lane B  auth/DB      1.2 enable pruning ──(10 d)──► 1.3 reclaim      3.1 grace window (any time)
Lane C  network      2.1 peering + private IP ─────┐ (feeds Roll 2)   (2.2 DB split deferred)
Lane D  desktop      3.2 no same-token retry, 4.3 lease jitter (any release; wire-compatible)
Lane E  observability 1.5, 5.1, 5.2, 5.4 (Terraform only, any time)
Lane F  director     4.2 region preference (Cloud Run deploy, any time)
Misc                 1.4 full apps-root apply (any time; see its check)
```

Hard dependencies: Roll 2 waits on 2.1's network work; 1.3 waits on 1.2 finishing. Everything else is
independent. (2.2 deferred; if revived, do it after 2.1 so the new instance is private from day one.)

## Disruption summary

| Item | User-visible? | What they see | Mitigation |
|---|---|---|---|
| 1.1 / Roll 2 | **Yes, transient** | Per wave, desktops on that cell reconnect within seconds; phones follow on retry. | Waves gated by the monitor; run in the US night. Already rehearsed on c7. |
| 1.2 pruning | No | Background deletes, 5k rows per batch. | Small first budget; watch `stopReason` and Cloud SQL write throughput. Stop the scheduler if checkpoint alerts fire. |
| 1.3 reclaim | **Depends on tool** | `VACUUM FULL` takes an exclusive lock on `refresh_tokens`: sign-in and refresh block for its duration (minutes to tens of minutes on 16 GB). `pg_repack` holds only brief locks. | Use `pg_repack`. If VACUUM FULL, announce a maintenance window. |
| 1.4 full apps apply | Should be none, **verify** | Terraform will create a new auth revision (env added). Traffic is pinned to `00031-tox` by name, so the new revision should receive 0 %. | Confirm in the plan that no `traffic` change appears. If it does, stop: the Terraform image variable is not the serving image. |
| 1.5, 5.x alerts | No | | |
| 2.1 private IP | **Possibly, verify** | Adding a private IP to an existing Cloud SQL instance may restart it (1–2 min DB unavailability: sign-in fails, relay renewals retry). Google's docs are inconsistent across versions; treat it as a restart. The proxy flag change rides Roll 2. | Off-peak; the relay's bounded retry survives a 2 min DB blip on the new image (not the old one: do Roll 1 first). |
| 2.2 DB split (deferred) | **Yes, scheduled** | Relay unavailable for the cutover (drain all cells → copy relay tables → flip `DATABASE_URL` → restart). Minutes if rehearsed. Desktops and phones reconnect automatically after. | Rehearse on staging; do it in the US night; announce. |
| 2.3 statement timeout | No beyond Roll 2 | | |
| 3.1 grace window | No | Auth deploys are no-traffic candidate → smoke → promote. | Security trade-off: a stolen token replayed inside the window is served once instead of revoking. 60 s is the usual choice. |
| 3.2, 4.3 desktop | No | Normal app update. | |
| 4.1 lock fix | No beyond Roll 2 | | Verify against real Postgres on 55440 with concurrent probes before shipping. |
| 4.2 region preference | **Minor, Asia users** | Phones that start being placed in Asia reconnect once to a nearer cell. | Roll out behind the existing region-preference flag. |
| 4.4 | No | | |

## Checklists

### 1.1 Cell image roll (Roll 1)
- [ ] Confirm fleet is quiet: 15-min monitor dry-run passes (no cell health 0, no crash in window).
- [ ] Confirm director is on 519f4914 and c7 on 85bf6799 (`verify` mode of the same-cap workflow).
- [ ] Dispatch `cloud-deploy-relay-production-same-cap` waves per the plan in the findings doc; one wave, verify, next.
- [ ] After each wave: controls recover on the recreated cells within 5 min; no `container die`; 4408/1006 burst subsides.
- [ ] Record image census (all 23 on the same digest) in the findings doc.

### 1.2 Enable pruning
- [ ] `auth_token_pruner_image` = digest of `orca-cloud-auth-00031-tox` (`343a0915…`; it contains the entrypoint).
- [ ] `auth_token_pruner_enabled = true`, `auth_token_pruner_max_deleted_rows` small (20k) for the first day.
- [ ] Targeted plan: only `google_cloud_run_v2_job.auth_token_pruner`, scheduler, IAM create. Apply.
- [ ] Trigger one run by hand; read the summary event: `stopReason`, `deletedRows`, category counts.
- [ ] Raise the budget to the default 200k after a clean day; watch Cloud SQL write MB/s and the checkpoint alert.
- [ ] 1.5: log metric + policy on `stopReason != complete`.

### 1.3 Reclaim
- [ ] Wait for steady-state runs deleting ~0 rows.
- [ ] `pg_repack -t refresh_tokens` off-peak (needs the extension; check `pg_available_extensions`). Not `VACUUM FULL` without a window.
- [ ] Confirm table + index size and `disk/utilization` dropped.

### 1.4 Full apps-root apply
- [ ] Run from CI or a host with the 1Password account (local plan fails on the Cloudflare data source).
- [ ] Plan shows exactly the four known drifts and **no traffic change** on `google_cloud_run_v2_service.auth`.
- [ ] Apply; confirm `status.traffic` still pins `00031-tox` at 100 %.

### 2.1 Private IP
- [ ] Allocate a `/24` private services range on the relay VPC; `google_service_networking_connection`.
- [ ] Add `ip_configuration.private_network` to `google_sql_database_instance.auth` (foundation root). Plan must show update, not replace.
- [ ] Apply off-peak; expect a possible restart. Watch auth 5xx alert and relay `sqlFailures`.
- [ ] Cell template: proxy args add `--private-ip`. Director: Direct VPC egress or connector, then the same flag. Both ride Roll 2.
- [ ] After Roll 2: NAT `port_usage` for relay gateways drops to ~0; then consider `ipv4_enabled = false` (removes the public IP; breaks the local `cloud-sql-proxy --token` workflow unless it also goes private).

### 2.2 Database split (deferred to ~2026-11-01; checklist kept for when it is revived)
- [ ] New `google_sql_database_instance.relay` (private IP from day one, its own size and flags). Staging first.
- [ ] Relay schema applies cleanly to an empty instance (it does at startup).
- [ ] Rehearsal on staging: drain → `pg_dump` relay tables → restore → flip `relay_database_url` secret → restart director + cells → phones/desktops reconnect. Time it.
- [ ] Production: announce a window; same steps; verify `orca_relay_runtime_metrics` controls recover to pre-cutover count.
- [ ] Update `production-cloud-sql-app-consumers` budget test and both alert policies' `database_id`.

### 2.3 Relay pool statement timeout
- [ ] `statement_timeout` on the relay `pg.Pool`, below the control-renewal deadline; DDL on an untimed connection (same pattern as auth #476).
- [ ] Postgres test on 55440: a held lock fails the query fast and the bounded retry takes over.

### 3.1 Refresh rotation grace window
- [ ] `rotateRefreshToken`: if `rotated_at` within 60 s and not revoked, return the existing successor (idempotent), no revoke, no audit.
- [ ] Outside the window or a third presentation: unchanged (revoke + audit).
- [ ] Tests: replay inside window returns same successor; outside revokes; concurrent double-present yields one successor.
- [ ] Deploy via `deploy-auth-production` (candidate → smoke → promote).

### 3.2 / 4.3 Desktop
- [ ] 3.2: on refresh timeout, re-read stored session before retrying; do not re-send a token already rotated locally.
- [ ] 4.3: ±10 % jitter on control lease renewal; unit test on the distribution; wire-compatible (server accepts early renewals already).

### 4.1 Lock contention
- [ ] Replace the global `FOR UPDATE` over `relay_cells` with per-cell row locks or `pg_advisory_xact_lock(cell)`; counters delta-only.
- [ ] Postgres tests on 55440 with concurrent probes; `postgres_retries` per hour drops in staging load run.
- [ ] Ships in Roll 2; then 4.4 recalibrates the retries bar from a week of data.

### 4.2 Region preference
- [ ] Director: honor requested region when the preferred region has headroom, else sticky. Behind the existing flag.
- [ ] Measure with `orca_relay_runtime_metrics` region counters before/after.

### 5.x Observability
- [ ] 5.1 `container die` log metric per cell, > 3 / 15 min, relay channel.
- [ ] 5.2 Add a paging channel to `auth_alert_notification_channels` for refresh rejections + latency.
- [ ] 5.4 One dashboard: `orca_relay_cloud_sql_wal_checkpoint`, NAT drops, `orca_auth_refresh_401`, summed `controls`.
