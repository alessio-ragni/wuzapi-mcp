# Contributing

Issues and pull requests are welcome.

## Develop

```bash
npm ci
npm run typecheck
npm test
```

Node 24 runs the TypeScript in `src/` directly (type stripping): no build step, and only syntax
that can be erased (no enums, no parameter properties). `tsc` only checks types.

To run your changes against a real WhatsApp, use Docker: `docker compose up -d --build` builds the
image from your checkout instead of downloading the published one.

## Rules

- **No real data, ever.** No real phone numbers, names, messages, JIDs, tokens or session files in
  code, tests, fixtures, docs, issues or commit messages. Fixtures are invented
  (`test/fixtures.ts`, numbers in the fictional `1555…` range).
- **WuzAPI is used as is.** If it lacks something or misbehaves, open an issue or a pull request on
  [asternic/wuzapi](https://github.com/asternic/wuzapi) and work around it here.
- **English** in code, comments, docs and commits. Conventional Commits, one line.
- Every change a user would notice gets a line under `## [Unreleased]` in `CHANGELOG.md`, and the
  docs say what the code does.

## Release

Maintainers release with the `/release` command of Claude Code (`.claude/skills/release/`). By
hand, it amounts to:

1. move `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z] - date`, set the same version in
   `package.json`, commit and push `main`;
2. push the tag `vx.y.z`.

`.github/workflows/release.yml` then tests again, publishes the image
`ghcr.io/alessio-ragni/wuzapi-mcp` for amd64 and arm64, and creates the GitHub Release with the
changelog's notes.
