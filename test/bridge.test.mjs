/**
 * Bridge tests: WeChat conversation -> fixed DSH session, one-shot reply.
 *
 * Uses a fake DSH context/agent that mirrors the verified 0.2.0-rc.2 shape
 * (`agents.get`, `agents.create`, `agent.followup`, `agent.whenIdle`,
 * `agent.session.seq`, `agent.session.snapshotEvents`, `sessions.flush`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BridgeUnavailableError,
  DshBridge,
  createUserMessageLocal,
  extractAssistantText,
  findTurnEndReason,
  isBlockedReason,
  isErrorReason,
  isSessionAlreadyExists,
  readOptionalService,
} from '../lib/bridge.js'

// ---------------------------------------------------------------------------
// readOptionalService: the Cordis inject contract
// ---------------------------------------------------------------------------

test('readOptionalService uses ctx.get() when available', () => {
  // A Cordis-like context: property access throws, get() works.
  const services = { attachments: { saveImages: async () => [] } }
  let propertyReads = 0
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'get') return (name) => services[name]
        propertyReads += 1
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    },
  )

  const found = readOptionalService(ctx, 'attachments')
  assert.equal(typeof found?.saveImages, 'function')
  // Crucially, it must NOT have touched the throwing property accessor.
  assert.equal(propertyReads, 0, 'must go through ctx.get(), not property access')
})

test('readOptionalService returns undefined for an absent service', () => {
  const ctx = { get: (name) => (name === 'attachments' ? { saveImages: async () => [] } : undefined) }
  assert.equal(readOptionalService(ctx, 'sessionQuery'), undefined)
})

test('readOptionalService tolerates a throwing ctx.get()', () => {
  const ctx = {
    get() {
      throw new Error('cannot get required service "x" in inactive context')
    },
  }
  assert.equal(readOptionalService(ctx, 'x'), undefined)
})

test('readOptionalService falls back to a property read for plain objects', () => {
  const plain = { sessionQuery: { observeSession: async () => null } }
  assert.equal(typeof readOptionalService(plain, 'sessionQuery')?.observeSession, 'function')
  assert.equal(readOptionalService(plain, 'missing'), undefined)
  assert.equal(readOptionalService(undefined, 'anything'), undefined)
})

test('DshBridge works when the context is a throwing Cordis-like proxy', async () => {
  // Regression for: cannot get property "sessionQuery" without inject
  const { ctx: inner, calls } = makeFakeDsh({ reply: 'proxied ok' })

  // Expose only the INJECTED services as properties; everything else throws,
  // exactly like Cordis. `get()` resolves anything that was provided.
  const provided = {
    agents: inner.agents,
    sessions: inner.sessions,
  }
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'get') return (name) => provided[name]
        if (prop in provided) return provided[prop]
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    },
  )

  const bridge = new DshBridge({ ctx, sessionId: 'wechat-clawbot' })
  const result = await bridge.prompt('hello')

  assert.equal(result.text, 'proxied ok')
  assert.equal(calls.create, 1)
})

/** Build an assistant/message event carrying text blocks. */
function assistantEvent(turn, text) {
  return {
    type: 'assistant/message',
    seq: turn,
    data: {
      turn,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      stream: [],
    },
  }
}

/**
 * Fake DSH runtime.
 *
 * Models the two behaviours that matter for correctness:
 *   1. `followup()` appends the turn's events ASYNCHRONOUSLY (the real driver
 *      works on a later tick), so reading the log immediately after followup()
 *      sees nothing.
 *   2. `whenIdle()` resolves the CURRENT activity promise. When the agent is
 *      already idle it resolves immediately — the race that produced an empty
 *      reply in the field.
 *
 * @param {{ reply?: string | ((turn: number) => string), available?: boolean, turnDelayMs?: number }} [opts]
 */
