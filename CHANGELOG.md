# Changelog

All notable changes to wuzapi-mcp are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Poll results: `get_poll_results` shows who voted what, with names and numbers, and in a group who has not voted yet. Votes are kept as they arrive and read from the history the phone sends; a changed vote replaces the old one.
- Groups: `create_group` creates a group with admins of your choice and lets every member add people, `update_group_participants` adds, removes, promotes and demotes, and `get_group_invite_link` gives the link for people whose privacy settings block being added.
- The README shows how to connect Gemini CLI, Codex, Cursor, VS Code and Claude Desktop, not only Claude Code: any MCP client on the same computer works.

### Changed
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
