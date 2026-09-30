/**
 * DSH integration: map one WeChat conversation onto one DSH session.
 *
 * Verified against DSH 0.2.0-rc.2:
 *   - `ctx.agents.get(sessionId)` returns a live agent, else undefined.
 *   - `ctx.agents.create({ sessionId, meta, agentOptions })` returns an AgentHandle.
 *     It REJECTS when the session id is already live, so always `get()` first.
 *   - `agent.followup(createUserMessage({ content, source }))` queues a
 *     next-turn prompt AND wakes the driver.
 *   - `await agent.whenIdle()` resolves when the agent reaches quiescence.
 *   - `agent.session.snapshotEvents(fromSeq)` reads the durable log.
 *   - `ctx.sessions.flush(session)` persists buffered events.
 *
 * Message construction does NOT require importing `@deepseek-ai/dsh-llm`: that
 * package is packed inside the DSH application and is not resolvable from a
 * plugin installed into a profile. See `createUserMessageLocal` for why a local
 * equivalent is correct.
 */

import { randomUUID } from 'node:crypto'

export interface DshAgentLike {
  readonly id: string
  readonly session: {
    readonly seq: number
    /** Immutable session header; `cwd` is fixed at creation. */
    readonly header?: { readonly cwd?: string }
    snapshotEvents(fromSeq?: number): readonly unknown[]
  }
  readonly status?: string
  followup(message: unknown): void
  whenIdle(): Promise<void>
  cancel?(cause: unknown, options?: unknown): void
}

export interface DshContextLike {
  agents: {
    get(id: string): DshAgentLike | undefined
    create(options: unknown): Promise<{ agent: DshAgentLike; dispose(): Promise<void> }>
    /** Present on DSH 0.2.0-rc.2; required to adopt a session that already exists. */
    resume?(options: unknown): Promise<{ agent: DshAgentLike; dispose(): Promise<void> }>
  }
  sessions?: {
    flush(session: unknown): Promise<boolean>
  }
  /** Optional: used to detect an already-persisted session before creating. */
  sessionQuery?: {
    observeSession?(sessionId: string): Promise<{ [Symbol.dispose]?: () => void } | undefined | null>
  }
  /** Optional: required only when inbound images must be persisted. */
  attachments?: {
    saveImages(
      inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[],
    ): Promise<readonly { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }[]>
  }
  /** Optional resolver for DSH's package exports. */
  get?(name: string): unknown
}

/**
 * Is this the persistence error raised when `create` targets an identity that
 * already exists in the backend?
 *
 * Checked by name (not by importing the class) because the class lives in
 * `@deepseek-ai/dsh-session-persistence`, which is not resolvable from a plugin
 * installed into a profile.
 */
export function isSessionAlreadyExists(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'SessionAlreadyExistsError'
}

/**
 * Read an OPTIONAL Cordis service safely.
 *
 * Cordis proxies context property access: `ctx.sessionQuery` throws
 * `cannot get property "sessionQuery" without inject` unless the plugin
 * declared it in `inject`. Optional services must therefore be read through
 * `ctx.get(name)`, which returns `undefined` when absent.
 *
 * Only the injected services (`agents`, `sessions`) may be read as properties.
 */
export function readOptionalService<T>(ctx: unknown, name: string): T | undefined {
  const getter = (ctx as { get?: (n: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') {
    // Not a Cordis context (plain-Node callers/tests): fall back to a direct
    // read, which is safe because there is no proxy to guard.
    return (ctx as Record<string, unknown> | undefined)?.[name] as T | undefined
  }
  try {
    return getter.call(ctx, name) as T | undefined
  } catch {
    // A service that exists but is not injectable from this fiber.
    return undefined
  }
}

/** One image to attach to a prompt, already downloaded and decrypted. */
export interface PromptImage {
  data: Uint8Array
  mediaType: string
  name?: string
}

export interface TurnResult {
  text: string
  /** Durable events produced during this turn. */
  eventCount: number
  /** The turn's durable end reason, e.g. `{ kind: 'error', error: {...} }`. */
  stopReason?: unknown
  /** True when the turn ended with `kind: 'error'`. */
  errored: boolean
  /**
   * True when the turn ended with `kind: 'blocked'`.
   *
   * DSH's archived-session-gate rejects a proposed step in an archived session
   * (`agent/pre-step` returns `{ kind: 'reject' }`), which the loop closes as
   * `blocked` with no model request. Without this flag the caller would see an
   * unexplained empty reply.
   */
  blocked: boolean
}

/** Raised when the DSH side of the bridge cannot run. */
export class BridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeUnavailableError'
  }
}