function makeFakeDsh(opts = {}) {
  const events = []
  const calls = { followup: [], whenIdle: 0, create: 0, resume: 0, flush: 0, get: 0, disposed: 0 }
  let turn = 0
  let activity = Promise.resolve()

  const delay = opts.turnDelayMs ?? 10

  const session = {
    get seq() {
      return events.length
    },
    snapshotEvents(fromSeq = 0) {
      return events.slice(fromSeq)
    },
  }

  const agent = {
    id: 'wechat-clawbot',
    session,
    options: {},
    followup(message) {
      turn += 1
      const thisTurn = turn
      calls.followup.push(message)

      // The turn runs asynchronously, exactly like the real loop.
      activity = (async () => {
        await new Promise((r) => setTimeout(r, delay))

        // Reproduce the field failure: the loop opens a turn and closes it
        // immediately when the inbox claim came back empty
        // (`phase.step === 0 && decision.messages.length === 0`).
        // A stray empty turn must NOT be mistaken for our prompt's turn.
        if (opts.spuriousEmptyTurn) {
          events.push({ type: 'turn/start', seq: events.length, data: { turn: thisTurn } })
          events.push({
            type: 'turn/end',
            seq: events.length,
            data: { turn: thisTurn, reason: { kind: 'completed' } },
          })
        }

        // The prompt was never admitted: the real loop opens the turn, finds an
        // empty claim, and closes it with NO step and NO model call.
        if (opts.omitUserMessage) {
          events.push({ type: 'turn/start', seq: events.length, data: { turn: thisTurn } })
          events.push({
            type: 'turn/end',
            seq: events.length,
            data: { turn: thisTurn, reason: { kind: 'completed' } },
          })
          return
        }

        events.push({ type: 'turn/start', seq: events.length, data: { turn: thisTurn } })
        // The real loop records every inbox change durably. The `inserted` splice
        // carries the message (so its id is matchable) and the later splice with
        // `removedCount` is the claim.
        if (!opts.omitInboxSplice) {
          events.push({
            type: 'agent/inbox/spliced',
            seq: events.length,
            data: { target: 'next-turn', start: 0, inserted: [message] },
          })
          events.push({
            type: 'agent/inbox/spliced',
            seq: events.length,
            data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
          })
        }

        events.push({ type: 'step/start', seq: events.length, data: { turn: thisTurn, step: 1 } })

        // The field failure: prompt assembly throws, so NO `user/message` and NO
        // model call happen — only a step and an error turn/end.
        if (opts.errorTurn || opts.blockedTurn) {
          events.push({
            type: 'turn/end',
            seq: events.length,
            data: {
              turn: thisTurn,
              reason: opts.blockedTurn
                ? { kind: 'blocked' }
                : {
                    kind: 'error',
                    error: {
                      message: opts.errorMessage ?? 'simulated assembly failure',
                      code: 'UNKNOWN',
                    },
                  },
            },
          })
          return
        }

        // The real loop appends the claimed message here.
        events.push({
          type: 'user/message',
          seq: events.length,
          data: { ...message, role: 'user' },
        })
        const text =
          typeof opts.reply === 'function' ? opts.reply(thisTurn) : (opts.reply ?? 'reply')
        events.push(assistantEvent(thisTurn, text))
        events.push({
          type: 'turn/end',
          seq: events.length,
          data: { turn: thisTurn, reason: { kind: 'completed' } },
        })
      })()
    },
    async whenIdle() {
      calls.whenIdle += 1
      // Mirrors the real implementation: awaits the CURRENT activity promise.
      await activity
    },
    cancel() {},
  }

  const registry = new Map()

  const ctx = {
    agents: {
      get(id) {
        calls.get += 1
        return registry.get(id)
      },
      async create(options) {
        calls.create += 1
        if (opts.available === false) throw new Error('no agent factory registered')
        // Model the durable-identity conflict.
        if (opts.persisted === true && !opts.allowCreateWhenPersisted) {
          const err = new Error(`session "${options.sessionId}" already exists`)
          err.name = 'SessionAlreadyExistsError'
          throw err
        }
        registry.set(options.sessionId, agent)
        return {
          agent,
          async dispose() {
            calls.disposed += 1
            registry.delete(options.sessionId)
          },
        }
      },
      async resume(options) {
        calls.resume += 1
        if (opts.resumeUnavailable) {
          const err = new Error('no agent factory registered')
          throw err
        }
        registry.set(options.resumeSessionId, agent)
        return {
          agent,
          async dispose() {
            calls.disposed += 1
            registry.delete(options.resumeSessionId)
          },
        }
      },
    },
    sessionQuery: opts.hasPersistence
      ? {
          async observeSession() {
            return { [Symbol.dispose]() {} }
          },
        }
      : undefined,
    sessions: {
      async flush() {
        calls.flush += 1
        return true
      },
    },
  }

  return { ctx, agent, events, calls }
}

const createUserMessage = (input) => ({ ...input, id: 'msg-' + Math.random() })

// ---------------------------------------------------------------------------

