# Troubleshooting

Start with the page, **http://127.0.0.1:8091**, and the logs:

```bash
docker compose ps                       # are both services up?
docker compose logs -f wuzapi-mcp       # archive, webhooks, privacy-ID matching
docker compose logs -f wuzapi           # the WhatsApp side
```

## The page does not open

- `docker compose ps` should list `wuzapi` and `wuzapi-mcp` as *Up*. If not:
  `docker compose up -d`, then look at `docker compose logs wuzapi-mcp`.
- `Invalid configuration` in the logs: a setting in `.env` is missing or wrong; the message names
  it. A fresh `.env` comes from `scripts/init-env.sh` (it will not overwrite an existing one).
- A different port in `.env` (`MCP_HOST_PORT`) means a different address.

## "WuzAPI is not answering"

WuzAPI is still starting, or stopped. Wait a few seconds; if it stays, check
`docker compose logs wuzapi`.

## The QR does not appear, or keeps changing

The QR only exists while the page is open and nothing is linked. WhatsApp issues a new code every
20 seconds or so and the page follows it; after a minute or two WhatsApp stops issuing codes and
wuzapi-mcp starts a new round. If nothing appears for long, reload the page.

Do not use WuzAPI's own page at `127.0.0.1:8090/login`: in 1.1.0 it says "Connected!" without
showing a QR (see below).

## Linked, but the archive stays empty

- New messages arrive within seconds. If none do, look for `webhook rejected: bad signature` in
  `docker compose logs wuzapi-mcp`: the HMAC key differs between the two services, which only
  happens if `.env` was edited by hand. Restore it and `docker compose up -d`.
- History only comes with a link. If the phone was linked before wuzapi-mcp was running, its history
  went nowhere: unlink from the page and scan the QR again.

## The history is partial

The phone decides how much history to send, whatever `WUZAPI_SYNC_DAYS` asks for. Older chats and
long ones are often cut. Linking again does not usually bring more.

## A chat shows a privacy ID (…@lid) instead of a number

That person is not in your address book, so WhatsApp gives no number for them. If they are in your
address book, matching runs at start and every 30 minutes; the page shows how many chats are still
known only by a privacy ID.

## Claude Code does not see the tools

- `claude mcp list` should show `whatsapp` as connected. If it is missing, run the line on the
  page; if it is failing, check that the page opens.
- Tools are loaded when a session starts: open a new one after adding the server.

## Sending a file fails with "outside … the folder files can be sent from"

Only files in your home folder can be sent. Move the file there, or see
[configuration](configuration.md#files).

## Known WuzAPI issues

wuzapi-mcp works around these in WuzAPI 1.1.0; they are reported upstream.

- **History is not stored on SQLite.** With `history` > 0, every save fails with
  `no such table: whatsmeow_message_secrets`, so WuzAPI keeps no copy to import later. wuzapi-mcp
  sets `history` to 0 and relies on the phone's history at link time.
- **The `/login` page never shows the QR.** It reads `LoggedIn`/`Connected` from the status, which
  WuzAPI returns as `loggedIn`/`connected`, and says "Connected!" while nothing is linked.
  wuzapi-mcp's own page shows the QR.

## Starting over

```bash
docker compose down -v      # deletes the session, the archive and WuzAPI's data
docker compose up -d
```

Then remove the old device on your phone and scan the new QR.
