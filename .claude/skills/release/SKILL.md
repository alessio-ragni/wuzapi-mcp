---
name: release
description: The whole way out of this repository — checks, secret scan, documentation and changelog, one commit, the push to GitHub, and the version tag whose arrival publishes the Docker image on GHCR and the GitHub Release. Use it whenever the user asks for the work to be shipped, in whatever words and whatever language — "/release", "/release minor", "ship it", "cut a release", "publish", "commit and push", "fai la release", "committa e pusha", "pubblica". Asking is the authorisation: it does not stop to ask again before the push or the tag. Do not use it to write a commit message on its own, to look at what changed, or when only the changelog is wanted.
---

# /release [patch | minor | major]

There is one road out of this repository and this is it: checks → secret scan → docs and
changelog → commit → push `main` → version → tag. The tag is what publishes: its arrival on GitHub
starts `.github/workflows/release.yml`, which tests again, builds the Docker image for
`linux/amd64` and `linux/arm64`, pushes it to `ghcr.io/alessio-ragni/wuzapi-mcp`, and creates the
GitHub Release with the changelog's notes.

The argument forces the bump. Without it, decide it and say why in one line.

## Why the order matters

This repository is public. A push cannot be taken back: a phone number, a name, a message or a key
that reaches GitHub has to be treated as leaked, whatever is rewritten afterwards. A version that
reaches GHCR can only be followed by another one. So the scan runs before the commit, the branch
goes up before the tag, and nothing here is ever skipped to get a run through.

## The stack it stands on