test('extractAssistantText follows the canonical last-non-empty-content rule', () => {
  assert.equal(extractAssistantText([]), '')
  assert.equal(
    extractAssistantText([assistantEvent(1, 'first'), assistantEvent(2, 'second')]),
    'second',
  )

  // An EMPTY-CONTENT message (content.length === 0) records usage only and must
  // not replace earlier output. Verified against the real
  // @deepseek-ai/dsh-subagent/assistant-output: finalAssistantOutput keeps the
  // earlier message here.
  const emptyContent = {
    type: 'assistant/message',
    seq: 2,
    data: { message: { role: 'assistant', content: [] }, stream: [] },
  }
  assert.equal(extractAssistantText([assistantEvent(1, 'kept'), emptyContent]), 'kept')

  // A message whose content is non-empty but holds no text block IS the latest
  // candidate under the canonical rule, so its text contribution is empty and
  // earlier text is NOT resurrected.
  const reasoningOnly = {
    type: 'assistant/message',
    seq: 2,
    data: {
      message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] },
      stream: [],
    },
  }
  assert.equal(extractAssistantText([assistantEvent(1, 'earlier'), reasoningOnly]), '')

  // Streamed text remains the fallback for that same message.
  const reasoningWithStream = {
    type: 'assistant/message',
    seq: 2,
    data: {
      message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] },
      stream: [{ type: 'text-chunks', index: 0, dt: [], texts: ['streamed answer'] }],
    },
  }
  assert.equal(extractAssistantText([reasoningWithStream]), 'streamed answer')
})

test('extractAssistantText falls back to streamed deltas', () => {
  const withStream = {
    type: 'assistant/message',
    seq: 1,
    data: {
      message: { role: 'assistant', content: [] },
      stream: [{ type: 'text-chunks', index: 0, dt: [], texts: ['hel', 'lo'] }],
    },
  }
  assert.equal(extractAssistantText([withStream]), 'hello')

  const chunkForm = {
    type: 'assistant/message',
    seq: 1,
    data: {
      message: { role: 'assistant', content: [] },
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'text-delta', index: 0, text: 'abc' } }],
    },
  }
  assert.equal(extractAssistantText([chunkForm]), 'abc')
})

test('DshBridge creates the agent once and reuses it across turns', async () => {
  const { ctx, calls } = makeFakeDsh({ reply: (t) => `answer ${t}` })
  const bridge = new DshBridge({
    ctx,
    sessionId: 'wechat-clawbot',
    createUserMessage,
  })

  assert.equal(bridge.isLive(), false)

  const first = await bridge.prompt('hello')
  assert.equal(first.text, 'answer 1')
  assert.equal(calls.create, 1)

  const second = await bridge.prompt('again')
  assert.equal(second.text, 'answer 2')
  // The same agent must be reused: no second create.
  assert.equal(calls.create, 1)
  assert.equal(bridge.sessionId, 'wechat-clawbot')
  assert.equal(bridge.isLive(), true)

  // Each turn flushed to durable storage.
  assert.equal(calls.flush, 2)
})

test('DshBridge sends content as a proper user message', async () => {
  const { ctx, calls } = makeFakeDsh()
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  await bridge.prompt('the prompt text')

  assert.equal(calls.followup.length, 1)
  const message = calls.followup[0]
  assert.deepEqual(message.content, [{ type: 'text', text: 'the prompt text' }])
  assert.deepEqual(message.source, { kind: 'user' })
})

test('DshBridge slices the log per turn, not cumulatively', async () => {
  const { ctx } = makeFakeDsh({ reply: (t) => `r${t}` })
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  const first = await bridge.prompt('one')
  assert.equal(first.text, 'r1')
  // One turn contributes: turn/start, two agent/inbox/spliced (insert + claim),
  // step/start, user/message, assistant/message, turn/end.
  assert.equal(first.eventCount, 7)

  const second = await bridge.prompt('two')
  // The second slice must contain only the second turn's events.
  assert.equal(second.eventCount, 7, 'each slice is scoped to its own turn')
  assert.equal(second.text, 'r2')
})

test('DshBridge serialises concurrent turns on one session', async () => {
  const { ctx, calls } = makeFakeDsh()
  const order = []

  // Make whenIdle slow so a second prompt would overtake if not queued.
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })
  const original = calls.followup
  void original

  const p1 = bridge.prompt('a').then(() => order.push('a'))
  const p2 = bridge.prompt('b').then(() => order.push('b'))
  await Promise.all([p1, p2])

  assert.deepEqual(order, ['a', 'b'])
  assert.equal(calls.create, 1)
})

