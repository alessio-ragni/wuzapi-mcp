# Changelog

All notable changes to wuzapi-mcp are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- WuzAPI and wuzapi-mcp run together in Docker, reachable from this machine only, with their data on persistent volumes.
- A status page at http://127.0.0.1:8091: whether WhatsApp is linked, the QR to link it (it follows the code as WhatsApp changes it), the archive's numbers, and the command that connects Claude Code.
- Every message is archived as it arrives, together with the history the phone sends when it links. Status updates are left out. Full-text search ignores accents.
- Linking a WhatsApp starts from an empty archive; unlinking, from the page or from the phone, deletes the archive and WuzAPI's copy.
- MCP tools for Claude Code over HTTP: search contacts, list chats, read and search messages, message context, last interaction, groups; send messages with quoted replies, files, voice notes, reactions and polls; download media; transcribe voice notes.
- Voice transcription through OpenAI, ElevenLabs or a local Whisper server, off by default.
- `scripts/init-env.sh` writes a `.env` with random secrets and this machine's time zone.
