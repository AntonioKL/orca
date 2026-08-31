# Orca Relay

The relay that connects the Orca mobile app to a desktop host. Phones and
desktops never talk to each other directly: each opens an outbound WebSocket
to a relay cell, the relay pairs the two sessions, and it splices frames
between them. A director assigns hosts to cells and coordinates migrations;
cells carry the user connections.

This directory is an independent pnpm workspace inside the Orca monorepo. Run
its commands from `cloud/`, not the repository root. The source is covered by
the repository's root [MIT license](../LICENSE).

## Packages

- `packages/relay-contract`: the wire contract shared by the relay, the
  desktop app, and the mobile app (frame shapes, close codes, admission budgets,
  splice state machine).
- `apps/relay`: the relay server. The same image runs as a director or a cell
  depending on `ORCA_RELAY_ROLE`.

## Local development

```sh
cd cloud
pnpm install
pnpm build
pnpm test
```

`pnpm test` runs the SQLite-backed suites. Tests that need PostgreSQL run only
when `ORCA_RELAY_TEST_POSTGRES_URL` points at a disposable PostgreSQL 16 or 17
database, for example:

```sh
docker run --rm -d --name orca-relay-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=orca_relay_test -p 55440:5432 postgres:16-alpine
ORCA_RELAY_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55440/orca_relay_test \
  pnpm --filter @orca-cloud/relay test
docker rm -f orca-relay-pg
```

Configuration is read from environment variables validated in
`apps/relay/src/config.ts`. `ORCA_RELAY_ASSIGNMENT_SIGNING_KEY` (at least 32
bytes) is the only required value; everything else has a local default.

## Deployment

The hosted relay's infrastructure, deployment workflows, and operational tooling
are maintained privately. `Cloud Verify` in this repository builds, typechecks,
lints, tests, and secret-scans the relay on every change under `cloud/`.
