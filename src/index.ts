/**
 * WeChat ClawBot channel for DeepSeek Harness 0.2.0-rc.2.
 *
 * Cordis plugin contract (verified against DSH 0.2.0-rc.2):
 *   - exports `name`, `inject`, `Config`, `apply` (+ a default object)
 *   - `inject` keeps the plugin pending until `agents` and `sessions` exist
 *   - `ctx.effect(() => disposer)` ties background work to the plugin fiber
 *
 * Runtime shape: a long-poll loop on the Tencent iLink API maps each allowed
 * WeChat sender onto one DSH session; replies are sent back over iLink.
 */

import fs from 'node:fs'
import path from 'node:path'

import { AccountStore, resolveStateDir } from './ilink/accounts.js'
import { ILinkClient, DEFAULT_BASE_URL } from './ilink/transport.js'
import { QrLoginManager } from './ilink/login.js'
import { ChannelListener, type InboundEvent } from './channel.js'
import { OutboundSender } from './outbound.js'
import { CdnClient, sniffImageMediaType } from './ilink/cdn.js'
import { DshBridge, readOptionalService, resolveUserMessageFactory, type DshContextLike, type PromptImage } from './bridge.js'
import {
  SessionControl,
  isInternalSession,
  type SessionChoice,
} from './control.js'
import { Logger, redactToken } from './log.js'
import { isSenderAllowed, resolveConfig, type ChannelConfig } from './config.js'
import { Config } from './schema.js'

/** How many sessions `/list` shows. */
const SESSION_LIST_LIMIT = 12

export const name = 'wechat-clawbot'

/**
 * Plugin version, mirrored from package.json.
 * Kept as a literal so the built bundle needs no JSON import at runtime; the
 * startup banner logs it, which is how a loaded build is identified.
 */
export const PLUGIN_VERSION = '0.6.5'

/**
 * Services this plugin requires before it activates.
 *
 * Cordis proxies context property access and throws
 * `cannot get property "X" without inject` for anything not listed here, so
 * every service read as a property MUST be declared:
 *   - `agents`    – obtain/create/resume the conversation's agent
 *   - `sessions`  – flush the durable session log after a turn
 *   - `sessionQuery` – probe whether the fixed session id already exists, so a
 *     restart RESUMES the session instead of failing with
 *     SessionAlreadyExistsError
 *
 * Services that are genuinely optional (`attachments`) are read through
 * `ctx.get(name)` instead and are deliberately NOT listed here, so the channel
 * still loads where they are absent.
 */
export const inject = ['agents', 'sessions', 'sessionQuery']

/** Re-exported so DSH validates the bundle row's `config` automatically. */
export { Config }

/** Config type as consumed by `apply`. */
export type { ChannelConfig }

/** Live channel status, exposed for diagnostics. */
export interface ChannelStatus {
  state: string
  accountId?: string
  boundUserId?: string
  sessionId: string
  agentLive: boolean
  lastError?: string
  logTail: string[]
}

/** Public handle returned by `apply`, useful for tests and tooling. */
export interface ChannelRuntime {
  status(): ChannelStatus
  start(): Promise<void>
  stop(): Promise<void>
  /** Begin a QR login and return the scannable URL. */
  beginLogin(): Promise<{ ticketId: string; qrcodeUrl: string }>
  /** Poll one step of an in-flight login. */
  pollLogin(ticketId: string, verifyCode?: string): Promise<{ status: string; accountId?: string }>
  /** Send a message to the bound WeChat user proactively. */
  notify(text: string): Promise<boolean>
  config: ChannelConfig
}

/** Resolve the canonical `createUserMessage`, preferring DSH's own export. */
async function resolveCreateUserMessage(): Promise<((input: unknown) => unknown) | undefined> {
  return resolveUserMessageFactory()
}

/**
 * Cordis plugin entry.
 *
 * @param ctx   the plugin's Cordis context (provides `agents`, `sessions`).
 * @param rawConfig validated config from the bundle row.
 */
