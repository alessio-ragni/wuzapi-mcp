# Security

## Reporting a problem

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on this repository. Do not open a public issue, and do not
include real messages, phone numbers or session files in a report.

## What this version protects, and what it does not

wuzapi-mcp gives an AI assistant your WhatsApp. Read this before you connect it.

- **Local only, by default.** The page, the MCP endpoint and WuzAPI's API are published on
  `127.0.0.1`. There is no password because nothing outside your computer can reach them.
  Publishing those ports on a network, or putting them behind a tunnel, gives whoever reaches them
  your WhatsApp. The server refuses to start with a public `PUBLIC_URL` and no passphrase.
- **Hosted mode** ([docs/hosted.md](docs/hosted.md)) is the supported way to put it on the
  internet: only Caddy is published, with HTTPS; the page and the API need the owner's passphrase
  (constant-time check, five failures per address then a 15-minute block, HttpOnly SameSite cookie);
  the MCP endpoint needs an OAuth 2.1 bearer token that only the owner's approval can produce
  (PKCE, single-use codes, hashed tokens, one-hour access tokens, rotating refresh tokens,
  revocation). Changing the passphrase and clearing `auth.db` signs every assistant out.
- **Host and origin checks.** Requests whose `Host` header is not `127.0.0.1`, `localhost`,
  `wuzapi-mcp` or the host of `PUBLIC_URL` are refused, so a web page open in your browser cannot
  reach the server through DNS rebinding. The unlink action accepts JSON only, and in hosted mode
  every form post and the unlink must come from the server's own origin, so a cross-site page
  cannot trigger them.
- **Signed events.** WuzAPI signs every event with HMAC-SHA256; unsigned or altered events are
  refused.
- **Files.** Files can be sent only from `FILES_ROOT` — your home folder by default — which is
  mounted read-only; the check is on the resolved path, so symlinks cannot escape it. Downloads go
  to `DOWNLOADS_DIR`, `Downloads/wuzapi-mcp` in your home folder by default.
- **Download links.** `download_media` returns a link that downloads one file without a login, so
  that it opens on a phone. It names one message, expires after `MEDIA_LINK_HOURS` (24 by default),
  and is signed with HMAC-SHA256 under a random key kept in the archive: it cannot be altered to
  reach another file, and wiping the archive voids every link. Until it expires, treat it like the
  file itself.
- **Messages are untrusted.** Anyone who can message you can put instructions in a message. Tool
  descriptions and server instructions say so, but the real protection is you: keep Claude Code's
  confirmation on for the sending tools and for `delete_message`, `leave_group`,
  `update_group_participants` and `block_contact`, and be wary of combining this server with tools
  that reach the internet.
- **At rest.** The archive is a plain SQLite file inside a Docker volume on your disk, as protected
  as your user account and disk encryption make it. Unlinking deletes it.
- **Not an official API.** WuzAPI uses the WhatsApp Web protocol. WhatsApp can restrict numbers that
  behave like bots.
