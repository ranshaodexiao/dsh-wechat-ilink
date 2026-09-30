# Changelog

All notable changes to **dsh-wechat-ilink** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note on versions.** `0.1.0` → `0.6.4` are the *same* number series used during
> development; the first public release is simply `0.6.4`. Keeping one continuous
> series is deliberate — if the repository restarted at `0.1.0` while the working
> copies were already at `0.6.x`, an internal build and a published build could
> carry the same number and be told apart only by guesswork.
>
> The pre-release entries are kept because the bug sequence is the most useful
> documentation this project has: every one of them was an assumed DSH contract
> that turned out to be wrong.

## [0.6.5]

### Changed

- **Renamed the package to `dsh-wechat-ilink`** (was `dsh-wechat-clawbot-rc2`).
  npm already carries an unrelated, actively maintained `dsh-wechat-clawbot`
  (0.3.1), and a name differing only by a `-rc2` suffix invited users to mistake
  one for a fork of the other. `dsh-wechat-ilink` names the actual transport
  (Tencent's iLink Bot API) and collides with nothing.

  The repository moved with it:
  **https://github.com/ranshaodexiao/dsh-wechat-ilink** (GitHub redirects the old
  URL).

  Deliberately **not** renamed, because each is a stable runtime identity rather
  than a package name — changing any of them would orphan existing state:

  | Identity | Value |
  | --- | --- |
  | Cordis plugin `name` (the log tag) | `wechat-clawbot` |
  | Bundle row `id` | `wechat-clawbot` |
  | `sessionId` — the user's conversation | `wechat-clawbot` |
  | State directory — holds the WeChat token | `<DSH_HOME>/clawbot/` |
  | CLI binary | `dsh-wechat-ilink` (follows the package) |

  So an existing install keeps its bound account, its session history and its
  log path; only the install command changes.

## [0.6.4]

First public release.

### Fixed

- `src/cli.ts` now carries a `#!/usr/bin/env node` shebang, which survives
  compilation. Without it the declared `bin` entry could not be executed on
  Linux/macOS, so `dsh-wechat-ilink login` (or `npx`) would fail there.

### Added

- `.gitattributes` normalising every text file to LF in the repository and in
  every checkout (`*.cmd`/`*.bat` keep CRLF). Verified with real git: the
  previous 33 "LF will be replaced by CRLF" warnings are gone, and
  `git ls-files --eol` reports `w/lf` for every tracked file.

### Release model

GitHub carries **source only**; npm carries the **compiled release**. `lib/` is
git-ignored and produced by the `prepare` script, so the two channels can never
disagree about what shipped:

- `npm install` in the repo → `prepare` builds `lib/`
- `npm publish` → `prepare` builds, then `prepublishOnly` runs the full offline
  suite, so a failing build or test cannot reach the registry
- installing from npm → the tarball already contains `lib/`; no build step, and
  therefore no pnpm `allowBuilds` friction for users

### Documentation

- Installing is now **one command**: `dsh plugin --profile desktop add <spec>`.
  The official CLI forwards to pnpm *and* writes the package into
  `dsh.profile.bundles` itself (`activateNewBundles`), so no hand-editing of
  `package.json` is needed. Verified: after install the bundles array gains the
  package, and `--dump-config` shows the plugin's composed row.
- Documented why a **git** install is not the recommended path: pnpm blocks the
  `prepare` script by default, and this repository ships no `lib/`.
- Added `LICENSE`, `.gitignore` and this changelog; removed every developer
  machine path and identifier from the shipped tree.
- Added a portability check: clean clone at another path, another `DSH_HOME`,
  `npm install` builds unaided, suite green, real Cordis load passes.

### Changed

- `/list` no longer prints a `已隐藏：N 个已归档、M 个子代理` line. Which sessions
  were filtered is diagnostic detail; it now goes to the log (`debug` level)
  instead of to the user's phone.
- The `当前：…` target line is shown unconditionally again, in `/list`,
  `/list all` and `/help`.

### Internal

- Removed the `SessionListing` wrapper type: `listSessions()` returns
  `SessionChoice[]` directly. The wrapper existed only to carry the hidden
  counts, which nothing renders any more.