export function apply(ctx: unknown, rawConfig?: Partial<ChannelConfig>): ChannelRuntime {
  const config = resolveConfig(rawConfig)

  // A plugin running inside DSH has no readable stderr, so every line also goes
  // to a durable log next to the credentials. This is the only way a live
  // failure can be diagnosed after the fact.
  const logFile = path.join(resolveStateDir(), 'channel.log')
  const logger = new Logger(config.logLevel, 'wechat-clawbot', undefined, logFile)
  const log = (level: 'info' | 'error' | 'debug', message: string) => logger[level](message)

  const store = new AccountStore(resolveStateDir())
  const client = new ILinkClient({
    baseUrl: DEFAULT_BASE_URL,
    channelVersion: '2.4.9',
    botAgent: 'DSH-ClawBot/0.1.0',
    appId: 'bot',
  })
  const sender = new OutboundSender({
    client,
    maxMessageChars: config.maxMessageChars,
    log: (m) => log('debug', m),
  })
  const login = new QrLoginManager({ store, client })
  const cdn = new CdnClient()

  const dshCtx = ctx as DshContextLike

  // Track the bound account and the conversation's context token.
  let accountId: string | undefined
  let boundUserId: string | undefined
  let lastContextToken: string | undefined
  let lastError: string | undefined

  const sessionId = config.sessionId?.trim() || 'wechat-clawbot'

  const bridgeAgentOptions: Record<string, unknown> = {
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  }

  /** Canonical DSH factory once resolved; shared with the startup self-test. */
  let createUserMessageFactory: ((input: unknown) => unknown) | undefined

  const bridge = new DshBridge({
    ctx: dshCtx,
    sessionId,
    ...(config.cwd ? { cwd: config.cwd } : {}),
    agentOptions: bridgeAgentOptions,
    log,
  })

  // ---------------------------------------------------------------------------
  // Session control: let WeChat drive ANOTHER DSH session, then return.
  // One bridge per target session, so each keeps its own turn queue.
  // ---------------------------------------------------------------------------
  const bridges = new Map<string, DshBridge>([[sessionId, bridge]])

  function bridgeFor(id: string): DshBridge {
    let existing = bridges.get(id)
    if (!existing) {
      existing = new DshBridge({
        ctx: dshCtx,
        sessionId: id,
        ...(config.cwd ? { cwd: config.cwd } : {}),
        agentOptions: bridgeAgentOptions,
        log,
      })
      if (createUserMessageFactory) existing.setMessageFactory(createUserMessageFactory)
      bridges.set(id, existing)
    }
    return existing
  }

  /** Target file so the attachment survives a DSH restart. */
  const targetFile = path.join(store.dir, 'target.json')

  function loadTarget(): string | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf-8')) as { sessionId?: unknown }
      return typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
        ? parsed.sessionId.trim()
        : undefined
    } catch {
      return undefined
    }
  }

  function persistTarget(id: string | undefined): void {
    try {
      fs.mkdirSync(store.dir, { recursive: true })
      if (id === undefined) fs.rmSync(targetFile, { force: true })
      else fs.writeFileSync(targetFile, JSON.stringify({ sessionId: id }, null, 2), 'utf-8')
    } catch (err) {
      log('error', `could not persist session target: ${String(err)}`)
    }
  }

  /**
   * Is this session currently archived?
   *
   * DSH's archived-session-gate rejects any proposed step in an archived
   * session, so the turn would end as `blocked` with no model call and no
   * output. Knowing this up front turns a silent empty reply into an
   * actionable message.
   */
  function isArchived(id: string): boolean {
    const registry = readOptionalService<{ archivedSessionIds?: readonly unknown[] }>(
      dshCtx,
      'workspaceRegistry',
    )
    try {
      return (registry?.archivedSessionIds ?? []).some((v) => String(v) === id)
    } catch {
      return false
    }
  }

  /**
   * Enumerate attachable sessions, live first.
   *
   * Filtered out here, because they are noise in a list meant for "attach to the
   * session I am working on":
   *   - ARCHIVED sessions, from the registry's global archive set;
   *   - SUBAGENT sessions (`header.origin === 'subagent'`), internal and
   *     short-lived;
   *   - the plugin's own sessions (home + self-test).
   * The counts go to the log, not to WeChat.
   */
  async function gatherSessions(): Promise<SessionChoice[]> {
    const agentsSvc = readOptionalService<{
      list?: () => readonly { id?: string; session?: unknown }[]
    }>(dshCtx, 'agents')
    const titleSvc = readOptionalService<{
      get?: (session: unknown) => { title?: string } | undefined
    }>(dshCtx, 'sessionTitle')
    const querySvc = readOptionalService<{
      listSessions?: (signal?: AbortSignal) => Promise<
        readonly {
          header?: { id?: string; cwd?: string; createdAt?: number; origin?: string }
          live?: boolean
        }[]
      >
    }>(dshCtx, 'sessionQuery')
    const registry = readOptionalService<{ archivedSessionIds?: readonly unknown[] }>(
      dshCtx,
      'workspaceRegistry',
    )

    let archived: Set<string>
    try {
      archived = new Set((registry?.archivedSessionIds ?? []).map((v) => String(v)))
    } catch {
      archived = new Set()
    }
    log('debug', `session control: registry reports ${archived.size} archived session(s)`)

    let hiddenArchived = 0
    let hiddenSubagent = 0

    // Sessions that are this plugin's own plumbing rather than work the user
    // might steer (shared definition, see control.ts).
    const isInternal = (id: string): boolean => isInternalSession(id, sessionId)

    // Live agents first: those are the ones you can command right now.
    const live = new Map<string, SessionChoice>()
    try {
      for (const agent of agentsSvc?.list?.() ?? []) {
        const id = agent?.id
        if (typeof id !== 'string' || id.length === 0) continue
        if (isInternal(id)) continue
        if (archived.has(id)) {
          hiddenArchived += 1
          continue
        }
        // A live Session lets us read its human title.
        let session: unknown
        try {
          session = readOptionalService<{ get?: (id: string) => { session?: unknown } }>(
            dshCtx,
            'agents',
          )?.get?.(id)?.session
        } catch {
          session = undefined
        }
        let title: string | undefined
        try {
          title = titleSvc?.get?.(session)?.title
        } catch {
          title = undefined
        }
        live.set(id, { id, live: true, ...(title ? { title } : {}) })
      }
    } catch (err) {
      log('debug', `could not list live agents: ${String(err)}`)
    }

    const rest: SessionChoice[] = []
    try {
      const records = (await querySvc?.listSessions?.()) ?? []
      for (const record of records) {
        const id = record?.header?.id
        if (typeof id !== 'string' || id.length === 0) continue
        if (live.has(id)) continue
        if (isInternal(id)) continue
        if (archived.has(id)) {
          hiddenArchived += 1
          continue
        }
        if (record.header?.origin === 'subagent') {
          hiddenSubagent += 1
          continue
        }
        rest.push({
          id,
          live: record.live === true,
          ...(record.header?.cwd ? { cwd: record.header.cwd } : {}),
          ...(typeof record.header?.createdAt === 'number'
            ? { createdAt: record.header.createdAt }
            : {}),
        })
      }
    } catch (err) {
      log('debug', `could not list persisted sessions: ${String(err)}`)
    }

    const sessions = [...live.values(), ...rest]
    log(
      'debug',
      `session control: ${sessions.length} attachable session(s); ` +
        `filtered ${hiddenArchived} archived, ${hiddenSubagent} subagent`,
    )
    return sessions.slice(0, SESSION_LIST_LIMIT)
  }

  const control = new SessionControl(
    {
      homeSessionId: sessionId,
      listSessions: gatherSessions,
      hasSession: async (id: string) => {
        if (dshCtx.agents.get(id) !== undefined) return true
        const query = readOptionalService<{
          observeSession?: (id: string) => Promise<unknown>
        }>(dshCtx, 'sessionQuery')
        try {
          const observed = await query?.observeSession?.(id)
          return observed !== undefined && observed !== null
        } catch {
          return false
        }
      },
      persistTarget,
      log,
    },
    loadTarget(),
  )

  // Prefer DSH's canonical factory when reachable. When it is not (the usual
  // case for a profile-installed plugin), the bridge keeps its local
  // equivalent, which is behaviourally identical.
  void resolveCreateUserMessage().then((factory) => {
    if (factory) {
      createUserMessageFactory = factory
      bridge.setMessageFactory(factory)
      log('debug', 'using the canonical createUserMessage from @deepseek-ai/dsh-llm')
    } else {
      log('info', 'using the built-in user-message factory (@deepseek-ai/dsh-llm not resolvable)')
    }
  })

  /** Load the most recently bound account, if any. */
  function loadBoundAccount(): void {
    const ids = store.listAccountIds()
    if (ids.length === 0) return
    const id = ids[ids.length - 1] as string
    const data = store.load(id)
    if (!data?.token) return
    accountId = id
    boundUserId = data.userId?.trim() || undefined
    client.setToken(data.token)
    if (data.baseUrl) client.setBaseUrl(data.baseUrl)
    log('info', `using bound account ${id} (user ${boundUserId ?? 'unknown'})`)
  }

  /** Handle one allowed inbound WeChat message end-to-end. */
  async function handleInbound(event: InboundEvent): Promise<void> {
    if (!isSenderAllowed(config, { fromUserId: event.fromUserId, boundUserId })) {
      log('info', `ignoring message from unauthorized user ${event.fromUserId}`)
      return
    }

    lastContextToken = event.contextToken
    const prompt = event.normalized.text

    log(
      'info',
      `INBOUND from=${event.fromUserId} id=${event.messageId} chars=${prompt.length} ` +
        `images=${event.normalized.images.length} voice=${Boolean(event.normalized.voiceTranscript)}`,
    )
    log('debug', `INBOUND text=${JSON.stringify(prompt.slice(0, 500))}`)

    // Control commands (/list, /use, /back, /where, /help) are answered here
    // and never reach the agent. Anything else — including other `/…` text —
    // is forwarded unchanged. Commands carry no image, so this check is safe
    // even when the client sends both.
    if (event.normalized.images.length === 0) {
      const controlReply = await control.handle(prompt)
      if (controlReply !== undefined) {
        log('info', `session control command handled: ${prompt.split(/\s+/)[0]}`)
        await sender.sendText({
          toUserId: event.fromUserId,
          contextToken: event.contextToken,
          text: controlReply,
        })
        return
      }
    }

    // Download and decrypt any inbound images so they can ride along with the prompt.
    const images: PromptImage[] = []
    if (event.normalized.images.length > 0) {
      if (!config.acceptImages) {
        log('info', `${event.normalized.images.length} image(s) ignored (acceptImages=false)`)
      } else {
        let index = 0
        for (const ref of event.normalized.images) {
          index += 1
          try {
            const downloaded = await cdn.download({
              ...(ref.encryptQueryParam ? { encryptQueryParam: ref.encryptQueryParam } : {}),
              ...(ref.fullUrl ? { fullUrl: ref.fullUrl } : {}),
              ...(ref.aesKeyHex ? { aesKeyHex: ref.aesKeyHex } : {}),
            })
            const mediaType = sniffImageMediaType(downloaded)
            if (!mediaType) {
              log('error', `image ${index}: unrecognized format, skipped`)
              continue
            }
            images.push({ data: downloaded, mediaType, name: `wechat-${index}` })
          } catch (err) {
            log('error', `image ${index} download failed: ${String(err)}`)
          }
        }
        log('info', `downloaded ${images.length}/${event.normalized.images.length} image(s)`)
      }
    }

    if (!prompt.trim() && images.length === 0) {
      log('debug', 'nothing to send to the agent (no usable content)')
      return
    }

    log('info', `inbound ${prompt.length} chars + ${images.length} image(s) from ${event.fromUserId}`)

    const stopTyping = config.typing
      ? sender.startTypingKeepalive({
          userId: event.fromUserId,
          contextToken: event.contextToken,
          intervalMs: config.typingKeepaliveMs,
        })
      : () => {}

    // An archived target would be rejected by DSH's archived-session-gate with
    // no model call at all, so say so instead of running a doomed turn.
    const preTarget = control.activeSessionId
    if (isArchived(preTarget)) {
      log('error', `refusing to run: session ${preTarget} is archived`)
      await sender.sendText({
        toUserId: event.fromUserId,
        contextToken: event.contextToken,
        text:
          `⚠️ 会话「${preTarget}」已被归档，DSH 会拒绝在其中执行任务。\n` +
          (preTarget === sessionId
            ? '这是微信自己的会话 —— 请在 DSH 界面里把它取消归档，否则微信这边无法工作。'
            : '请在 DSH 里取消归档，或发 /back 回到微信自己的会话。'),
      })
      return
    }

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`turn exceeded ${config.turnTimeoutMs}ms`)),
          config.turnTimeoutMs,
        )
        timer.unref?.()
      })

      // An image-only message still needs a prompt for the model.
      const effectivePrompt = prompt.trim() || '请看一下这张图片。'
      // Route to whichever session is currently attached (default: our own).
      const targetSessionId = control.activeSessionId
      const result = await Promise.race([
        bridgeFor(targetSessionId).prompt(effectivePrompt, images),
        timeout,
      ])

      // Never answer with a bare "no text": say WHY the turn produced none.
      const reply = result.text.trim()
        ? result.text
        : result.blocked
          ? isArchived(targetSessionId)
            ? `⚠️ 会话「${targetSessionId}」已被归档，DSH 会拒绝在其中执行任务。\n` +
              '请在 DSH 界面里取消归档（或对该会话点"取消归档"）后重试。'
            : `⚠️ 会话「${targetSessionId}」这次没有执行（turn blocked）。` +
              '可能是会话被归档，或该回合被拒绝。'
          : result.errored
            ? `（回合失败：${JSON.stringify(result.stopReason).slice(0, 300)}）`
            : '(模型没有返回文本内容)'

      log(
        'info',
        `TURN DONE session=${targetSessionId} events=${result.eventCount} ` +
          `replyChars=${result.text.length} empty=${result.text.trim().length === 0}`,
      )
      await sender.sendText({
        toUserId: event.fromUserId,
        contextToken: event.contextToken,
        text: reply,
      })
    } catch (err) {
      lastError = String(err)
      // Full stack to the durable log: a live failure must be diagnosable
      // without reproducing it.
      logger.errorDetail('turn failed', err)
      try {
        await sender.sendText({
          toUserId: event.fromUserId,
          contextToken: event.contextToken,
          text: `（执行出错：${String(err).slice(0, 300)}）`,
        })
        log('info', 'error reply delivered to WeChat')
      } catch (sendErr) {
        logger.errorDetail('could not report the failure to WeChat', sendErr)
      }
    } finally {
      stopTyping()
    }
  }

  const listener = new ChannelListener({
    client,
    store,
    accountId: accountId ?? sessionId,
    onInbound: handleInbound,
    log,
  })

  // -------------------------------------------------------------------------
  // Lifecycle: everything below is tied to the plugin fiber via ctx.effect.
  // -------------------------------------------------------------------------
  const cordisCtx = ctx as { effect?: (fn: () => (() => void) | void, label?: string) => unknown }

  const runtime: ChannelRuntime = {
    config,

    status(): ChannelStatus {
      return {
        state: listener.state,
        ...(accountId ? { accountId } : {}),
        ...(boundUserId ? { boundUserId } : {}),
        sessionId,
        agentLive: bridge.isLive(),
        ...(lastError ? { lastError } : {}),
        logTail: logger.tail(30),
      }
    },

    async start(): Promise<void> {
      loadBoundAccount()
      if (!accountId) {
        log('error', 'no bound WeChat account; run beginLogin() and scan the QR code first')
        return
      }
      listener.start()
    },

    async stop(): Promise<void> {
      await listener.stop()
    },

    async beginLogin() {
      const ticket = await login.start()
      log('info', `QR login started; scan ${ticket.qrcodeUrl}`)
      return { ticketId: ticket.id, qrcodeUrl: ticket.qrcodeUrl }
    },

    async pollLogin(ticketId: string, verifyCode?: string) {
      const outcome = await login.poll(
        verifyCode ? { ticketId, verifyCode } : { ticketId },
      )
      if (outcome.status === 'confirmed') {
        loadBoundAccount()
        listener.start()
      }
      return {
        status: outcome.status,
        ...(outcome.accountId ? { accountId: outcome.accountId } : {}),
      }
    },

    async notify(text: string): Promise<boolean> {
      if (!boundUserId || !lastContextToken) {
        log('error', 'cannot notify: no conversation context yet (send a message first)')
        return false
      }
      await sender.sendText({ toUserId: boundUserId, contextToken: lastContextToken, text })
      return true
    },
  }

  const bootAndStart = () => {
    loadBoundAccount()
    if (!config.enabled) {
      log('info', 'channel disabled by config')
      return
    }
    if (!accountId) {
      log('info', 'channel idle: no WeChat account bound yet (run beginLogin)')
      return
    }
    log('info', `channel starting for ${accountId} (token ${redactToken(store.load(accountId)?.token)})`)
    listener.start()
  }

  /**
   * Exercise the DSH agent path once, without needing an inbound message.
   *
   * The WeChat transport is verifiable from the outside; the agent bridge is
   * not. Running one synthetic turn at startup turns "unknown until you send a
   * message" into a logged fact, and captures the stack trace of any failure.
   *
   * It uses a SEPARATE session id so the real conversation is untouched, and it
   * never throws: a self-test failure must not stop the channel.
   */
  const runSelfTest = async (): Promise<void> => {
    if (!config.selfTestOnStart) return

    const selfTestSessionId = `${sessionId}-selftest`
    const selfTestBridge = new DshBridge({
      ctx: dshCtx,
      sessionId: selfTestSessionId,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      agentOptions: bridgeAgentOptions,
      log,
    })
    if (createUserMessageFactory) selfTestBridge.setMessageFactory(createUserMessageFactory)

    log('info', `SELFTEST start session=${selfTestSessionId}`)
    try {
      const started = Date.now()
      const result = await selfTestBridge.prompt('Self-test. Reply with a short confirmation.')
      const ms = Date.now() - started
      const summary =
        `session=${selfTestSessionId} ms=${ms} events=${result.eventCount} ` +
        `replyChars=${result.text.length} reply=${JSON.stringify(result.text.slice(0, 200))}`

      // A turn that produces NO text is NOT a pass. Without this check an empty
      // reply (a prompt that was never admitted, or a turn that closed without
      // an LLM call) would be reported as success.
      if (result.errored) {
        // The turn ended with a durable error. Surface it verbatim: this is
        // exactly the signal that used to hide behind an empty reply.
        log(
          'error',
          `SELFTEST FAIL (turn error) ${summary} reason=${JSON.stringify(result.stopReason)}`,
        )
      } else if (result.text.trim().length === 0) {
        log(
          'error',
          `SELFTEST FAIL (empty reply) ${summary} — the agent turn produced no text. ` +
            'Check that a provider and model are configured for this channel.',
        )
      } else {
        log('info', `SELFTEST PASS ${summary}`)
      }
    } catch (err) {
      // Logged with a stack so the cause is identifiable after the fact.
      logger.errorDetail('SELFTEST FAIL (agent path)', err)
    } finally {
      try {
        await selfTestBridge.dispose()
      } catch {
        // Disposal failure must not surface.
      }
    }
  }

  // Startup banner: marks a fresh load in the durable log, so a version under
  // test can be identified without guessing.
  log(
    'info',
    `=== wechat-clawbot v${PLUGIN_VERSION} loaded (session=${sessionId}, ` +
      `enabled=${config.enabled}, logLevel=${config.logLevel}, log=${logFile}) ===`,
  )
  // Which session WeChat is currently pointed at, so a restored attachment is
  // visible immediately rather than surprising the user later.
  if (!control.isHome) {
    log(
      'info',
      `session control: WeChat messages go to "${control.activeSessionId}" ` +
        `(send /back in WeChat to return to "${sessionId}")`,
    )
  }

  if (cordisCtx.effect) {
    cordisCtx.effect(() => {
      // Defer startup so module resolution and service wiring settle first.
      const timer = setTimeout(bootAndStart, 0)
      timer.unref?.()

      // Delayed so DSH has finished wiring services before the agent runs.
      const selfTestTimer = config.selfTestOnStart
        ? setTimeout(() => void runSelfTest(), config.selfTestDelayMs)
        : undefined
      selfTestTimer?.unref?.()

      return () => {
        clearTimeout(timer)
        if (selfTestTimer !== undefined) clearTimeout(selfTestTimer)
        void listener.stop()
        void bridge.dispose()
      }
    }, 'wechat-clawbot channel')
  } else {
    // Plain-Node fallback (tests / CLI): start immediately.
    setTimeout(bootAndStart, 0).unref?.()
    if (config.selfTestOnStart) {
      setTimeout(() => void runSelfTest(), config.selfTestDelayMs).unref?.()
    }
  }

  log('info', `wechat-clawbot loaded (session=${sessionId}, state dir=${store.dir})`)
  return runtime
}

export default { name, inject, Config, apply }