test('DshBridge works WITHOUT any injected message factory', async () => {
  // Regression: a profile-installed plugin cannot resolve
  // `@deepseek-ai/dsh-llm`, so the bridge must not depend on it.
  const { ctx, calls } = makeFakeDsh({ reply: 'ok without factory' })
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  const result = await bridge.prompt('hello')

  assert.equal(result.text, 'ok without factory')
  // The message must still be a well-formed user message.
  const message = calls.followup[0]
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(message.source, { kind: 'user' })
})

test('the built-in factory mints a unique, frozen user message', () => {
  const a = createUserMessageLocal({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })
  const b = createUserMessageLocal({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })

  assert.equal(a.role, 'user')
  assert.notEqual(a.id, b.id, 'each message gets a fresh identity')
  assert.ok(Object.isFrozen(a), 'message must be frozen')
  // The source object is cloned, not shared with the caller.
  const source = { kind: 'user' }
  const c = createUserMessageLocal({ content: [], source })
  assert.notEqual(c.source, source)
})

test('DshBridge adopts the canonical factory when one is provided', async () => {
  const { ctx, calls } = makeFakeDsh()
  let used = 0
  const canonical = (input) => {
    used += 1
    return { ...input, id: 'canonical-id' }
  }
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  bridge.setMessageFactory(canonical)
  await bridge.prompt('hi')

  assert.equal(used, 1)
  assert.equal(calls.followup[0].id, 'canonical-id')
})

test('DshBridge waits for the turn to actually land in the log', async () => {
  // Regression for the empty-reply bug: `whenIdle()` resolves immediately when
  // the agent is already idle, so a bare `await whenIdle()` reads the log
  // BEFORE the turn appended its assistant message.
  const { ctx, agent } = makeFakeDsh({ reply: 'the real answer', turnDelayMs: 30 })
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  // `whenIdle()` on an idle agent resolves at once — this is the trap.
  await agent.whenIdle()

  const result = await bridge.prompt('hello')
  assert.equal(result.text, 'the real answer', 'must not return an empty reply')
  assert.ok(result.eventCount >= 3, `expected the turn events, got ${result.eventCount}`)
})

test('DshBridge never returns an empty reply for a slow turn', async () => {
  const { ctx } = makeFakeDsh({ reply: 'slow but sure', turnDelayMs: 60 })
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  const result = await bridge.prompt('hello')
  assert.equal(result.text, 'slow but sure')
  assert.notEqual(result.text, '')
})

test('DshBridge waits for each turn independently across several prompts', async () => {
  const { ctx } = makeFakeDsh({ reply: (t) => `answer ${t}`, turnDelayMs: 15 })
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  assert.equal((await bridge.prompt('one')).text, 'answer 1')
  assert.equal((await bridge.prompt('two')).text, 'answer 2')
  assert.equal((await bridge.prompt('three')).text, 'answer 3')
})

test('DshBridge resumes an already-persisted session instead of creating', async () => {
  // Regression for SessionAlreadyExistsError: a fixed session id survives DSH
  // restarts, so the second run must RESUME, not create.
  const { ctx, calls } = makeFakeDsh({ reply: 'from history', hasPersistence: true })
  const bridge = new DshBridge({ ctx, sessionId: 'wechat-clawbot' })

  const result = await bridge.prompt('hello again')

  assert.equal(calls.resume, 1, 'must resume the persisted session')
  assert.equal(calls.create, 0, 'must not attempt create for a persisted id')
  assert.equal(result.text, 'from history')
})

test('DshBridge creates when the session does not exist yet', async () => {
  const { ctx, calls } = makeFakeDsh({ reply: 'fresh' })
  const bridge = new DshBridge({ ctx, sessionId: 'wechat-clawbot' })

  const result = await bridge.prompt('first ever message')

  assert.equal(calls.create, 1)
  assert.equal(calls.resume, 0)
  assert.equal(result.text, 'fresh')
})

