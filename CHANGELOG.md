# Changelog

All notable changes to wuzapi-mcp are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- WuzAPI runs in Docker, bound to this machine only, with its session and data on persistent volumes.
- `scripts/init-env.sh` writes a `.env` with random secrets; `.env.example` documents every setting.
- `scripts/pair.sh` links your WhatsApp: it creates the WuzAPI user, keeps the history synced at pairing, opens the QR page and waits until the phone has scanned it.
