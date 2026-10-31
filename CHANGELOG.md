# Changelog

All notable changes to wuzapi-mcp are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-31

### Added
- Windows: `scripts\init-env.ps1` creates `.env` from PowerShell, the README has the Docker Desktop
  install steps, and `send_file`, `send_voice` and `download_media` understand Windows paths
  (`C:\Users\me\…`). A `.gitattributes` keeps the shell script usable from WSL and Git Bash.
- CI runs both init scripts, on Linux and on Windows, and checks the `.env` they produce.

### Changed
- The folder files are sent from and the folder downloads land in are `FILES_ROOT` and
  `DOWNLOADS_DIR` in `.env`, your home folder by default. Inside the container they are mounted at
  `/files` and `/downloads` and the server maps paths in both directions, so Claude keeps using the
  paths of your computer. Existing installations need no change.

## [0.2.1] - 2026-10-30

### Fixed
- Poll voters who are not in your address book are shown with their phone number, taken from the group's member list, instead of a privacy ID — and no longer counted as not having voted.

## [0.2.0] - 2026-10-30

### Added
- Poll results: `get_poll_results` shows who voted what, with names and numbers, and in a group who has not voted yet. Votes are kept as they arrive and read from the history the phone sends; a changed vote replaces the old one.
- Groups: `create_group` creates a group with admins of your choice and lets every member add people, `update_group_participants` adds, removes, promotes and demotes, and `get_group_invite_link` gives the link for people whose privacy settings block being added.
- A new README: what you can ask, why it is worth it, a two-minute start, and how to connect Gemini CLI, Codex, Cursor, VS Code and Claude Desktop as well as Claude Code — any MCP client on the same computer works.

### Changed
- `get_poll_results` explains when older votes cannot be fetched from the phone, instead of listing the whole group as not having voted.
- `get_group_info` shows names from your archive for members WhatsApp lists only by number, and who can add members.

## [0.1.0] - 2026-10-28

The first preview: WuzAPI and wuzapi-mcp on your own computer, your WhatsApp archived and searchable, and Claude Code able to read, search and send. Running on a server for the Claude apps comes next.

### Added
- WuzAPI and wuzapi-mcp run together in Docker, reachable from this machine only, with their data on persistent volumes.
- A status page at http://127.0.0.1:8091: whether WhatsApp is linked, the QR to link it (it follows the code as WhatsApp changes it), the archive's numbers, and the command that connects Claude Code.
- Every message is archived as it arrives, together with the history the phone sends when it links. Status updates are left out. Full-text search ignores accents.
- Linking a WhatsApp starts from an empty archive; unlinking, from the page or from the phone, deletes the archive and WuzAPI's copy.
- MCP tools for Claude Code over HTTP: search contacts, list chats, read and search messages, message context, last interaction, groups; send messages with quoted replies, files, voice notes, reactions and polls; download media; transcribe voice notes.
- Voice transcription through OpenAI, ElevenLabs or a local Whisper server, off by default.
- People in your address book are filed under their phone number even when WhatsApp names them by a privacy ID, so one person is one chat. The page shows how many chats are still known only by a privacy ID.
- The page tells when the phone's history is still arriving and when it is complete, and shows the running version.
- A ready-made Docker image for amd64 and arm64 is published with every release: `docker compose up -d` downloads it instead of building.
- `scripts/init-env.sh` writes a `.env` with random secrets and this machine's time zone.
- Documentation: configuration, architecture, troubleshooting, security and contributing guides.
