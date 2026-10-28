# wuzapi-mcp

Your personal WhatsApp, inside Claude. An [MCP](https://modelcontextprotocol.io) server built on
top of [WuzAPI](https://github.com/asternic/wuzapi).

Ask Claude to find what someone said last spring, summarise a group you muted, reply to a message
quoting it, send a file or a voice note, react, or create a poll — from your own archive, on your
own machine.

> **Preview (0.x).** It runs on your own computer and Claude Code uses it there. Running it on a
> server for the Claude apps (HTTPS and a login) is the next step and is not in this version.

## How it fits together

```
WhatsApp ⇄ WuzAPI ──signed webhooks──▶ wuzapi-mcp ── archive (SQLite, full-text search)
                  ◀──────REST────────       │
                                      status/QR page · MCP over HTTP
                                              │
                                         Claude Code
```

- **WuzAPI** holds the WhatsApp session: it joins your account as a linked device, like WhatsApp
  Web. It is used as is, unmodified.
- **wuzapi-mcp** archives every message WuzAPI forwards, shows a page with the link status and the
  QR, and gives Claude the tools below.

Both run in Docker on your machine. There is no central service: nothing leaves your computer
except what Claude reads through a tool you allowed. One installation holds one WhatsApp account.

## Install

You need [Docker](https://docs.docker.com/get-docker/) and `openssl`.

```bash
git clone https://github.com/alessio-ragni/wuzapi-mcp.git
cd wuzapi-mcp
scripts/init-env.sh        # writes .env: random secrets and your time zone
docker compose up -d       # downloads and starts WuzAPI and wuzapi-mcp
```

Open **http://127.0.0.1:8091**, then on your phone go to WhatsApp → Settings → Linked devices →
Link a device and scan the QR. The page turns to *Linked* and the archive fills up while the phone
sends its history — up to a year, over a few minutes.

Then connect Claude Code once (the page shows the same line):

```bash
claude mcp add --transport http --scope user whatsapp http://127.0.0.1:8091/mcp
```

Open a new Claude Code session and ask *"my latest WhatsApp chats"*.

Both ports are bound to `127.0.0.1`: the page and the MCP endpoint answer to your computer only,
which is why there is no password. Do not publish them on a network.

## Tools

| Read | Write | Media |
|---|---|---|
| `search_contacts`, `list_chats`, `get_chat`, `list_messages`, `search_messages`, `get_message_context`, `get_last_interaction`, `list_groups`, `get_group_info` | `send_message` (with quoted reply), `send_file`, `send_voice`, `react`, `create_poll` | `download_media`, `transcribe_voice` |

- Times are shown in your time zone; dates can be given as `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.
- `send_file` and `send_voice` take the path of a file on your computer (your home folder is mounted
  read-only for that). Any audio format works for voice notes; WuzAPI converts it.
- `download_media` saves into `~/Downloads/wuzapi-mcp` and returns the path.
- `transcribe_voice` is off until you choose a provider — see
  [configuration](docs/configuration.md#voice-transcription).

Claude Code asks before each tool call unless you allow it; keep that on for the sending tools.

## The archive

- Every message is stored once, whether it arrives live or with the history the phone sends when it
  links. WhatsApp's status updates are left out.
- Search is full-text, ignores accents and matches word prefixes: `caffe` finds *caffè*.
- People in your address book are filed under their phone number even when WhatsApp names them by a
  privacy ID. People who are not in your address book appear by the name they chose.
- **Linking a WhatsApp starts from an empty archive.** Unlinking — the button on the page, or
  removing the device on your phone — deletes the archive and everything WuzAPI kept.
- Restarting the computer or the containers keeps everything.
- Photos, videos, voice notes and documents are not copied in advance; they are downloaded when
  Claude asks for one.

## Update

```bash
git pull
docker compose pull
docker compose up -d
```

To stay on a version, set `WUZAPI_MCP_VERSION=0.1.0` in `.env`. Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

## Uninstall

```bash
docker compose down -v     # stops everything and deletes the session and the archive
```

Then remove the device from your phone (WhatsApp → Settings → Linked devices) and delete the folder.

## FAQ

**Why Docker?** WuzAPI ships as a Docker image, and Docker lets the same two commands start
everything on a Mac, on Linux and on a server, restart it after a reboot, and keep it fenced off
from the rest of your computer.

**Why do some chats show a name but no number?** WhatsApp is moving to privacy IDs (`…@lid`) that
hide phone numbers. wuzapi-mcp maps them back for everyone in your address book; for anyone else,
WhatsApp does not tell.

**Is this allowed?** It is not an official WhatsApp API — see the warning below.

**Something is wrong.** See [troubleshooting](docs/troubleshooting.md).

## Read this before using it

- **This is not an official WhatsApp API.** WuzAPI speaks the WhatsApp Web protocol through
  [whatsmeow](https://github.com/tulir/whatsmeow). Automated use can get a number restricted. Use
  it on your own account, at a human pace.
- **Messages are untrusted input.** Anyone who writes to you can put instructions in a message. An
  assistant that reads everything and can send to anyone is exactly what prompt injection targets.
  Keep confirmations on for the sending tools. More in [SECURITY.md](SECURITY.md).

## More

- [Configuration](docs/configuration.md) — every setting in `.env`
- [Architecture](docs/architecture.md) — how a message travels, what is stored where
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)

## Credits

The tool set is inspired by [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp),
which showed how good WhatsApp feels inside Claude. The WhatsApp side is entirely
[WuzAPI](https://github.com/asternic/wuzapi) and [whatsmeow](https://github.com/tulir/whatsmeow).

## License

MIT