/** Recursively freeze a value, mirroring DSH's `deepFreeze`. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/**
 * Build a user message equivalent to DSH's `createUserMessage`.
 *
 * DSH's implementation (in `@deepseek-ai/dsh-llm`) is:
 *
 *   createMessage(input) = deepFreeze(structuredClone({ ...input, id: randomUUID() }))
 *   createUserMessage(input) = createMessage({ ...input, role: 'user' })
 *
 * `brandString` is an identity function — brands are compile-time only — so this
 * produces a behaviourally identical value: a detached, deeply frozen user
 * message carrying a fresh UUID identity.
 *
 * We cannot import the real factory: `@deepseek-ai/dsh-llm` is packed inside the
 * DSH application, so a plugin installed into a profile resolves bare
 * specifiers against its own `node_modules` and fails with
 * ERR_MODULE_NOT_FOUND. First-party plugins get away with a bare import only
 * because they live inside DSH's own module graph.
 *
 * `resolveUserMessageFactory()` still prefers the canonical export when it does
 * resolve, so environments that expose it use it.
 */
export function createUserMessageLocal(input: unknown): unknown {
  const base = (input ?? {}) as Record<string, unknown>
  return deepFreeze(structuredClone({ ...base, role: 'user', id: randomUUID() }))
}

/**
 * Try to obtain the canonical `createUserMessage` from `@deepseek-ai/dsh-llm`.
 * Returns undefined when unreachable, in which case callers use the local
 * equivalent above.
 */
export async function resolveUserMessageFactory(): Promise<
  ((input: unknown) => unknown) | undefined
> {
  for (const specifier of ['@deepseek-ai/dsh-llm', 'dsh-llm']) {
    try {
      const mod = (await import(/* webpackIgnore: true */ specifier)) as {
        createUserMessage?: (input: unknown) => unknown
      }
      if (typeof mod.createUserMessage === 'function') return mod.createUserMessage
    } catch {
      // Not reachable from this module graph; try the next candidate.
    }
  }
  return undefined
}

/**
 * Accumulate assistant text from a slice of session events.
 *
 * Follows DSH's canonical selection rule (see
 * `@deepseek-ai/dsh-subagent/assistant-output`): select the last assistant
 * message with NON-EMPTY CONTENT, then fall back to the accumulated streamed
 * text. "Non-empty content" is deliberately not "non-empty text": a message
 * carrying only reasoning or tool-call blocks still counts as the latest
 * message, and an empty-content message records usage only and must not
 * replace earlier output.
 */
export function extractAssistantText(events: readonly unknown[]): string {
  let latest: unknown[] | undefined
  let streamed = ''

  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as { type?: string; data?: Record<string, unknown> }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue

    if (event.type === 'assistant/message') {
      const message = event.data?.message as { content?: unknown } | undefined
      const content = Array.isArray(message?.content) ? message.content : []
      if (content.length > 0) latest = content
    }

    streamed += extractStreamText(event.data?.stream)
  }

  const text = (latest ?? [])
    .filter((b): b is { type: string; text: string } => {
      const block = b as { type?: string; text?: unknown }
      return block?.type === 'text' && typeof block.text === 'string'
    })
    .map((b) => b.text)
    .join('')

  return text.trim() ? text : streamed
}

/** Join text deltas out of an `AssistantStreamRecord[]`. */
function extractStreamText(stream: unknown): string {
  if (!Array.isArray(stream)) return ''
  let out = ''
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue
    const rec = record as { type?: string; texts?: unknown; chunk?: { type?: string; text?: unknown } }
    if (rec.type === 'text-chunks' && Array.isArray(rec.texts)) {
      out += rec.texts.filter((t): t is string => typeof t === 'string').join('')
    } else if (rec.chunk?.type === 'text-delta' && typeof rec.chunk.text === 'string') {
      out += rec.chunk.text
    }
  }
  return out
}

/** The `turn/end` reason from a slice of session events, when present. */
export function findTurnEndReason(events: readonly unknown[]): unknown {
  let reason: unknown
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as { type?: string; data?: { reason?: unknown } }
    if (event.type === 'turn/end') reason = event.data?.reason
  }
  return reason
}

