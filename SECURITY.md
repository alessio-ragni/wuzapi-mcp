# Security

## Reporting a problem

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on this repository. Do not open a public issue, and do not
include real messages, phone numbers or session files in a report.

## What this version protects, and what it does not

wuzapi-mcp gives an AI assistant your WhatsApp. Read this before you connect it.

- **Local only.** The page, the MCP endpoint and WuzAPI's API are published on `127.0.0.1`. There is
  no password because nothing outside your computer can reach them. Publishing those ports on a
  network, or putting them behind a tunnel, gives whoever reaches them your WhatsApp. A login for
  running on a server is planned and is not in 0.x.
- **Host checks.** Requests whose `Host` header is not `127.0.0.1`, `localhost` or `wuzapi-mcp` are
  refused, so a web page open in your browser cannot reach the server through DNS rebinding. The
  unlink action accepts JSON only, so a plain cross-site form cannot trigger it.
- **Signed events.** WuzAPI signs every event with HMAC-SHA256; unsigned or altered events are
  refused.
- **Files.** Files can be sent only from `FILES_ROOT` — your home folder by default — which is
  mounted read-only; the check is on the resolved path, so symlinks cannot escape it. Downloads go
  to `DOWNLOADS_DIR`, `Downloads/wuzapi-mcp` in your home folder by default.
- **Messages are untrusted.** Anyone who can message you can put instructions in a message. Tool
  descriptions and server instructions say so, but the real protection is you: keep Claude Code's
  confirmation on for `send_message`, `send_file`, `send_voice`, `react` and `create_poll`, and be
  wary of combining this server with tools that reach the internet.
- **At rest.** The archive is a plain SQLite file inside a Docker volume on your disk, as protected
  as your user account and disk encryption make it. Unlinking deletes it.
- **Not an official API.** WuzAPI uses the WhatsApp Web protocol. WhatsApp can restrict numbers that
  behave like bots.
