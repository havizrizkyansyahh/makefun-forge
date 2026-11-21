# makefun-forge

A GitHub-compatible forge in one Node 22 process, built for make.fun's
`github-core-clone-01` bounty: git smart HTTP (v2 ls-refs/fetch with shallow
support, v0 receive-pack with report-status), GitHub REST v3 (repos, contents,
issues, labels, comments, pulls, merges), a GraphQL v4 subset for the documents
`gh` and github-mcp-server send, and an MCP streamable-HTTP endpoint with six
repository tools.

Everything is in memory: an object store keyed by SHA-1 with zlib loose objects,
refs, and the REST/GraphQL/MCP views over it. No dependencies, Node built-ins
only.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL` and
serves until the env says the trial is over.

## Layout

- `app.ts` — HTTP router, request ids, auth gate
- `store.ts` — repositories, git objects, refs, issues, pulls, labels
- `gitsrv.ts` / `pack.ts` — smart HTTP, pack writing and delta ingestion
- `rest.ts`, `graphql.ts`, `mcp.ts` — the three API surfaces

MIT licensed.