test('DshBridge recovers from SessionAlreadyExistsError thrown by create', async () => {
  // The persistence backend reports the conflict even though our pre-check said
  // "no" (no sessionQuery, or a session created between check and create).
  const { ctx, calls } = makeFakeDsh({ reply: 'recovered', persisted: true })
  const bridge = new DshBridge({ ctx, sessionId: 'wechat-clawbot' })

  const result = await bridge.prompt('hello')

  assert.equal(calls.create, 1, 'create is attempted first')
  assert.equal(calls.resume, 1, 'then falls back to resume')
  assert.equal(result.text, 'recovered')
})

test('DshBridge reports the real error when resume is unavailable', async () => {
  const { ctx } = makeFakeDsh({ persisted: true, resumeUnavailable: true })
  const bridge = new DshBridge({ ctx, sessionId: 'wechat-clawbot' })

  await assert.rejects(() => bridge.prompt('hello'), /no agent factory registered/)
})

test('DshBridge does not create twice across turns', async () => {
  const { ctx, calls } = makeFakeDsh({ reply: 'ok', hasPersistence: true })
  const bridge = new DshBridge({ ctx, sessionId: 'wechat-clawbot' })

  await bridge.prompt('one')
  await bridge.prompt('two')

  // Resumes once, then reuses the live agent.
  assert.equal(calls.resume, 1)
  assert.equal(calls.create, 0)
})

test('isSessionAlreadyExists matches by name, not by class identity', () => {
  // The class lives in a package a profile-installed plugin cannot import.
  assert.equal(isSessionAlreadyExists({ name: 'SessionAlreadyExistsError' }), true)
  assert.equal(isSessionAlreadyExists(new Error('nope')), false)
  assert.equal(isSessionAlreadyExists(undefined), false)
  assert.equal(isSessionAlreadyExists('SessionAlreadyExistsError'), false)
})

test('DshBridge ignores a stray EMPTY turn and waits for the real one', async () => {
  // Regression for the field failure: the loop opens a turn and closes it
  // immediately when the inbox claim was empty, so watching for "any turn/end"
  // returns before our prompt is admitted — producing an empty reply.
  const { ctx } = makeFakeDsh({
    reply: 'the real answer',
    spuriousEmptyTurn: true,
    turnDelayMs: 20,
  })
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  const result = await bridge.prompt('hello')

  assert.equal(result.text, 'the real answer', 'must not settle on the empty turn')
  assert.notEqual(result.text, '')
})

test('DshBridge waits for the prompt to be admitted before reporting done', async () => {
  // The empty reply is what the user saw. Assert we now surface the real text
  // even when a spurious turn/end lands first.
  const { ctx } = makeFakeDsh({
    reply: 'admitted',
    spuriousEmptyTurn: true,
    turnDelayMs: 30,
  })
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  const r1 = await bridge.prompt('one')
  assert.equal(r1.text, 'admitted')

  const r2 = await bridge.prompt('two')
  assert.equal(r2.text, 'admitted', 'the second turn must also be correct')
})

test('DshBridge reports when a prompt is never admitted to the log', async () => {
  // If the message never becomes a user/message event, the bridge must stop
  // rather than hang until the full timeout.
  const { ctx } = makeFakeDsh({ omitUserMessage: true, reply: 'unused' })
  const bridge = new DshBridge({ ctx, sessionId: 's', turnWaitMs: 5_000 })

  const started = Date.now()
  const result = await bridge.prompt('never admitted')
  const elapsed = Date.now() - started

  assert.equal(result.text, '', 'nothing was admitted, so there is no reply')
  assert.ok(elapsed < 4_000, `must not wait out the whole timeout (took ${elapsed}ms)`)
})

test('DshBridge surfaces a turn that errored during assembly', async () => {
  // Regression for the {{model}} failure: the prompt IS claimed (inbox splice),
  // the step starts, then the turn errors BEFORE appending user/message and
  // before any model call. The old wait keyed on `user/message`, so it reported
  // "never admitted" and returned an empty reply with no explanation.
  const { ctx } = makeFakeDsh({
    errorTurn: true,
    errorMessage: 'prompt variable "{{model}}" has no value for this assembly',
  })
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  const result = await bridge.prompt('hello')

  assert.equal(result.text, '', 'an errored turn has no text')
  assert.equal(result.errored, true, 'the error must be reported, not hidden')
  assert.equal(result.stopReason?.kind, 'error')
  assert.match(
    JSON.stringify(result.stopReason),
    /\{\{model\}\}/,
    'the durable reason must be preserved verbatim',
  )
  // The turn really did run: a step happened after our prompt was claimed.
  assert.ok(result.eventCount >= 4, `expected the turn events, got ${result.eventCount}`)
})

