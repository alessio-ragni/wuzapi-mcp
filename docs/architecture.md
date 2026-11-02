# Architecture

## Two services

```
                        your computer
┌──────────────────────────────────────────────────────────────┐
│  wuzapi (WuzAPI 1.1.0)               wuzapi-mcp (this repo)  │
│  ─ WhatsApp session                  ─ archive.db (SQLite)   │
│  ─ REST API  :8080  ◀──── REST ────  ─ page        /         │
│  ─ events  ──── signed webhook ───▶  ─ MCP         /mcp      │
│                                      ─ webhook     /webhook  │
│  127.0.0.1:8090                      127.0.0.1:8091          │
└──────────────────────────────────────────────────────────────┘
        ▲                                     ▲
   WhatsApp servers                      Claude Code
```

- **WuzAPI** joins your account as a linked device and turns WhatsApp into a REST API. It runs
  unmodified, from its official image, with `-skipmedia` (events carry references to media, not the
  files).
- **wuzapi-mcp** is one Node process: it receives events, writes the archive, serves the page, and
  answers MCP requests. Source in `src/`.

Both ports are published on `127.0.0.1` only. Inside Docker the two services talk over their own
network. In [hosted mode](hosted.md) neither port is published: a Caddy container terminates HTTPS
and forwards to `wuzapi-mcp:3000`, and the server asks for a login (below).

## How a message travels

1. Someone writes to you. WhatsApp delivers it to your phone and to every linked device, WuzAPI
   included.
2. WuzAPI posts a `Message` event to `http://wuzapi-mcp:3000/webhook/wuzapi`, signed with
   HMAC-SHA256 over the exact body (`x-hmac-signature`). wuzapi-mcp checks the signature against
   `WUZAPI_GLOBAL_HMAC_KEY` and refuses anything that does not match.
3. The message is normalised (`src/ingest/normalize.ts`): text, caption, reply target, media
   reference, type. Protocol traffic (key exchange, reactions, receipts) and status updates are
   dropped.
4. It is stored once, keyed by chat and message id (`src/archive/archive.ts`), and indexed for
   full-text search (SQLite FTS5, accents ignored).
5. When Claude calls a read tool, the answer comes from the archive. When it sends, reacts or
   downloads, wuzapi-mcp calls WuzAPI's REST API.

Messages you send from your phone arrive the same way. Messages Claude sends do not come back as
events (WhatsApp does not echo them to the device that sent them).

## History

When a phone links, it sends its history in batches (`HistorySync` events): up to
`WUZAPI_SYNC_DAYS` days, as much as the phone chooses. The page shows the batches arriving and,
two minutes after the last one, the total.

History sent before wuzapi-mcp was listening is not lost only if WuzAPI kept a copy. wuzapi-mcp
imports WuzAPI's stored history at start, but WuzAPI 1.1.0 cannot store it on SQLite, so in
practice the history comes from linking.

## One account, and when the archive is wiped

The archive belongs to one WhatsApp account at a time.

| Event | What happens |
|---|---|
| A phone links through the QR (`PairSuccess`) | The archive is emptied, then filled by the phone's history. |
| Unlink button on the page | Logout from WhatsApp, archive emptied, WuzAPI user deleted with everything it stored, a fresh user created. |
| Device removed on the phone (`LoggedOut`) | Same as the button, without the logout. |
| A different account found linked at start | The archive is emptied. |
| Restart of the computer or the containers | Nothing is lost. |

## Phone numbers and privacy IDs

WhatsApp increasingly identifies people by a privacy ID (`…@lid`) instead of their number, so one
person can appear under two identities. wuzapi-mcp files everything under the phone number
whenever it can:

- events that carry both identities use the number;
- for everyone in your address book, wuzapi-mcp asks WuzAPI which privacy ID belongs to the
  number (`GET /user/lid/{jid}`), keeps the pair, and merges any chat or sender filed under the
  privacy ID into the number. Numbers are re-checked weekly;