## [0.6.3]

### Changed

- `/list` and `/help` suppressed the `当前：…` line while on the home session.
  **Reverted in 0.6.4** — the line is the only way to notice you are pointed at
  the wrong session, so it is worth its one line.

## [0.6.2]

### Added

- `/list` shows **running sessions only** by default, since the point of the
  command is to steer something you are working in. `/list all` shows the rest.
- The plugin's own sessions are filtered out of `/list`: the home session
  (reachable via `/back`) and the startup self-test's session.

## [0.6.1]

### Added

- `/list` filters **archived** sessions (read from
  `ctx.workspaceRegistry.archivedSessionIds`) and **subagent** sessions
  (`header.origin === 'subagent'`).
- Detection of **blocked** turns. DSH's `archived-session-gate` rejects every
  step in an archived session, closing the turn as `{ kind: 'blocked' }` with no
  model call — which previously surfaced as an unexplained empty reply. The
  plugin now checks the archive state up front and says what to do.

### Documentation

- Warns that archiving the channel's own session (`wechat-clawbot`) disables the
  channel, and explains how to recover an archived session in the DSH UI
  (session-list **View options → All conversations (show archived) → Unarchive**).

## [0.6.0]

### Added

- **Session control from WeChat.** By default every message goes to the
  channel's own session; these commands point it at another DSH session, then
  send you back:

  | Command | Effect |
  | --- | --- |
  | `/list` | list attachable sessions |
  | `/use <n\|prefix>` | attach to another session |
  | `/back` | return to the channel's own session |
  | `/where` | show the current target |
  | `/help` | usage |

- Only those exact command words are intercepted; every other message
  (including other `/…` text) is forwarded to the agent unchanged.
- Attachments are persisted (`<state dir>/target.json`) and reported at startup.
- `/back` never disposes a session the plugin did not create.

## [0.5.0]

### Fixed

- **`prompt variable "{{cwd}}" has no value`** — the second half of the prompt
  assembly bug. DSH resolves `{{cwd}}` from `agent.session.header.cwd`, which is
  fixed at session creation and **cannot be supplied by `resume`**. Sessions
  created without `meta.cwd` were filed under a literal `_no-cwd` directory and
  could never assemble a prompt. The bridge now always passes a cwd (config →
  workspace registry → `process.cwd()`), and refuses a session whose header has
  no cwd with an actionable message instead of returning empty replies forever.

### Added

- Offline regression tests for cwd resolution and the unusable-session guard.

## [0.4.0]

### Fixed

- **`prompt variable "{{model}}" has no value`** — DSH resolves `{{model}}` and
  `{{provider}}` from `agent.options`, and the web/desktop persona prefix
  contains `{{model}}`. Creating an agent without `agentOptions` failed prompt
  assembly before any model call. The bridge now supplies provider and model,
  falling back to `agentDefaultModel.currentSelection()`.
- Completion detection now keys on the durable `agent/inbox/spliced` event that
  admits the prompt, then the `turn/end` that closes *that* turn. Waiting on
  `whenIdle()` returned immediately on an idle agent, and waiting for "any
  `turn/end`" could catch a stray empty turn.

### Changed

- The startup self-test now **fails** on an empty reply. It previously treated
  "no exception thrown" as success and reported `SELFTEST PASS ... replyChars=0`.

## [0.3.0]

### Changed

- Misdiagnosed the empty-reply failure as a "stray empty turn stealing the
  boundary". The guard added here was not the cause; the real fault was prompt
  assembly (see 0.4.0/0.5.0). Kept in the record as a wrong turn.

## [0.2.0]

### Added

- Startup self-test: one synthetic turn through the real DSH agent path, using a
  separate `<sessionId>-selftest` session so the real conversation is untouched.
  Deliberately left enabled — DSH moves fast and this is the earliest signal
  that an upgrade broke the plugin.

## [0.1.0]

### Added

- Initial implementation: Tencent iLink Bot transport, QR login and account
  binding, long-poll channel loop, outbound sender with chunking and typing
  indicator, CDN media download with AES-128-ECB decryption, durable file
  logger, and the `login` / `status` / `logs` / `logout` CLI.