test('DshBridge reports a normal turn as not errored', async () => {
  const { ctx } = makeFakeDsh({ reply: 'fine' })
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  const result = await bridge.prompt('hello')
  assert.equal(result.errored, false)
  assert.equal(result.stopReason?.kind, 'completed')
  assert.equal(result.text, 'fine')
})

test('findTurnEndReason and isErrorReason read the durable reason', () => {
  const errored = [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'x' } } } }]
  const ok = [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]

  assert.equal(isErrorReason(findTurnEndReason(errored)), true)
  assert.equal(isErrorReason(findTurnEndReason(ok)), false)
  assert.equal(findTurnEndReason([]), undefined)
  assert.equal(isErrorReason(undefined), false)
})

test('DshBridge uses agentDefaultModel when no provider/model is configured', async () => {
  // Without a model, DSH cannot resolve the {{model}} system-prompt variable and
  // every turn fails before any model call. The bridge must supply one.
  const { agent, calls } = makeFakeDsh({ reply: 'ok' })
  let createOptions
  const ctx = {
    agents: {
      get: () => undefined,
      async create(options) {
        createOptions = options
        return { agent, dispose: async () => {} }
      },
    },
    sessions: { flush: async () => true },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    },
  }

  const bridge = new DshBridge({ ctx, sessionId: 's' })
  await bridge.prompt('hello')

  assert.deepEqual(createOptions.agentOptions, {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  void calls
})

test('DshBridge lets explicit config override the default model', async () => {
  const { agent } = makeFakeDsh({ reply: 'ok' })
  let createOptions
  const ctx = {
    agents: {
      get: () => undefined,
      async create(options) {
        createOptions = options
        return { agent, dispose: async () => {} }
      },
    },
    sessions: { flush: async () => true },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
    },
  }

  const bridge = new DshBridge({
    ctx,
    sessionId: 's',
    agentOptions: { provider: 'my-provider', model: 'my-model' },
  })
  await bridge.prompt('hello')

  assert.equal(createOptions.agentOptions.provider, 'my-provider')
  assert.equal(createOptions.agentOptions.model, 'my-model')
})

test('DshBridge always sets meta.cwd from the workspace registry', async () => {
  // Regression for: prompt variable "{{cwd}}" has no value
  // DSH resolves {{cwd}} from agent.session.header.cwd, which is fixed at
  // creation. Without meta.cwd the session lands under a "_no-cwd" directory
  // and every turn fails prompt assembly before any model call.
  const { agent } = makeFakeDsh({ reply: 'ok' })
  let createOptions
  const ctx = {
    agents: {
      get: () => undefined,
      async create(options) {
        createOptions = options
        return { agent, dispose: async () => {} }
      },
    },
    sessions: { flush: async () => true },
    workspaceRegistry: {
      list: () => [{ path: 'C:\\workspace\\from-registry' }],
    },
  }

  const bridge = new DshBridge({ ctx, sessionId: 's' })
  await bridge.prompt('hello')

  assert.equal(createOptions.meta?.cwd, 'C:\\workspace\\from-registry')
})

test('DshBridge prefers an explicitly configured cwd', async () => {
  const { agent } = makeFakeDsh({ reply: 'ok' })
  let createOptions
  const ctx = {
    agents: {
      get: () => undefined,
      async create(options) {
        createOptions = options
        return { agent, dispose: async () => {} }
      },
    },
    sessions: { flush: async () => true },
    workspaceRegistry: { list: () => [{ path: 'C:\\from-registry' }] },
  }

  const bridge = new DshBridge({ ctx, sessionId: 's', cwd: 'C:\\explicit' })
  await bridge.prompt('hello')

  assert.equal(createOptions.meta?.cwd, 'C:\\explicit')
})

test('DshBridge falls back to the process cwd when no workspace is registered', async () => {
  const { agent } = makeFakeDsh({ reply: 'ok' })
  let createOptions
  const ctx = {
    agents: {
      get: () => undefined,
      async create(options) {
        createOptions = options
        return { agent, dispose: async () => {} }
      },
    },
    sessions: { flush: async () => true },
    // No workspaceRegistry at all.
  }

  const bridge = new DshBridge({ ctx, sessionId: 's' })
  await bridge.prompt('hello')

  assert.equal(createOptions.meta?.cwd, process.cwd())
})