| What | Which |
|---|---|
| Commit and tag | `git`, Conventional Commits, one line, imperative, English |
| Checks | `npm ci`, `npm run typecheck`, `npm test` (Node's test runner, invented fixtures) |
| Secret scan | gitleaks in Docker, `zricethezav/gitleaks:v8.30.1` |
| On every push to `main` | `.github/workflows/ci.yml` — typecheck, tests, compose file |
| On every tag `v*` | `.github/workflows/release.yml` — tests, tag/version agreement, image, Release |
| Credentials | none: the workflows use `GITHUB_TOKEN`. There is no registry token anywhere |
| Watching runs | the `gh` CLI, authenticated as the repository owner |

## Before anything

```bash
git rev-parse --git-dir; git rev-parse --git-common-dir   # they differ → you are in a worktree
git branch --show-current
git status --porcelain
git fetch origin && git log --oneline origin/main..HEAD; git log --oneline HEAD..origin/main
git describe --tags --abbrev=0 2>/dev/null                # the last version, if any
node -p "require('./package.json').version"
```

Stop and say so, rather than carrying on, when:

- **the two git directories differ** — this is a worktree. Releasing from one pushes a branch
  nobody is on. Close it into `main` first, then come back;
- **the branch is not `main`**, or HEAD is detached;
- **`origin/main` has commits you do not have** — pull first; never force-push;
- **there is nothing to do** — a clean tree, nothing ahead of `origin/main`, no commit since the
  last tag. Say that plainly; it is an answer, not a failure.

## 1 · Checks

```bash
npm ci
npm run typecheck
npm test
bash -n scripts/*.sh
docker compose config -q     # needs a .env; see below
```

Without a `.env` (a fresh clone), validate the compose file against a throwaway one and delete it:
`cp .env.example .env.check && sed -i.bak 's/=$/=0123456789abcdef0123456789abcdef/' .env.check && docker compose --env-file .env.check config -q; rm -f .env.check .env.check.bak`.

Red means stop. Never `--no-verify`, never a skipped test, never a weakened assertion: a green run
bought that way is a lie that outlives the commit.

## 2 · Secret scan

```bash
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 dir /repo --no-banner --redact
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 git /repo --no-banner --redact
```

The `dir` scan reads the working tree, `.env` and `node_modules` included: a finding inside
`.env` (untracked, ignored) or `node_modules` is expected and is not a leak. Anything in a tracked
file or in history is.

Then read the staged diff yourself for what gitleaks cannot know: real phone numbers, real names,
message text, JIDs (`…@s.whatsapp.net`, `…@g.us`, `…@lid`) taken from a real session. Fixtures use
invented data only (`test/fixtures.ts`, numbers in the `1555…` range). `.env`, `data/` and any
`*.db` must not be staged.

Anything found → stop, say what and where, do not commit.

## 3 · Documentation and changelog

- Every change a user would notice gets a line under `## [Unreleased]` in `CHANGELOG.md`, written
  for the person running wuzapi-mcp — what is different for them, not which function moved.
- `README.md` and `docs/` (`configuration.md`, `architecture.md`, `troubleshooting.md`) say what
  the code now does: a new setting in `.env.example` is a new row in `docs/configuration.md`; a new
  tool is a new row in the README's table.
- A change to `.claude/` or `.github/` alone is tooling: no changelog entry, and say you skipped it.

## 4 · Commit and push

```bash
git add -A
git commit -m "<type>: <what is different now>"
git push origin main
```

One line, Conventional Commits, imperative, English. Unrelated things in the tree → separate
commits, not one subject burying them. Skip the commit when the tree is already clean.

Then watch CI on `main` (`gh run list --branch main --limit 2`, `gh run watch <id> --exit-status`).
Red because of this change → fix forward on `main`. Red for a reason that was already there → say
so and do not call the push green.

Stop here unless a release was asked for.

## 5 · The version

1. **The number.** No tag yet → `0.1.0`. While at `0.x`: new behaviour, or something removed or
   changed incompatibly → minor; fixes only → patch. The argument, when given, wins.
2. In `CHANGELOG.md`, turn `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD` and put a fresh, empty
   `## [Unreleased]` above it. The release workflow publishes exactly that section as the notes and
   fails if it is missing.
3. `npm version x.y.z --no-git-tag-version` — the workflow refuses a tag that disagrees with
   `package.json`.
4. `npm test` again, on the tree as it will be published.
5. `git commit -am "chore: release x.y.z"` and `git push origin main` — **the branch first**: a tag
   pointing at a commit no branch contains is how a release becomes archaeology.
6. `git tag -a vx.y.z -m "wuzapi-mcp x.y.z"` and `git push origin vx.y.z`. This, and nothing else,
   is what publishes. No question first: the user asked for the release.

## 6 · Check that it happened

```bash
gh run list --workflow=Release --limit 1
gh run watch <id> --exit-status
gh release view vx.y.z
docker manifest inspect ghcr.io/alessio-ragni/wuzapi-mcp:x.y.z | grep architecture
```

The manifest must list `amd64` and `arm64`. The very first image is private on GHCR: until the
owner makes the package public (github.com/users/alessio-ragni/packages/container/wuzapi-mcp/settings
→ Change visibility → Public), anonymous `docker pull` fails. Say so when it is still private.

## When it goes wrong

| What you see | What it is |
|---|---|
| `tag vX does not match package.json Y` | the bump and the tag disagree. Fix `package.json`, commit, delete and re-push the tag |
| `CHANGELOG.md has no section for X` | the `[Unreleased]` → `[X]` step was skipped. Same fix |
| `docker pull` says `denied` or `unauthorized` | the GHCR package is still private. Owner makes it public once |
| The arm64 build is slow | it runs under emulation and compiles better-sqlite3; minutes, not a hang |
| The tag is on GitHub but no workflow ran | Actions are disabled on the repository, or the tag was pushed somewhere else |
| `gh release create` says the release exists | a re-pushed tag. Not a failure; check the notes are right |

## Reporting back

Short and honest:

- the commit subject, and that it is on `origin/main`;
- what CI decided — the verdict, not the hope;
- for a release: the version and why that number, the Release link, the image tags, and whether
  the image is public;
- anything skipped, and why. Silence there reads as having forgotten.