- new messages from a known privacy ID are filed under the number as they arrive.

People outside your address book stay under their privacy ID, with the name they chose.

## Poll votes

WhatsApp encrypts votes. WuzAPI decrypts each one and adds it to the `Message` webhook as
`pollVote`, with the chosen options as SHA-256 hashes of their text. wuzapi-mcp keeps every poll's
options and each person's latest vote, and matches the hashes back to the options when asked. The
phone also attaches the votes to a poll when it sends history, so `get_poll_results` can ask for
the chat's recent history to fill in votes cast before they were kept. That is up to the phone,
and it may send nothing.

## What is stored where

| Where | What |
|---|---|
| volume `mcp-data` → `archive.db` | messages (text, captions, media references), chats, contacts' names, privacy-ID pairs |
| volume `mcp-data` → `auth.db` (hosted mode) | OAuth clients, hashed codes, tokens and browser sessions |
| volumes `caddy-data`, `caddy-config` (hosted mode) | the HTTPS certificate and Caddy's state |
| volume `wuzapi-data` | the WhatsApp session keys and WuzAPI's own database |
| volume `wuzapi-files` | files WuzAPI handles while sending |
| `DOWNLOADS_DIR` (`Downloads/wuzapi-mcp` in your home folder) | media Claude downloaded; mounted at `/downloads` inside the container |
| `FILES_ROOT` (your home folder), read-only | what `send_file` and `send_voice` may read; mounted at `/files`. Claude gives paths of your computer and `src/paths.ts` maps them to the mount, Windows paths included |
| `.env` | secrets and settings |

`docker compose down -v` deletes all three volumes.

## The MCP endpoint

`POST /mcp` speaks MCP's Streamable HTTP transport, stateless: each request gets a fresh server
over the same archive. Tool definitions are in `src/tools/`; every description that returns message
text says that the text is untrusted. The server's instructions tell the client to confirm before
sending anything the user did not ask for.

Locally there is no authentication: the endpoint is reachable from your computer only, and every
request's `Host` header must be `127.0.0.1`, `localhost`, `wuzapi-mcp` or the host of `PUBLIC_URL`,
which stops web pages in your browser from reaching it through DNS rebinding.

## Hosted mode: the login

With `OWNER_PASSPHRASE` set (`src/config.ts` → `config.hosted`), `src/http/server.ts` mounts the
owner login and an OAuth 2.1 authorization server, both in `src/http/auth/`:

- `store.ts` — `auth.db`, a second SQLite file in the data volume: registered clients, authorization
  codes, access and refresh tokens, browser sessions. Codes, tokens and session ids are random
  32-byte values stored as SHA-256 hashes; expired rows are pruned hourly. Unlinking WhatsApp wipes
  `archive.db`, never `auth.db`.
- `owner.ts` — the passphrase check (constant time, five failures per address then 15 minutes of
  429), the `wuzapi_owner` cookie (HttpOnly, Secure on https, SameSite=Lax, 30 days) and the
  same-origin check on every form post.
- `provider.ts` — the SDK's `OAuthServerProvider`: dynamic client registration (https redirects, or
  http on localhost for native clients), the consent page, single-use codes (10 minutes), access
  tokens (1 hour) paired with refresh tokens (90 days) that rotate on every refresh, revocation.
- The SDK's `mcpAuthRouter` serves `/.well-known/oauth-protected-resource/mcp`,
  `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register` and `/revoke`, and
  `requireBearerAuth` guards `/mcp`: no token means `401` with the `resource_metadata` pointer the
  clients discover the login from. PKCE (S256) is verified by the SDK.

The flow an assistant goes through: `401` on `/mcp` → reads the two metadata documents → registers
itself → sends the owner to `/authorize` → the owner types the passphrase on the consent page (or
just clicks *Allow* with a live cookie) → `/oauth/approve` issues a code and redirects back → the
assistant swaps the code for tokens at `/token` → calls `/mcp` with the bearer token, refreshing
before it expires.