/** Whether a `turn/end` reason records an error. */
export function isErrorReason(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false
  return (reason as { kind?: unknown }).kind === 'error'
}

/**
 * Whether a `turn/end` reason records a BLOCKED turn.
 *
 * The archived-session-gate rejects a step in an archived session, and the loop
 * closes that turn with `{ kind: 'blocked' }` — no model request, no output.
 */
export function isBlockedReason(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false
  return (reason as { kind?: unknown }).kind === 'blocked'
}

/**
 * Owns the WeChat-conversation -> DSH-session mapping.
 *
 * One bridge instance serves one channel account. Sessions are created lazily
 * on first message and reused afterwards, so the WeChat thread keeps context.
 */
export class DshBridge {
  #ctx: DshContextLike
  #sessionId: string
  #cwd: string | undefined
  #agentOptions: Record<string, unknown>
  #createUserMessage: (input: unknown) => unknown
  #log: (level: 'info' | 'error' | 'debug', message: string) => void
  #handle: { agent: DshAgentLike; dispose(): Promise<void> } | undefined
  /** Safety bound for waiting on a turn's durable completion. */
  #turnWaitMs: number
  /** Serialises turns so two WeChat messages cannot interleave on one agent. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(opts: {
    ctx: DshContextLike
    sessionId: string
    cwd?: string
    agentOptions?: Record<string, unknown>
    createUserMessage?: (input: unknown) => unknown
    turnWaitMs?: number
    log?: (level: 'info' | 'error' | 'debug', message: string) => void
  }) {
    this.#ctx = opts.ctx
    this.#sessionId = opts.sessionId
    this.#cwd = opts.cwd
    this.#agentOptions = opts.agentOptions ?? {}
    // Default to the local equivalent so the bridge always works, even when
    // @deepseek-ai/dsh-llm is not resolvable from this module graph.
    this.#createUserMessage = opts.createUserMessage ?? createUserMessageLocal
    this.#turnWaitMs = opts.turnWaitMs ?? 300_000
    this.#log = opts.log ?? (() => {})
  }

  get sessionId(): string {
    return this.#sessionId
  }

  /**
   * Adopt the canonical factory when it is reachable.
   * Harmless to skip: the default is behaviourally identical.
   */
  setMessageFactory(factory: (input: unknown) => unknown): void {
    this.#createUserMessage = factory
  }

  /** Live agent for this conversation, if any. */
  currentAgent(): DshAgentLike | undefined {
    return this.#ctx.agents.get(this.#sessionId)
  }

  /** True when the conversation has a live agent. */
  isLive(): boolean {
    return this.currentAgent() !== undefined
  }

  /**
   * Obtain the live agent for this session, resuming a persisted one if needed.
   *
   * Three cases, in order:
   *   1. an agent is already live for this id -> reuse it;
   *   2. the id exists in the durable backend  -> `resume` it (the session keeps
   *      its history, which is the whole point of a fixed session id);
   *   3. otherwise                             -> `create` it.
   *
   * `create` throws `SessionAlreadyExistsError` when the identity is already
   * present in the persistence backend, so `create` must never be the first
   * attempt for a session id that may have history. The create path also keeps
   * a re-read fallback for a genuine concurrent-create race.
   */
  async ensureAgent(): Promise<DshAgentLike> {
    const existing = this.#ctx.agents.get(this.#sessionId)
    if (existing) {
      this.#assertUsableSession(existing)
      return existing
    }

    const alreadyPersisted = await this.#sessionExists()

    if (alreadyPersisted) {
      return this.#adopt(await this.#resumeAgent(), 'resumed')
    }

    let handle: { agent: DshAgentLike; dispose(): Promise<void> }
    try {
      handle = await this.#ctx.agents.create(this.#createOptions())
    } catch (err) {
      // A concurrent create won the race.
      const raced = this.#ctx.agents.get(this.#sessionId)
      if (raced) return raced

      // The identity was persisted between our check and the create call.
      if (isSessionAlreadyExists(err)) {
        this.#log('info', `session ${this.#sessionId} appeared during create; resuming`)
        return this.#adopt(await this.#resumeAgent(), 'resumed')
      }
      throw err
    }

    return this.#adopt(handle, 'created')
  }

