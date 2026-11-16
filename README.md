# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bibitcuan1-boop/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bibitcuan1-boop/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge from scratch, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01): git smart HTTP
(upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP, in one Node
process with no dependencies and no git binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. `main.ts` is the
entry <-> env lifecycle (bind an ephemeral port, register with
`$MAKEFUN_ENV_URL`, poll `/done`); `app.ts` is the server.

## Layout

- `main.ts` — lifecycle (kept as the starter ships it).
- `app.ts` — HTTP server: routing, auth, body reading, JSON plumbing.
- `store.ts` — the in-memory model: repositories, objects, refs, issues, PRs.
- `gitobj.ts` — git objects, packs, reachability, shallow-fetch planning.
- `githttp.ts` — pkt-line codec and the smart-HTTP handlers.
- `rest.ts` — GitHub REST v3 (repos, branches, commits, contents, labels,
  issues, comments, pull requests, merges).
- `graphql.ts` — GraphQL v4: a small parser and resolver for the documents
  `gh` and `github-mcp-server` send.
- `mcp.ts` — Model Context Protocol over Streamable HTTP (modern era
  `server/discover`, `tools/list`, `tools/call`).

## Notes

- Everything is in memory; the request path never touches disk.
- Replays are deterministic: no wall clock and no unseeded randomness in
  anything the server sends. Server-created commits use a fixed epoch plus a
  counter, REST timestamps are one fixed date, and `X-GitHub-Request-Id` is a
  per-request counter.
- The viewer identity is the scenario's fixed viewer (`adaiversen`); the first
  owner-scoped request on an empty store rebinds it if it names someone else.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1kbmej5w&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