test('DshBridge refuses a session whose header has no cwd', async () => {
  // header.cwd is immutable and resume cannot add one, so such a session can
  // never assemble its prompt. Failing loudly beats endless empty replies.
  const poisoned = {
    id: 's',
    session: {
      header: { createdAt: 1 }, // no cwd
      get seq() {
        return 0
      },
      snapshotEvents: () => [],
    },
    options: {},
    followup() {},
    async whenIdle() {},
    cancel() {},
  }
  const ctx = {
    agents: {
      get: () => poisoned,
      create: async () => ({ agent: poisoned, dispose: async () => {} }),
      resume: async () => ({ agent: poisoned, dispose: async () => {} }),
    },
    sessions: { flush: async () => true },
  }

  const bridge = new DshBridge({ ctx, sessionId: 's' })
  await assert.rejects(
    () => bridge.prompt('hello'),
    (err) => err instanceof BridgeUnavailableError && /\{\{cwd\}\}/.test(String(err.message)),
  )
})

test('DshBridge reports a BLOCKED turn (archived session gate)', async () => {
  // DSH's archived-session-gate rejects the step, so the loop closes the turn
  // as `blocked` with no model call. Callers must be able to say why.
  const { ctx } = makeFakeDsh({ blockedTurn: true })
  const bridge = new DshBridge({ ctx, sessionId: 's' })

  const result = await bridge.prompt('hello')

  assert.equal(result.text, '')
  assert.equal(result.blocked, true, 'the blocked reason must be reported')
  assert.equal(result.errored, false, 'blocked is not an error')
  assert.equal(result.stopReason?.kind, 'blocked')
})

test('isBlockedReason recognises only the blocked kind', () => {
  assert.equal(isBlockedReason({ kind: 'blocked' }), true)
  assert.equal(isBlockedReason({ kind: 'error' }), false)
  assert.equal(isBlockedReason({ kind: 'completed' }), false)
  assert.equal(isBlockedReason(undefined), false)
})

test('DshBridge reports a missing agent factory', async () => {
  const { ctx } = makeFakeDsh({ available: false })
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  await assert.rejects(() => bridge.prompt('hello'), /no agent factory registered/)
})

test('DshBridge survives a rejecting whenIdle and still returns the reply', async () => {
  const { ctx, calls } = makeFakeDsh({ reply: 'ok' })
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  // A rejecting whenIdle must not fail the prompt: the durable turn/end is the
  // primary completion signal, and whenIdle is only a secondary one.
  const agent = await bridge.ensureAgent()
  agent.whenIdle = async () => {
    throw new Error('transient turn failure')
  }

  const first = await bridge.prompt('boom')
  assert.equal(first.text, 'ok', 'a rejected whenIdle must not lose the reply')

  // The queue must not be poisoned: a later turn still succeeds.
  const ok = await bridge.prompt('recover')
  assert.equal(ok.text, 'ok')
  assert.equal(calls.create, 1)
})

test('DshBridge falls back to whenIdle when a turn appends no turn/end', async () => {
  // A blocked/rejected prompt may close without a turn/end event. The wait must
  // then rely on whenIdle and still terminate instead of hanging.
  const { ctx, agent } = makeFakeDsh({ reply: 'unused' })
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  const original = agent.followup.bind(agent)
  agent.followup = (message) => {
    original(message)
    // Strip the turn/end marker from the log once the turn settles.
    setTimeout(() => {
      const log = agent.session.snapshotEvents(0)
      const idx = log.findIndex((e) => e.type === 'turn/end')
      if (idx >= 0) log.splice(idx, 1)
    }, 5)
  }

  const result = await bridge.prompt('hello')
  // It must return (not hang) even though no turn/end is observable.
  assert.equal(typeof result.text, 'string')
})

test('DshBridge dispose tears down only the agent it created', async () => {
  const { ctx, calls, agent } = makeFakeDsh()
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  await bridge.prompt('hi')
  await bridge.dispose()
  assert.equal(calls.disposed, 1)
  assert.equal(bridge.isLive(), false)

  // Disposing again is a no-op.
  await bridge.dispose()
  assert.equal(calls.disposed, 1)

  void agent
})

test('DshBridge tolerates a flush failure and still returns the text', async () => {
  const { ctx } = makeFakeDsh({ reply: 'still here' })
  ctx.sessions.flush = async () => {
    throw new Error('disk full')
  }
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  const result = await bridge.prompt('hi')
  assert.equal(result.text, 'still here')
})