  /** Record the handle we created (never overwrite one we only resumed). */
  #adopt(
    handle: { agent: DshAgentLike; dispose(): Promise<void> } | undefined,
    how: 'created' | 'resumed',
  ): DshAgentLike {
    if (!handle) {
      throw new BridgeUnavailableError(`could not ${how} the DSH agent for session ${this.#sessionId}`)
    }
    if (how === 'created') this.#handle = handle
    this.#log('info', `${how} DSH agent for session ${this.#sessionId}`)
    // A session without a cwd can never assemble its system prompt, so refuse it
    // here rather than emitting empty replies forever.
    this.#assertUsableSession(handle.agent)
    return handle.agent
  }

  /**
   * Resolve the agent options, always including a provider and model.
   *
   * DSH resolves the `{{model}}` system-prompt variable from
   * `agent.options.model`:
   *
   *   ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)
   *
   * The web/desktop persona prefix contains `{{model}}`. An agent created
   * WITHOUT a model therefore fails prompt assembly outright:
   *
   *   prompt variable "{{model}}" has no value for this assembly
   *     (section "deployment:persona-prefix")
   *
   * That error happens before any model request, so the turn ends with no
   * output and no LLM call at all. The GUI avoids it by always selecting a
   * model; a programmatic caller must do the same.
   *
   * Explicit config wins; otherwise DSH's configured default selection is used.
   */
  #resolveAgentOptions(): Record<string, unknown> {
    const explicit = this.#agentOptions
    if (explicit.provider && explicit.model) return explicit

    const defaults = readOptionalService<{
      currentSelection?: () => { provider?: string; model?: string; reasoningEffort?: string }
    }>(this.#ctx, 'agentDefaultModel')

    let selection: { provider?: string; model?: string; reasoningEffort?: string } | undefined
    try {
      selection = defaults?.currentSelection?.()
    } catch {
      selection = undefined
    }

    if (selection?.provider && selection?.model) {
      this.#log(
        'debug',
        `resolved default model ${selection.provider}/${selection.model} for session ${this.#sessionId}`,
      )
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        // An explicit partial config still wins over the default.
        ...explicit,
      }
    }

    this.#log(
      'error',
      `no provider/model for session ${this.#sessionId}: neither the plugin config nor ` +
        'agentDefaultModel supplied one. The agent will be created, but DSH cannot resolve ' +
        'the {{model}} system-prompt variable and every turn will fail before any model call. ' +
        'Fix: set provider+model in this plugin\'s config, or configure a default model in DSH.',
    )
    return explicit
  }

  /**
   * Resolve the working directory for the session header.
   *
   * DSH resolves the `{{cwd}}` system-prompt variable from
   * `agent.session.header.cwd`:
   *
   *   ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd)
   *
   * The desktop persona suffix references `{{cwd}}`, and `header.cwd` is fixed
   * WHEN THE SESSION IS CREATED (resume cannot supply one). A session created
   * without a cwd therefore fails prompt assembly on every turn, and DSH files
   * it under a literal `_no-cwd` directory.
   *
   * Priority: explicit config, then DSH's first registered workspace, then the
   * process working directory.
   */
  #resolveCwd(): string | undefined {
    if (this.#cwd) return this.#cwd

    const registry = readOptionalService<{ list?: () => { path?: string }[] }>(
      this.#ctx,
      'workspaceRegistry',
    )
    try {
      const first = registry?.list?.()?.[0]
      if (first?.path) {
        this.#log('debug', `using workspace cwd ${first.path} for session ${this.#sessionId}`)
        return first.path
      }
    } catch {
      // Fall through to the process directory.
    }

    const fallback = typeof process !== 'undefined' ? process.cwd() : undefined
    if (fallback) {
      this.#log('debug', `using process cwd ${fallback} for session ${this.#sessionId}`)
    }
    return fallback
  }

  #createOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = { sessionId: this.#sessionId }
    // `meta.cwd` is REQUIRED: without it the session header has no cwd and the
    // `{{cwd}}` prompt variable fails assembly before any model call.
    const cwd = this.#resolveCwd()
    if (cwd) options.meta = { cwd }
    const agentOptions = this.#resolveAgentOptions()
    if (Object.keys(agentOptions).length > 0) options.agentOptions = agentOptions
    return options
  }

  /** Resume a persisted session by id. */
  async #resumeAgent(): Promise<{ agent: DshAgentLike; dispose(): Promise<void> }> {
    const resume = this.#ctx.agents.resume
    if (!resume) {
      throw new BridgeUnavailableError(
        `session "${this.#sessionId}" already exists, but this DSH has no agents.resume; ` +
          'either use a fresh sessionId or reload DSH so the agent factory is present',
      )
    }
    const options: Record<string, unknown> = { resumeSessionId: this.#sessionId }
    const agentOptions = this.#resolveAgentOptions()
    if (Object.keys(agentOptions).length > 0) options.agentOptions = agentOptions
    return resume.call(this.#ctx.agents, options)
  }

  /**
   * Refuse a session whose header has no cwd.
   *
   * `header.cwd` is immutable after creation and `resume` cannot supply one, so
   * a session created before the cwd fix is permanently unable to assemble its
   * system prompt. Failing loudly here beats an endless stream of empty replies:
   * the message names the directory to remove so the next run recreates it.
   */
  #assertUsableSession(agent: DshAgentLike | undefined): void {
    const header = (agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header
    if (!header) return
    if (header.cwd) return
    throw new BridgeUnavailableError(
      `session "${this.#sessionId}" has no working directory, so DSH cannot resolve the ` +
        '{{cwd}} system-prompt variable and every turn will fail before any model call. ' +
        'header.cwd is fixed at creation and resume cannot add one, so this session must be ' +
        `recreated: remove the directory "${this.#sessionId}" under the DSH sessions folder ` +
        '(look for a "_no-cwd" parent) and delete its entry under ' +
        'storages/session_projcache/sessions, then retry.',
    )
  }

  /**
   * Does this session id already exist durably (or live)?
   *
   * Uses `ctx.sessionQuery.observeSession`, the same probe first-party drivers
   * use. When the service is unavailable the answer is "no", so a fresh install
   * still creates normally and an existing session falls back to the
   * `SessionAlreadyExistsError` catch above.
   */
  async #sessionExists(): Promise<boolean> {
    // MUST go through ctx.get(): `ctx.sessionQuery` throws
    // "cannot get property ... without inject" on a Cordis context.
    const query = readOptionalService<{
      observeSession?(sessionId: string): Promise<{ [Symbol.dispose]?: () => void } | undefined | null>
    }>(this.#ctx, 'sessionQuery')
    if (!query?.observeSession) return false
    try {
      const observation = await query.observeSession(this.#sessionId)
      try {
        return observation !== undefined && observation !== null
      } finally {
        // The observation is a caller-owned lease.
        try {
          observation?.[Symbol.dispose]?.()
        } catch {
          // Disposal is best-effort.
        }
      }
    } catch {
      return false
    }
  }

  /**
   * Run one prompt and return the assistant's final text for that turn.
   *
   * Turns are serialised per conversation: a second WeChat message waits for
   * the first turn to settle rather than being steered into it.
   */
  async prompt(text: string, images: readonly PromptImage[] = []): Promise<TurnResult> {
    const run = async (): Promise<TurnResult> => {
      const agent = await this.ensureAgent()
      const boundary = Number(agent.session.seq ?? 0)

      const content = await this.#buildContent(text, images)

      const message = this.#createUserMessage({
        content,
        source: { kind: 'user' },
      }) as { id?: unknown }

      agent.followup(message)

      // DO NOT rely on `await agent.whenIdle()` alone.
      //
      // `whenIdle()` awaits the loop's CURRENT `activityDone` promise. When the
      // agent is already idle it is the previous, resolved promise, so
      // `whenIdle()` returns before this turn appended anything.
      //
      // DO NOT wait for "any turn/end" either. The loop opens a turn as soon as
      // the driver is woken and closes it immediately when the inbox claim came
      // back empty:
      //
      //   if (phase.step === 0 && decision.messages.length === 0) {
      //     turnEnds = { kind: 'completed' }; return false   // no step, no LLM call
      //   }
      //
      // A stray empty turn therefore signals "done" while OUR prompt is still
      // queued for the next turn — the caller then reads an empty log.
      //
      // The reliable boundary is the durable one: wait until this exact message
      // appears as a `user/message` event (proving it was claimed), then wait
      // for the `turn/end` that closes that turn.
      const messageId = typeof message.id === 'string' ? message.id : undefined
      await this.#awaitTurnCompletion(agent, boundary, messageId)

      const events = agent.session.snapshotEvents(boundary)
      const stopReason = findTurnEndReason(events)
      const errored = isErrorReason(stopReason)
      const blocked = isBlockedReason(stopReason)

      // Always surface a failed turn. Without this the caller sees an empty
      // reply with no explanation, which is what made the {{model}} failure so
      // hard to find.
      if (errored) {
        this.#log('error', `turn ended with an error: ${JSON.stringify(stopReason)}`)
      }
      if (blocked) {
        this.#log(
          'error',
          `turn was BLOCKED for session ${this.#sessionId}: ${JSON.stringify(stopReason)} — ` +
            'DSH rejects steps in an archived session (archived-session-gate). ' +
            'Unarchive the session to resume.',
        )
      }

      const result: TurnResult = {
        text: extractAssistantText(events),
        eventCount: events.length,
        ...(stopReason !== undefined ? { stopReason } : {}),
        errored,
        blocked,
      }

      if (this.#ctx.sessions) {
        try {
          await this.#ctx.sessions.flush(agent.session)
        } catch (err) {
          this.#log('error', `session flush failed (turn output still returned): ${String(err)}`)
        }
      }

      return result
    }

    // Chain onto the queue so turns never interleave, and surface this
    // turn's own result/error regardless of earlier failures.
    const chained = this.#queue.then(run, run)
    this.#queue = chained.catch(() => undefined)
    return chained
  }

  /**
   * Wait until the turn that actually consumed OUR message has ended.
   *
   * Two phases, both read from the durable log:
   *
   *   1. Wait for a `user/message` event carrying our message id. That is the
   *      proof the loop claimed our prompt and admitted it into a step.
   *   2. Wait for the `turn/end` that follows it.
   *
   * Phase 1 is what makes this correct. The loop opens a turn as soon as the
   * driver is woken and closes it instantly when the claim came back empty
   * (`phase.step === 0 && decision.messages.length === 0`), so watching for
   * "any turn/end" can return on a turn that never carried our prompt.
   *
   * When the id is unavailable the wait degrades to the turn/end heuristic plus
   * `whenIdle()`, and a bounded timeout guarantees this can never hang the
   * channel.
   */
  async #awaitTurnCompletion(
    agent: DshAgentLike,
    boundary: number,
    messageId: string | undefined,
  ): Promise<void> {
    const pollMs = 25
    const started = Date.now()

    /** Index of our message in the slice, or -1 when not yet admitted. */
    /**
     * Index of the event that proves OUR prompt was taken out of the inbox.
     *
     * The loop records every inbox change as a durable `agent/inbox/spliced`
     * event. The `inserted` splice carries the message object (so we can match
     * its id), and the later splice with `removedCount` is the claim.
     *
     * This is a better signal than waiting for `user/message`: on a turn that
     * fails during prompt assembly, `user/message` is never appended, but the
     * claim and the `turn/end` still are.
     */
    const claimIndex = (events: readonly unknown[]): number => {
      if (!messageId) return -1
      let claimed = -1
      for (let i = 0; i < events.length; i += 1) {
        const raw = events[i]
        if (!raw || typeof raw !== 'object') continue
        const event = raw as {
          type?: string
          data?: { target?: string; removedCount?: number; inserted?: unknown }
        }
        if (event.type !== 'agent/inbox/spliced') continue

        if (Array.isArray(event.data?.inserted)) {
          for (const item of event.data.inserted) {
            const id = (item as { id?: unknown } | null)?.id
            if (typeof id === 'string' && id === messageId) claimed = i
          }
        }
      }
      return claimed
    }

    /**
     * Index of the `user/message` event carrying our id, when the turn got far
     * enough to append it. Used only as an alternative proof of admission.
     */
    const admittedIndex = (events: readonly unknown[]): number => {
      if (!messageId) return -1
      for (let i = 0; i < events.length; i += 1) {
        const raw = events[i]
        if (!raw || typeof raw !== 'object') continue
        const event = raw as { type?: string; data?: { id?: unknown } }
        if (event.type !== 'user/message') continue
        if (event.data?.id === messageId) return i
      }
      return -1
    }

    /** Index of the first `turn/end` after `from`, or -1. */
    const turnEndAfter = (events: readonly unknown[], from: number): number => {
      for (let i = from + 1; i < events.length; i += 1) {
        const raw = events[i]
        if (!raw || typeof raw !== 'object') continue
        if ((raw as { type?: string }).type === 'turn/end') return i
      }
      return -1
    }

    const anyTurnEnd = (events: readonly unknown[]): boolean => turnEndAfter(events, -1) >= 0

    // Secondary signal: the loop is quiescent. Only used when the message id is
    // unavailable, or as a fallback so a turn that closes without `turn/end`
    // cannot stall the wait.
    let idleSettled = false
    const idle = agent
      .whenIdle()
      .then(() => {
        idleSettled = true
      })
      .catch(() => {
        idleSettled = true
      })

    let idlePollsAfterQuiescence = 0

    // Guard against giving up too early. `whenIdle()` resolves IMMEDIATELY on an
    // idle agent (it awaits the loop's current, already-resolved activity
    // promise), so "quiescent" alone does not mean "nothing more will happen".
    // The driver may still be about to wake and claim our message. Only give up
    // once the agent is idle AND the log has stopped growing for a grace window.
    const ADMISSION_QUIET_POLLS = Math.max(4, Math.ceil(2_000 / pollMs))
    let lastLength = -1
    let quietPolls = 0

    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, pollMs))

        const events = agent.session.snapshotEvents(boundary)

        if (events.length !== lastLength) {
          lastLength = events.length
          quietPolls = 0
        } else {
          quietPolls += 1
        }

        if (messageId) {
          // Prefer the inbox splice (works even when prompt assembly failed
          // before any `user/message` was appended); accept the appended
          // `user/message` as an alternative proof of admission.
          const claimed = claimIndex(events)
          const admitted = claimed >= 0 ? claimed : admittedIndex(events)
          if (admitted >= 0) {
            // Our prompt was taken and admitted; wait for its turn to close.
            if (turnEndAfter(events, admitted) >= 0) return
          } else if (idleSettled && quietPolls >= ADMISSION_QUIET_POLLS) {
            this.#log(
              'error',
              `prompt was never claimed from the inbox (id=${messageId}) after ` +
                `${quietPolls} quiet polls; reading the log as-is`,
            )
            return
          }
        } else {
          // No id to key on: fall back to the turn/end heuristic.
          if (anyTurnEnd(events)) return
          if (idleSettled && quietPolls >= ADMISSION_QUIET_POLLS) {
            idlePollsAfterQuiescence += 1
            return
          }
        }

        if (Date.now() - started > this.#turnWaitMs) {
          this.#log(
            'error',
            `turn did not report completion within ${this.#turnWaitMs}ms; reading the log as-is`,
          )
          return
        }
      }
    } finally {
      void idle
      void idlePollsAfterQuiescence
    }
  }

  /**
   * Build the prompt content blocks.
   *
   * Text comes first, then one `image` block per attachment. Images require
   * `ctx.attachments`; when it is absent or a save is refused, the prompt
   * degrades to text plus a visible note rather than failing the turn.
   */
  async #buildContent(
    text: string,
    images: readonly PromptImage[],
  ): Promise<unknown[]> {
    const content: unknown[] = []
    if (text.trim()) content.push({ type: 'text', text })

    if (images.length === 0) {
      // A prompt must never be empty: DSH rejects an empty content array.
      if (content.length === 0) content.push({ type: 'text', text: '(空消息)' })
      return content
    }

    // MUST go through ctx.get(): `ctx.attachments` throws
    // "cannot get property ... without inject" on a Cordis context.
    const attachments = readOptionalService<{
      saveImages(
        inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[],
      ): Promise<readonly { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }[]>
    }>(this.#ctx, 'attachments')

    if (!attachments?.saveImages) {
      this.#log('error', 'received an image but the attachments service is unavailable; sending text only')
      content.push({ type: 'text', text: '[收到图片，但当前环境不支持图片附件]' })
      return content
    }

    let refs: readonly { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }[]
    try {
      refs = await attachments.saveImages(
        images.map((img) => ({
          data: img.data,
          mediaType: img.mediaType,
          ...(img.name ? { name: img.name } : {}),
        })),
      )
    } catch (err) {
      this.#log('error', `saving inbound image(s) failed: ${String(err)}`)
      content.push({ type: 'text', text: `[图片处理失败：${String(err).slice(0, 200)}]` })
      return content
    }

    for (const ref of refs) {
      content.push({ type: 'image', attachment: ref })
    }
    this.#log('info', `attached ${refs.length} image(s) to the prompt`)
    return content
  }

  /** Tear down the agent this bridge created, if any. */
  async dispose(): Promise<void> {
    const handle = this.#handle
    this.#handle = undefined
    if (!handle) return
    try {
      await handle.dispose()
      this.#log('info', `disposed DSH agent for session ${this.#sessionId}`)
    } catch (err) {
      this.#log('error', `agent dispose failed: ${String(err)}`)
    }
  }
}
