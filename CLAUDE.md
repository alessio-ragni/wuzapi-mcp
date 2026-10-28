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

- TypeScript, Node ≥ 22, official `@modelcontextprotocol/sdk`, `better-sqlite3` with FTS5, `zod`.
- One codebase, two entry points: `serve` (webhook receiver + archive writer + Streamable HTTP MCP
  with a built-in OAuth 2.1 server and an owner-password login page) and `stdio` (same tools for
  Claude Code, reading the same archive and calling WuzAPI directly).
- The archive is fed by WuzAPI webhooks (`Message`, `HistorySync`), verified with the HMAC header.
  Reads go to the archive; writes and media downloads go to WuzAPI's REST API.
- Tool descriptions state that message content is untrusted third-party text.
- Voice transcription providers: `openai`, `elevenlabs`, `whisper-local`, `off`.
- `docker-compose.yml` runs WuzAPI + wuzapi-mcp together.

## Order of work

1. WuzAPI in Docker, paired by QR. 2. Config, WuzAPI client, webhook + HMAC, SQLite archive.
3. Read tools over stdio. 4. Write tools (send, quoted reply, react, file, voice, groups, polls).
5. Media + transcription. 6. HTTP + OAuth, tested with MCP Inspector and a temporary tunnel.
7. README, `.env.example`, CI (typecheck + unit tests on fixtures).

## Shipping

Everything leaves through `/release` (`.claude/skills/release/`): checks, secret scan, commit,
push, changelog closed into a version, tag, GitHub Release. Never push by hand around it.
