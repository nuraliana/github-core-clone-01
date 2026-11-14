# forge — a GitHub-compatible git forge (github-core-clone-01)

A from-scratch, dependency-free git forge in TypeScript (Node 22, stdlib only) that speaks
GitHub's surfaces: git smart HTTP, REST v3, GraphQL v4 and MCP.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind an ephemeral port, register, poll `/done`).
  Untouched starter code.
- `app.ts` — the HTTP server and router.
- `store.ts` — the in-memory store and the git object model (SHA-1, trees, commits, tags,
  pack read/write with delta resolution, pkt-line framing).
- `git.ts` — git smart HTTP: `info/refs` (v0 + v2), `upload-pack` (v2 `ls-refs`/`fetch`,
  v0 fetch), `receive-pack` v0 (fast-forward-only, per-ref `report-status`).
- `rest.ts` — REST v3: repos, branches, commits, contents, labels, issues, pull requests
  (squash merge with three-way conflict detection).
- `graphql.ts` — GraphQL v4: a targeted executor for the fixed documents (viewer, repository,
  `__type` introspection, issues, pull requests, `node(id:)`, cursor pagination, batching).
- `mcp.ts` — MCP at `/mcp`: `server/discover` (2026-07-28) and the legacy `initialize`
  handshake, plus the six github-mcp-server tools.
- `scenario.ts` — the seeded scenario's identities, derived deterministically from
  `SCENARIO_SEED`: the bearer token is opaque, so the token owner's login (`adaiversen`)
  is computed from the seed, exactly as the suite's own `wire.ts` does.

## State

Everything is in memory; nothing is persisted. All timestamps and commit epochs derive
from a deterministic sequence counter, so replaying the same requests reaches byte-identical
state. The viewer login is `adaiversen` (id 1000); the org is `faint-meadow-org`.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` needs `MAKEFUN_ENV_URL` (the trial env). For local practice, start the app
directly (see the dev runner next to this repo) and point the kit's local suite at it:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:3456 --token "$TOKEN" [--perf]
```
