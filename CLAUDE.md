# CLAUDE.md — wuzapi-mcp

A public, MIT-licensed MCP server for WhatsApp on top of WuzAPI. See `README.md` for what it is.

## Rules that do not bend

- **This repo is public from the first commit.** No real phone numbers, names, messages, keys,
  tokens or session files ever enter it — not in code, fixtures, tests, docs or commit messages.
  Fixtures use invented data only. Run a secret scan before every push.
- **Everything is configuration.** Whoever installs it brings their own WuzAPI, password and
  provider keys through `.env` / environment. `.env.example` is committed; `.env` never is.
- **WuzAPI is used as is.** No fork, no patch. If WuzAPI lacks something, that becomes an upstream
  issue or PR, never a local workaround inside WuzAPI.
- **English** everywhere: code, comments, docs, commits.

## Design

- TypeScript run directly by Node 24 (type stripping, `erasableSyntaxOnly`, no build step), official
  `@modelcontextprotocol/sdk`, `better-sqlite3` with FTS5, `zod`, `express`.
- One process, `src/main.ts`: the webhook receiver (`/webhook/wuzapi`, HMAC-verified over the raw
  body), the archive writer, the status/QR page (`/`, `/api/status`, `/api/unlink`) and the MCP
  endpoint (`/mcp`, stateless Streamable HTTP). Claude Code connects over HTTP.
- The archive (`src/archive/`) holds one account. A new link (`PairSuccess`) or an unlink
  (`LoggedOut`, or the page's button) wipes it; unlinking also deletes the WuzAPI user with its data.
  On start it imports what WuzAPI already stored (`/chat/conversations`, `/chat/messages`).
- WuzAPI runs with `-skipmedia`: webhooks carry media references, files are downloaded on request.
- Privacy LIDs: everything is filed under phone-number JIDs where possible. `pn_lid` in the archive
  maps numbers to LIDs (looked up per contact via `GET /user/lid/{jid}`, weekly); `recordLid`
  merges LID chats into the number, `canonical()` maps new messages.
- Locally there is no authentication: everything is bound to `127.0.0.1` and the Host header is
  checked. Before the server goes on the internet it needs HTTPS and the owner login with OAuth 2.1 —
  that is the next piece of work, and nothing is exposed until it exists.
- Tool descriptions state that message content is untrusted third-party text.
- Voice transcription providers: `openai`, `elevenlabs`, `whisper-local`, `off` (default).

## Tests and CI

`npm run typecheck` and `npm test` (Node's test runner, invented fixtures in `test/fixtures.ts`).
`.github/workflows/ci.yml` runs both on every push. `.github/workflows/release.yml` runs on tags
`v*`: tests, tag/version check, multi-arch image to `ghcr.io/alessio-ragni/wuzapi-mcp`, GitHub
Release from the changelog section.

Docs live in `README.md` (users), `docs/configuration.md`, `docs/architecture.md`,
`docs/troubleshooting.md`, `SECURITY.md`, `CONTRIBUTING.md`. Keep them true to the code.

## Shipping

Everything leaves through `/release` (`.claude/skills/release/`): checks, secret scan, docs and
changelog, commit, push, version, tag — the tag publishes the image and the Release. Never push by
hand around it.
