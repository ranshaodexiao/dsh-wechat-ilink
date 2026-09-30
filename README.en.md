# dsh-wechat-ilink

Talk to **DeepSeek Harness (DSH)** directly from **WeChat**.

[![npm](https://img.shields.io/npm/v/dsh-wechat-ilink?label=npm)](https://www.npmjs.com/package/dsh-wechat-ilink)

**One command, no configuration file to edit:**

```powershell
dsh plugin --profile desktop add dsh-wechat-ilink
```

A contact named **「微信ClawBot」** appears in your personal WeChat. Send it a
message, and a **single dedicated DSH session** handles it and sends the final
reply back to WeChat.

You can also **steer another DSH session you are working in**, from WeChat (see
`/use`).

- No WeCom (企业微信), no Official Account, no Mini Program
- No public server, domain, or tunnel
- No WeChat client to keep running, no protocol hooks, no patched personal account
- Uses Tencent's official **iLink Bot API** (the protocol behind WeChat ClawBot)

[中文说明](./README.md)

---

## End-to-end verification record (v0.5.0)

Log evidence from a real WeChat message traversing the whole chain (account and
message id redacted):

```
05:54:44.350 INBOUND from=<user>@im.wechat id=<message-id> chars=2
05:54:44.364 created DSH agent for session wechat-clawbot
05:54:53.092 TURN DONE events=15 replyChars=110 empty=false
```

| Metric | Value | Meaning |
| --- | --- | --- |
| `INBOUND` | `chars=2` | WeChat uplink works |
| `created` | fresh session | recreated with a correct cwd |
| elapsed | **8.7 s** | a real model round trip (not a millisecond failure) |
| `replyChars` | **110** | real reply text |
| `empty` | **false** | no longer an empty reply |
| no error after `TURN DONE` | — | the reply was delivered (failures log at error level) |

The startup self-test passed at the same time:

```
SELFTEST PASS ms=4202 events=15 replyChars=146
  reply="Self-test confirmed. Runtime context acknowledged: ..."
```

### Three real messages, all successful

| Time | Input | Result |
| --- | --- | --- |
| 05:54:44 | text, 2 chars | `TURN DONE events=15 replyChars=110 empty=false` |
| 05:55:59 | text, 3 chars | `TURN DONE events=8 replyChars=149 empty=false` |
| 05:57:51 | **1 image** | `downloaded 1/1` → `attached 1 image(s)` → `TURN DONE events=133 replyChars=138 empty=false` |

The image chain (CDN download → AES-128-ECB decrypt → magic-byte sniff →
`ctx.attachments` persist → `image` content block to the model) is therefore
**verified against real WeChat**.


---

## How it works

```
You send a message in WeChat
      │
      ▼
WeChat ClawBot (WeChat → Settings → Plugins)
      │  Tencent iLink Bot API (getupdates long-poll)
      ▼
This plugin (DSH host side)
      │  agent.followup(prompt)  →  await agent.whenIdle()
      ▼
DSH session "wechat-clawbot" (one fixed session)
      │  read the turn's final assistant text
      ▼
plugin sendmessage ──► reply appears in WeChat
```

Design decisions:

| Aspect | Behaviour |
| --- | --- |
| Direction | WeChat → DSH → WeChat only. Typing in the DSH GUI does **not** push to WeChat |
| Long replies | The whole turn runs, then the final text is sent **once** |
| Session | Exactly **one** fixed DSH session receives every WeChat message |
| Requirement | The computer and DSH stay running (inherent to WeChat ClawBot) |

---

## 1. Prerequisites

### Confirm WeChat has the ClawBot plugin

On your phone:

```
WeChat → Me → Settings → Plugins → 微信ClawBot
```

If it is missing, update WeChat to the latest version first.

> Just confirm the entry exists here. **Do not enable it yet** — set up the DSH
> side first.

### Environment

| Component | Requirement |
| --- | --- |
| DSH | **0.2.0-rc.2** |
| Node.js | ≥ 22.13.0 |
| OS | Windows / macOS / Linux (kept awake) |

---

## 2. Install the plugin

### Where things live

| Channel | Contents |
| --- | --- |
| **npm** | **the compiled release** — ships `lib/`, ready to run |
| **GitHub** | **source only** — no `lib/`, for reading and contributing |

**Regular users should install from npm.** The GitHub tree carries no build
output, so installing straight from it hits the build problem described below.

### Users — one command

```powershell
dsh plugin --profile desktop add dsh-wechat-ilink
```

No configuration file to edit by hand. Restart DSH when it finishes.

The command does three things:

1. downloads and installs from npm with **pnpm**;
2. **writes the package name into `dsh.profile.bundles` automatically** — official
   CLI behaviour (`activateNewBundles`, on by default), so you never edit
   `package.json` by hand;
3. checks version compatibility.

> Verified directly: after installing, `dsh.profile.bundles` gains
> `dsh-wechat-ilink`, and `dsh --profile desktop --dump-config` shows the
> plugin's row in the composed tree.
>
> **Prerequisite**: the Desktop profile must already be initialised — open
> DeepSeek Harness Desktop once, **fully quit it** (not minimise), then run the
> command.

### Developers — from source

```powershell
git clone <repo-url> dsh-wechat-ilink
cd dsh-wechat-ilink
npm install        # prepare builds lib/ automatically
npm test           # 138 offline tests

# install into the profile as a local directory (npm run build to pick up edits)
dsh plugin --profile desktop add "link:$PWD"
```

> **Why not install straight from GitHub?** pnpm refuses to run dependency build
> scripts, and this repository deliberately ships no `lib/` (see `.gitignore`) —
> it must be produced by `prepare`. pnpm prints the key to allow; add it under
> `allowBuilds` in `$DSH_PROFILE_DIR\pnpm-workspace.yaml`. Unless you are editing
> the code, just use the npm release instead.

---

## 3. Link WeChat by QR code (required, first time)

The plugin needs a `bot_token` before it can send or receive.

```powershell
dsh-wechat-ilink login
```

If you are running from source, or the bin shim is not on PATH, the equivalent
long form is:

```powershell
node lib/cli.js login
```

A QR code is printed in the terminal:

```
Requesting a WeChat login QR code…

Scan the QR code below with WeChat (WeChat → Scan):

  ███████████████████████████
  █ ▄▄▄▄▄ █▀ █▀▀▄ █▄▀▄ ▄▄▄▄▄ █
  ...

Waiting for confirmation…
```

Scan it, then confirm on your phone:

```
✅ Linked successfully!
   account  xxxxxxxx@im.bot
   wechat   xxxxxxxx@im.wechat
   creds    %USERPROFILE%\.dsh\clawbot
```

Credentials live in `%DSH_HOME%\clawbot\` (default `%USERPROFILE%\.dsh\clawbot\`)
with mode `0600`.

Other commands:

```powershell
dsh-wechat-ilink status   # show binding state
dsh-wechat-ilink logs     # show the runtime log
dsh-wechat-ilink logout   # unbind
```

---

## Drive another DSH session from WeChat

By default every WeChat message goes to `wechat-clawbot`. But you may be
**actively working in another DSH session** and want to check on it or steer it
from your phone. These commands point the channel at that session temporarily,
then send you back:

| Command | Effect |
| --- | --- |
| `/list` | list **running** sessions |
| `/list all` | list every session, including stopped ones (○) |
| `/use <n>` | attach to a session by its latest `/list` number (or an id prefix) |
| `/back` | detach and return to the channel's own session |
| `/where` | show the current target |
| `/help` | usage |

These are intercepted and **never forwarded to the agent**.

### What `/list` shows and hides

**Only running sessions are shown by default** — the point is to steer the thing
you are working in, and a screenful of stopped sessions is noise. They are
summarised in one line:

```
另有 4 个已停止的会话，发 /list all 查看。
```

Three kinds are always filtered out — they go to the log, never to the WeChat
message:

- **Archived sessions** (read from `ctx.workspaceRegistry.archivedSessionIds`)
- **Subagent sessions** (`header.origin === 'subagent'` — internal and short-lived)
- The plugin's own two: **the channel's home session** (`wechat-clawbot`) and the
  **startup self-test's session** (`wechat-clawbot-selftest`)

The last line is always the **current target**, so you never lose track:

```
当前：wechat-clawbot（微信自己的会话）
```

> ⚠️ **Important**: DSH has an `archived-session-gate` — an archived session is
> **refused every step** (`agent/pre-step` returns `reject`, the turn closes as
> `blocked`, and **no model is called**, so there is no output at all).
> Never archive the channel's own session (default `wechat-clawbot`), or WeChat
> stops working. The plugin now detects this and says so instead of returning an
> empty reply.

### Typical flow

```
You: /list
clawbot:
  Running sessions:

  1. ● 开发微信 clawbot 插件对话 dsh
     /use 1  ·  0def7dc3

  Another 4 stopped sessions — send /list all to see them.
  Current: wechat-clawbot (the channel's own session)
```

```
You: /use 1
clawbot: Attached: session-0def7dc3-...
         Title: 开发微信 clawbot 插件对话 dsh
         (running — your messages go straight into it)

You: how far along is it?        ← this enters that session
clawbot: <that session's agent replies>

You: /back
clawbot: Left session-0def7dc3-...
         Back to: wechat-clawbot
```

### How it works

`ctx.agents.get(sessionId)` returns a **live** agent, so the plugin can call
`followup()` on it — exactly equivalent to typing in that session in the DSH UI.

- **It does not interrupt work**: the message queues for the *next* turn; the
  in-flight step is untouched.
- **Visible in the DSH UI**: your instruction and the agent's reply both appear
  in that session.
- **Isolated queues**: each session has its own turn queue, so waiting on the
  WeChat side cannot collide with UI activity.
- **The attachment is persisted**: after a DSH restart the channel stays on that
  session, and the startup log says so explicitly.
- **`/back` never kills the other session**: the plugin only disposes agents it
  created itself.

---

## 4. Start using it

1. Restart DSH (or reload the plugin in DSH).
2. On your phone: WeChat → Settings → Plugins → enable **微信ClawBot**.
3. The **「微信ClawBot」** conversation appears in your chat list.
4. Send it something, for example:

```
What is the newest PDF in my Downloads folder?
```

5. WeChat shows "typing…", and the result arrives when the turn finishes.

### The DSH session

Every WeChat message goes to the same session:

```
wechat-clawbot
```

It is visible in the DSH GUI session list with the full transcript.

---

## 5. Configuration

Edit `$env:DSH_PROFILE_DIR\cordis.patch.yml` and find the `id: wechat-clawbot` entry.

```yaml
- id: wechat-clawbot
  name: 'dsh-wechat-ilink'
  config:
    enabled: true
```

> ⚠️ `config` is replaced **wholesale**, never deep-merged. Restate every key you
> want to keep.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `sessionId` | `wechat-clawbot` | The fixed DSH session id |
| `cwd` | inherited | Working directory for the session |
| `provider` / `model` | DSH default | Pin a model for WeChat turns |
| `reasoningEffort` | inherited | Reasoning effort |
| `allowedUserIds` | `[]` | Extra allowed WeChat user ids; **empty = only the account that scanned** |
| `typing` | `true` | Show "typing…" in WeChat |
| `typingKeepaliveMs` | `5000` | Typing keepalive interval for long turns |
| `maxMessageChars` | `2000` | Max characters per WeChat message; longer replies are split |
| `acceptImages` | `true` | Accept inbound images |
| `turnTimeoutMs` | `300000` | Per-turn timeout (5 minutes) |
| `logLevel` | `info` | `silent` / `error` / `info` / `debug` |

### Pin a model for WeChat only

```yaml
- id: wechat-clawbot
  name: 'dsh-wechat-ilink'
  config:
    enabled: true
    sessionId: 'wechat-clawbot'
    provider: deepseek-account
    model: deepseek-flash
    logLevel: info
```

---

## 6. Security defaults

- **Only you by default.** Only the WeChat account that scanned the QR code can
  drive the agent. Messages from anyone else are ignored.
- **Tokens are never logged.** Logs show `abcd***yz` style redaction.
- **Credentials stay local.** `~/.dsh/clawbot/`, mode `0600`.
- **Replies always carry `context_token`.** That is iLink's conversation routing
  anchor; the plugin never fabricates one and never replies to the wrong chat.

---

## 7. Supported message types

| Type | Support | Notes |
| --- | --- | --- |
| Text | ✅ | Sent as the prompt |
| Image | ✅ | Downloaded and decrypted per protocol; needs a vision-capable model |
| Quoted message | ✅ | Quoted content is appended as `[引用] …` |
| Voice | ⚠️ | Uses WeChat's own transcript only; without one it asks for text |
| File / Video | ❌ | Explicitly reported as unhandled, never silently dropped |

Images require `ctx.attachments` (the standard DSH attachment service). If an
image cannot be stored, the turn still runs with a visible note instead of failing.

---

## 8. Troubleshooting

### Nothing happens when I message the bot

1. Make sure the computer is awake and DSH is running.
2. Look for `wechat-clawbot` lines in the DSH log.
3. Confirm the WeChat ClawBot plugin is enabled on your phone.

### Token expired / session invalid (errcode -14)

The WeChat-side login lapsed. Re-scan:

```powershell
dsh-wechat-ilink login      # or: node lib/cli.js login
```

On `-14` the plugin pauses polling and clears its cursor automatically; it
resumes after re-binding.

### `BridgeUnavailableError: could not resolve createUserMessage`

**Fixed in 0.1.0.** If you see this, you are running the pre-fix build — run
`npm run build` again and restart DSH.

Cause: DSH's `@deepseek-ai/dsh-llm` is packed inside the application, while the
plugin is installed into the profile via `link:`. A bare `import` therefore
resolves against the **plugin's own** `node_modules` and fails with
`ERR_MODULE_NOT_FOUND`. First-party plugins can use a bare import only because
they live inside DSH's own module graph.

Fix: the plugin carries an equivalent message factory. DSH's `createUserMessage`
is literally `deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))`,
and `brandString` is an identity function (brands exist only at compile time), so
the local implementation is behaviourally identical — verified field by field
against the real `createUserMessage` extracted from the DSH asar. If that package
ever becomes resolvable, the plugin automatically switches to the canonical one.

### WeChat shows "(模型没有返回文本内容)" — no text returned

**Fixed in 0.1.2.** If you see this, you are running the pre-fix build — run
`npm run build` again and restart DSH.

Cause: a **race**. `agent.whenIdle()` awaits the loop's current `activityDone`
promise. When the agent is **already idle** at the moment `followup()` is called,
that promise is the previous, already-resolved one, so `whenIdle()` returns
**immediately** — before this turn's `assistant/message` has been appended.
Reading the log then yields an empty reply.

Fix: the bridge no longer relies on a bare `whenIdle()`. It waits for this turn's
**durable completion signal** — a `turn/end` event appended after the turn
boundary. `whenIdle()` is kept only as a secondary signal (for a turn that closes
without `turn/end`), with a bounded timeout so a turn can never hang the channel.

Text extraction was also aligned with DSH's canonical rule
(`@deepseek-ai/dsh-subagent/assistant-output`): select the last assistant message
with **non-empty content**, then fall back to accumulated streamed text. Note
"non-empty content", not "non-empty text". Verified case by case against the real
`finalAssistantOutput` extracted from the DSH asar.

### `SessionAlreadyExistsError: session "wechat-clawbot" already exists`

**Fixed in 0.1.3.** If you see this, you are running the pre-fix build — run
`npm run build` again and restart DSH.

Cause: the fixed session id (`wechat-clawbot`) is **durable** — the first run
persists it into DSH's session store. On the next start the plugin called
`ctx.agents.create()` again, and `create` necessarily throws
`SessionAlreadyExistsError` (from `@deepseek-ai/dsh-session-persistence`) for an
identity that already exists in the backend. The old fallback only re-checked
`agents.get()` — the *in-memory* live agent — which is empty after a restart, so
it could not recover and surfaced the error instead.

Fix (mirroring the first-party `dsh-headless` three-step):

1. `agents.get(id)` returns a live agent → reuse it;
2. otherwise probe durable storage with `ctx.sessionQuery.observeSession(id)` →
   if present, `agents.resume({ resumeSessionId })`, which **keeps the history**;
3. otherwise → `agents.create()`.

`SessionAlreadyExistsError` is additionally caught **by name** rather than by
class identity (the class lives in a package a profile-installed plugin cannot
import), covering the race where the session is created between the probe and
the create call.

### `cannot get property "sessionQuery" without inject`

**Fixed in 0.1.4.** If you see this, you are running the pre-fix build — run
`npm run build` again and restart DSH.

Cause: a Cordis context is a **Proxy** and property reads go through the service
resolver, so **reading a service that was not declared in `inject` throws**. The
`sessionQuery` probe added in the previous fix used `ctx.sessionQuery` while the
`inject` list still only had `agents` and `sessions`.

Fix:

- `agents`, `sessions` and `sessionQuery` are now declared in `inject` (required
  dependencies);
- `attachments`, which is genuinely optional, is read through
  `ctx.get('attachments')` instead. `ctx.get()` returns `undefined` for an
  absent service rather than throwing, so the channel still loads in
  environments without it — and it is deliberately NOT in `inject`.

> Note: `ctx.get('x')` is the correct accessor for an optional service; `ctx.x`
> is only safe for services declared in `inject`.

### `SELFTEST FAIL (empty reply)`, or an empty reply in WeChat

**Fixed in 0.3.0.** This was the subtlest bug of the set.

DSH's agent loop opens a turn the moment the driver is woken, and closes it
immediately when the inbox claim comes back empty:

```js
// dsh-agent-loop/lib/index.js
if (phase.step === 0 && decision.messages.length === 0) {
  turnEnds = { kind: 'completed' }
  return false          // no step, no model call
}
```

The previous implementation waited for **any** `turn/end`, so it frequently
settled on that empty turn while your prompt was still queued for the *next*
one. The turn then "completed" with nothing in the log and an empty reply.

Evidence from your own machine
(`~/.dsh/storages/session_projcache/sessions/wechat-clawbot-selftest.json`):

```json
"turnOutline": { "turns": [{ "turn": 1, "prompt": "", "response": "" }] }
"titleInput":  { "count": 0, ... }                       ← not one user message
"sessionStats": { "turns": 1, "steps": 1, "llmMs": 0 }   ← no model call at all
```

Fix: stop waiting for "any turn/end" and wait for durable proof instead —

1. a `user/message` event whose `id` **equals the id of the message we sent**
   (proving the inbox claimed it and admitted it into the log);
2. then the `turn/end` that follows it.

The stray empty turn is now correctly skipped.

The self-test's **false PASS** was fixed too: it previously reported success
merely because nothing threw, so `SELFTEST PASS ... replyChars=0` passed. An
**empty reply is now always a FAIL**, with the reason logged.

> Diagnostic tip: `sessionStats.llmMs: 0` is proof that no model call happened.

### Check whether the binding is still valid

```powershell
dsh-wechat-ilink status
```

### Read the runtime log (start here when diagnosing)

The plugin writes **everything** to a durable file, because it runs inside the
DSH process where its stderr is not observable — without a log, a live failure
can only be guessed at:

```powershell
dsh-wechat-ilink logs 200
```

Log file: `%DSH_HOME%\clawbot\channel.log` (default `%USERPROFILE%\.dsh\clawbot\channel.log`).

Key lines:

| Log line | Meaning |
| --- | --- |
| `=== wechat-clawbot v0.2.0 loaded ... ===` | Plugin loaded, and which version |
| `using the bound account ...` | WeChat credentials found |
| `channel listener started` | Long-poll running |
| `INBOUND from=... id=... chars=...` | **A WeChat message arrived** (uplink works) |
| `created/resumed DSH agent for session ...` | DSH session ready |
| `TURN DONE events=... replyChars=...` | The agent turn finished |
| `SELFTEST PASS` / `SELFTEST FAIL` | See below |
| `turn failed: ...` | Failure, **with a full stack trace** |

### Startup self-test (`selfTestOnStart`)

Enabled by default in the plugin's `cordis.patch.yml`:

```yaml
selfTestOnStart: true
selfTestDelayMs: 5000
```

Five seconds after DSH starts, the plugin runs one synthetic turn in a
**separate session** (`wechat-clawbot-selftest`, so your real conversation is
untouched) and logs the outcome:

```
SELFTEST start session=wechat-clawbot-selftest
SELFTEST PASS ms=1234 events=4 replyChars=12 reply="..."
```

On failure it writes `SELFTEST FAIL (agent path)` plus a full stack trace.

**Why it exists**: the WeChat transport is already proven (you received a reply
from the plugin), but the **DSH agent step** was never exercised live. The
self-test tells you whether that link works the moment DSH restarts, without
waiting for a message.

Cost: one extra model call per start. **Set it to `false` once verified:**

```yaml
selfTestOnStart: false
```

### Uninstall completely

```powershell
cd $env:DSH_PROFILE_DIR
pnpm remove dsh-wechat-ilink
```

Then remove `dsh-wechat-ilink` from `dsh.profile.bundles`.

---

## 9. Known limitations

1. **Online only while the computer and DSH are running.** That is WeChat
   ClawBot's design, not a plugin limitation.
2. **One WeChat account per DSH installation.**
3. **No GUI-to-WeChat push.** iLink requires a `context_token` on every reply,
   and it only arrives with an inbound message; there is no reliable proactive
   push API.
4. **No group chats.**
5. **WeChat may redeliver a message.** The plugin deduplicates by `message_id`,
   so a turn never runs twice.

---

## 10. Development

```powershell
npm install
npm run build       # TypeScript -> lib/
npm test            # 138 offline tests, no network
```

Tests are entirely offline: `fetch` is replaced by an in-process fake iLink
server. Coverage includes protocol headers, long-poll timeout, `-14` session
expiry, CDN AES-128-ECB round-trips (both `aes_key` encodings), image format
sniffing, the QR login state machine, message normalisation, chunking,
credential storage, log redaction and rotation, the DSH bridge (including
`{{model}}` / `{{cwd}}` regressions and `blocked` detection), the session-control
commands, image content blocks, and the CLI.

```
src/
  index.ts            plugin entry (Cordis: name / inject / Config / apply)
  schema.ts           Config validation (Standard Schema; schemastery optional)
  config.ts           config resolution and defaults
  bridge.ts           WeChat conversation <-> DSH session bridge
  control.ts          /list /use /back /where /help session control
  channel.ts          long-poll loop, dedup, backoff, cursor
  outbound.ts         reply sending, chunking, typing indicator
  log.ts              levelled logging, token redaction, rotation
  cli.ts              login / status / logs / logout
  ilink/
    transport.ts      iLink HTTP client (headers, long-poll, error codes)
    login.ts          QR login state machine
    accounts.ts       credential and cursor persistence
    cdn.ts            CDN upload/download + AES-128-ECB
    message.ts        inbound normalisation, outbound chunking
    types.ts          protocol types
test/
  protocol.test.mjs   protocol layer
  bridge.test.mjs     DSH bridge (cwd / blocked / image regressions)
  control.test.mjs    session-control commands
  image.test.mjs      image pipeline
  log.test.mjs        logging and redaction
  cli.test.mjs        CLI
  helpers.mjs         fake iLink server

cordis.patch.yml      bundle layer: inserts the plugin into the profile's entries
CHANGELOG.md          version history
NOTICE                third-party protocol reference
LICENSE               MIT
```

### A note on "verified"

The tests in `test/` are entirely offline, and **they cannot prove the plugin
works against a real DSH**. Five of this project's eight bugs were found on a
real DSH while the whole suite was green (`{{model}}`, `{{cwd}}`, `inject`, the
turn boundary, and `blocked`).

The real check is the **startup self-test**: it runs one synthetic turn through
the full provider / model / cwd prompt assembly and an actual model call, and
writes the outcome to `%DSH_HOME%\clawbot\channel.log`. After any DSH upgrade,
look there first.

```
SELFTEST PASS ms=4202 events=15 replyChars=146
SELFTEST FAIL (turn error) ... reason={"kind":"error","error":{...}}
```

### Portability

The source contains **no absolute paths** and nothing tied to a development
machine. Installing needs only `git clone` + `npm install` (`prepare` builds it).
The state directory follows `DSH_HOME`, falling back to `USERPROFILE` / `HOME`.

Verified empirically with a clean clone at a different path and a different
`DSH_HOME`: install, build, all 138 tests, and a real Cordis load all pass.

---

## License

MIT. The protocol implementation references Tencent's MIT-licensed
`@tencent-weixin/openclaw-weixin`; see [NOTICE](./NOTICE).
