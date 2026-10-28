---
name: release
description: The whole way out of this repository — checks, secret scan, one commit, the push to GitHub, the changelog closed into a version, the tag and the GitHub Release. Use it whenever the user asks for the work to be shipped, in whatever words and whatever language — "/release", "/release minor", "release it", "ship it", "commit and push", "fai la release", "committa e pusha", "pubblica". Asking is the authorisation: it does not stop to ask again before pushing. Do not use it to write a commit message on its own or to look at what changed.
---

# /release [patch | minor | major]

One road out: checks → secret scan → commit → push `main` → changelog closed into a version →
tag → GitHub Release. There is no package registry and no deploy: the GitHub Release *is* the
release. Whoever runs wuzapi-mcp pulls a tag.

The argument forces the bump. Without it, decide it yourself and say why in one line.

## Why the order matters

This repository is public. A push cannot be taken back: once a phone number, a name, a message or
a key reaches GitHub, it has to be treated as leaked, whatever is rewritten afterwards. That is why
the secret scan runs before the commit, and why nothing in this skill is ever skipped to get a run
through.

## Before anything

```bash
git rev-parse --git-dir; git rev-parse --git-common-dir   # they differ → you are in a worktree
git branch --show-current
git status --porcelain
git fetch origin && git log origin/main..HEAD --oneline
git describe --tags --abbrev=0 2>/dev/null                # the last version, if any
```

Stop and say so when:

- **you are in a worktree.** Releasing from one pushes a branch nobody is on. Close it into
  `main` first, then come back;
- **the branch is not `main`**, or HEAD is detached;
- **`origin/main` has commits you do not have.** Pull first; never force-push;
- **there is nothing to do**: a clean tree, nothing ahead of `origin/main`, and no commit since
  the last tag. Say that plainly. It is an answer, not a failure.

## 1 · Checks

Run whatever the project has, and run it for real:

- `package.json` present → `npm ci`, then `npm run typecheck` and `npm test` if those scripts
  exist;
- `docker compose config -q` (in a clean checkout this needs a `.env`; use
  `cp .env.example .env.check && docker compose --env-file .env.check config -q && rm .env.check`
  with dummy values if the real one is missing);
- `bash -n scripts/*.sh`.

Red means stop. Never `--no-verify`, never a skipped test, never a weakened assertion.

## 2 · Secret scan

```bash
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 dir /repo --no-banner --redact
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 git /repo --no-banner --redact
```

Then look at the diff yourself for what gitleaks cannot know: real phone numbers, real names,
message text, JIDs (`…@s.whatsapp.net`, `…@g.us`), anything taken from a real session. Fixtures use
invented data only. `.env`, `data/` and any `*.db` must not be staged — check
`git status --porcelain` once more.

Anything found → stop, say what and where, do not commit.

## 3 · Changelog

Every user-visible change needs a line under `## [Unreleased]` in `CHANGELOG.md`, written for
the person running wuzapi-mcp — what is different for them, not which function moved. Add what is
missing from the diff and the commits since the last tag. A change to `.claude/` alone is tooling,
not product: no entry.

## 4 · Commit and push

```bash
git add -A
git commit -m "<type>: <what is different now>"     # Conventional Commits, one line, English
git push origin main
```

If several unrelated things are in the tree, commit them separately rather than burying them
under one subject. Skip the commit when the tree is already clean.

## 5 · The version

The version is the tag. There is no tag yet → the first release is `0.1.0`.
While at `0.x`: new behaviour, or something removed or changed incompatibly → minor; fixes only →
patch. The argument, when given, wins.

1. In `CHANGELOG.md`, turn `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD` and put a fresh, empty
   `## [Unreleased]` above it.
2. If `package.json` exists, set its `version` to `x.y.z` (`npm version x.y.z --no-git-tag-version`).
3. Run the checks of step 1 again on this tree.
4. `git commit -am "chore: release x.y.z"` and `git push origin main`. The branch goes first: a
   tag pointing at a commit no branch contains is how a release gets lost.
5. `git tag -a vx.y.z -m "wuzapi-mcp x.y.z"` and `git push origin vx.y.z`.
6. Publish the GitHub Release with that version's changelog section as its notes:
   ```bash
   awk '/^## \[x.y.z\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > /tmp/notes.md
   gh release create vx.y.z --title "wuzapi-mcp x.y.z" --notes-file /tmp/notes.md
   ```
   `--prerelease` while the README still says early development.
7. If there is a CI workflow, watch it: `gh run list --limit 3`, then `gh run watch <id> --exit-status`.
   Red because of this change → fix forward on `main` with another commit. Red for a reason that
   was already there → say so; do not call the push green.

## Reporting back

Short and honest:

- the commit subject, and that it is on `origin/main`;
- the version, why that number, and the Release link;
- what the checks and CI decided, and anything skipped and why. Silence there reads as forgotten.
