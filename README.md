# GitHub-compatible git forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/wandavenus/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/wandavenus/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node process with no
dependencies: git smart HTTP (clone, fetch and push with real pack handling),
the REST v3 API for repositories, issues, pull requests and contents, the
GraphQL v4 API, and an MCP endpoint, all served from one in-memory store.
Built as an entry for the [make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node main.ts
```

The program needs Node 22 or later and the harness environment variable
`MAKEFUN_ENV_URL` pointing at the suite it registers with: it binds an
ephemeral port of its own, posts that port to `$MAKEFUN_ENV_URL/register`,
serves until the suite reports done, and then exits 0. There is nothing to
install: the only imports are Node's standard library and the entry's own
source.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` boot probe |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: queries, mutations, pagination, `node(id:)` and search |
| `POST /mcp` | Model Context Protocol over streamable HTTP: six tools sharing the REST store |
| `/<owner>/<repo>.git/...` | git smart HTTP v2 and v0: `info/refs`, `git-upload-pack`, `git-receive-pack` |

Every REST and API reply is JSON with an `X-GitHub-Request-Id` header, and API
calls are authenticated with the bearer token the harness provides. State is
deterministic: sequential ids and counter-derived timestamps, so two runs of
the same scenario leave the same export.

## Layout

- `main.ts`: the harness lifecycle (bind, register, wait for done, exit).
- `app.ts`: the whole forge — git object and pack store, the four protocol
  surfaces, and the in-memory data store.
- `LICENSE`: MIT.

Locally verified with the bounty kit's own conformance runner: 120 of 120
checks pass (git 30, repositories 15, issues 15, pull requests 20, GraphQL 20,
MCP 15, protocol 5).
