# Hosted mode: a server, for the Claude apps

On your own computer wuzapi-mcp serves the assistants that run there — Claude Code, Cursor, Gemini
CLI. The **claude.ai apps** (web, phone, Claude Desktop with a connector) and ChatGPT are different:
their servers have to reach yours over the internet. For that wuzapi-mcp runs on a server, behind
HTTPS, with a login that only you can pass. This page is that setup.

A VPN such as Tailscale is not enough here: it lets *your* devices reach the server, but Anthropic's
servers are not on your network. It works fine for Claude Code on another machine of yours.

## What you need

- A Linux server with Docker and Docker Compose (any small VPS does).
- A host name that points at it: `wa.example.com` with an `A` record to the server's IP.
- Ports **80** and **443** open to the internet. Nothing else is published: WuzAPI and wuzapi-mcp
  stay on the compose network, reachable only through Caddy.

## Install

On the server, as a normal user that can run Docker:

```bash
git clone https://github.com/alessio-ragni/wuzapi-mcp.git && cd wuzapi-mcp
scripts/init-env.sh
```

Then open `.env` and set the hosted-mode block:

```ini
PUBLIC_URL=https://wa.example.com        # https, no path
PUBLIC_HOST=wa.example.com               # the same host name: Caddy gets the certificate for it
OWNER_PASSPHRASE=a long passphrase only you know
COMPOSE_FILE=docker-compose.yml:docker-compose.hosted.yml
TZ=Europe/Rome
```

The passphrase is what stands between the internet and your WhatsApp: make it long (12 characters
is the minimum, a sentence is better) and keep it in a password manager, because you will type it on
your phone. Then:

```bash
docker compose up -d
```

Caddy asks Let's Encrypt for the certificate on first start; give it a minute. Open
`https://wa.example.com`, sign in with the passphrase, and scan the QR as on your computer.

## Connect the Claude apps

In **claude.ai** (web, or the phone app): *Settings → Connectors → Add custom connector*. Name it
`WhatsApp`, give it `https://wa.example.com/mcp` as the URL, leave the OAuth fields empty, and
*Connect*. Your browser lands on the server's page, you type the passphrase once and allow it. The
connector then shows as connected; turn it on in a chat and ask for your latest chats.

Behind that click is standard OAuth 2.1: Claude registers itself with your server, you approve it
with the passphrase, and it receives a token it refreshes by itself. Every connector and every
device goes through that once; nothing is stored on Anthropic's side but the token.

**Claude Code** shows your claude.ai connectors on its own, so once the connector exists you no
longer need the local server: `claude mcp remove whatsapp --scope user` if you had added it. (You
can also point Claude Code at the server directly with `claude mcp add --transport http …/mcp`; it
goes through the same login in your browser.)

Other assistants that speak MCP with OAuth work the same way: give them `https://wa.example.com/mcp`.

## What the login protects

| Who | Gets in with | For how long |
|---|---|---|
| You, in a browser | the passphrase, on the page | a cookie for 30 days, or until *Sign out* |
| An assistant | your approval, once, with the passphrase or the cookie | an access token for one hour, renewed from a refresh token for 90 days, rotated on every renewal |

Everything else answers 401. Five wrong passphrases from one address block it for a quarter of an
hour. Tokens, codes and sessions are stored hashed in `auth.db`, next to the archive, in the
`mcp-data` volume. Unlinking WhatsApp wipes the archive but not the logins.

To cut everyone off: change `OWNER_PASSPHRASE` in `.env`, then

```bash
docker compose up -d
docker compose exec wuzapi-mcp node -e "require('better-sqlite3')('/data/auth.db').exec('DELETE FROM oauth_tokens; DELETE FROM owner_sessions')"
```

Every connector then asks you to sign in again.

## Security notes

- Docker publishes ports past `ufw` and other host firewalls. That is why this setup publishes
  **only Caddy**: check with `docker compose ps` that `wuzapi` and `wuzapi-mcp` show no ports.
- Anthropic's requests come from `160.79.104.0/21`. If you want to allow only Claude to reach `/mcp`
  you can restrict that path in the `Caddyfile`; the page and `/authorize` must stay open to you.
- The server holds your WhatsApp session and your whole archive. Treat it as you would your phone:
  disk encryption, SSH keys only, updates.
- Files: `download_media` answers with a download link that opens on the phone without signing in.
  It expires after `MEDIA_LINK_HOURS` (24 by default); anyone you forward it to can download that
  one file until then.
- Everything in [SECURITY.md](../SECURITY.md) still applies, above all: messages are untrusted text,
  keep the confirmation on for the sending tools.

## Update, uninstall

Same as locally: `git pull && docker compose pull && docker compose up -d`, and
`docker compose down -v` to remove everything, certificate included. Then remove the device on your
phone and delete the connector in claude.ai.
