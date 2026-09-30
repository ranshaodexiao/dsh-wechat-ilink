/**
 * The long-polling channel loop.
 *
 * `getupdates` is a long poll: a client-side timeout is a normal empty batch.
 * Protocol failures back off (2s, then 30s after three consecutive failures);
 * an expired session (errcode -14) stops the loop so the operator can re-login.
 *
 * The cursor (`get_updates_buf`) is opaque and persisted per account after
 * every batch. Server message ids are deduplicated because a re-delivered
 * batch must not re-run the agent.
 */

import { AccountStore } from './ilink/accounts.js'
import { ILinkClient, SessionExpiredError } from './ilink/transport.js'
import { normalizeInbound, type NormalizedInbound } from './ilink/message.js'
import type { WeixinMessage } from './ilink/types.js'

export interface InboundEvent {
  accountId: string
  fromUserId: string
  contextToken: string
  messageId: string
  normalized: NormalizedInbound
  receivedAt: number
  /** Raw protocol message, for diagnostics. */
  raw: WeixinMessage
}

export type ChannelState = 'stopped' | 'running' | 'paused' | 'expired'

export class ChannelListener {
  #client: ILinkClient
  #store: AccountStore
  #accountId: string
  #onInbound: (event: InboundEvent) => void | Promise<void>
  #log: (level: 'info' | 'error' | 'debug', message: string) => void

  #state: ChannelState = 'stopped'
  #abort: AbortController | undefined
  #loop: Promise<void> | undefined
  #syncBuf = ''
  #seen = new Set<string>()
  #seenOrder: string[] = []
  #consecutiveFailures = 0

  constructor(opts: {
    client: ILinkClient
    store: AccountStore
    accountId: string
    onInbound: (event: InboundEvent) => void | Promise<void>
    log?: (level: 'info' | 'error' | 'debug', message: string) => void
  }) {
    this.#client = opts.client
    this.#store = opts.store
    this.#accountId = opts.accountId
    this.#onInbound = opts.onInbound
    this.#log = opts.log ?? (() => {})
    this.#syncBuf = opts.store.loadSyncBuf(opts.accountId)
  }

  get state(): ChannelState {
    return this.#state
  }

  #remember(messageId: string): boolean {
    if (this.#seen.has(messageId)) return false
    this.#seen.add(messageId)
    this.#seenOrder.push(messageId)
    if (this.#seenOrder.length > 2000) {
      const dropped = this.#seenOrder.splice(0, this.#seenOrder.length - 2000)
      for (const id of dropped) this.#seen.delete(id)
    }
    return true
  }

  start(): void {
    if (this.#state === 'running') return
    this.#abort = new AbortController()
    this.#state = 'running'
    this.#consecutiveFailures = 0
    this.#loop = this.#run(this.#abort.signal)
  }

  /** Stop the loop and wait for the in-flight long poll to unwind. */
  async stop(): Promise<void> {
    if (this.#state === 'stopped') return
    this.#abort?.abort()
    try {
      await this.#loop
    } catch {
      // Errors are already logged inside the loop.
    }
    this.#state = 'stopped'
    this.#loop = undefined
  }

  async #run(signal: AbortSignal): Promise<void> {
    this.#log('info', `channel listener started for account ${this.#accountId}`)

    while (!signal.aborted) {
      try {
        const resp = await this.#client.getUpdates({
          getUpdatesBuf: this.#syncBuf,
          signal,
        })
        if (signal.aborted) break

        this.#consecutiveFailures = 0

        if (resp.get_updates_buf && resp.get_updates_buf !== this.#syncBuf) {
          this.#syncBuf = resp.get_updates_buf
          this.#store.saveSyncBuf(this.#accountId, this.#syncBuf)
        }

        for (const msg of resp.msgs ?? []) {
          if (signal.aborted) break
          await this.#handleMessage(msg)
        }

        // Yield to the macrotask queue once per iteration. A real long poll
        // already blocks, but a server (or a test double) that answers
        // immediately would otherwise spin the microtask queue and starve
        // abort/stop handling.
        if (!signal.aborted) await this.#yieldToEventLoop(signal)
      } catch (err) {
        if (signal.aborted) break

        if (err instanceof SessionExpiredError) {
          // The credential is dead; clear the cursor and stop until re-login.
          this.#state = 'expired'
          this.#store.clearSyncBuf(this.#accountId)
          this.#log('error', 'session expired (errcode -14); re-run QR login to reconnect')
          return
        }

        this.#consecutiveFailures += 1
        const delayMs = this.#consecutiveFailures >= 3 ? 30_000 : 2_000
        this.#log(
          'error',
          `getUpdates failed (attempt ${this.#consecutiveFailures}): ${String(err)}; retry in ${delayMs}ms`,
        )
        await this.#sleep(delayMs, signal)
      }
    }

    this.#state = 'stopped'
    this.#log('info', 'channel listener stopped')
  }

  async #handleMessage(msg: WeixinMessage): Promise<void> {
    // Only user-authored messages drive the agent; ignore bot echoes.
    if (msg.message_type !== undefined && msg.message_type !== 1) return
    if (msg.message_state !== undefined && msg.message_state === 0) return

    const fromUserId = msg.from_user_id?.trim()
    const contextToken = msg.context_token?.trim()
    const messageId = String(msg.message_id ?? msg.client_id ?? msg.seq ?? '')

    if (!fromUserId || !contextToken) {
      this.#log('debug', `skipping message without from_user_id/context_token (id=${messageId})`)
      return
    }

    if (msg.delete_time_ms) return
    if (messageId && !this.#remember(messageId)) {
      this.#log('debug', `skipping duplicate message id=${messageId}`)
      return
    }

    const normalized = normalizeInbound(msg)
    if (!normalized.text && normalized.images.length === 0) {
      this.#log('debug', `message id=${messageId} carried no usable content`)
      return
    }

    try {
      await this.#onInbound({
        accountId: this.#accountId,
        fromUserId,
        contextToken,
        messageId,
        normalized,
        receivedAt: Date.now(),
        raw: msg,
      })
    } catch (err) {
      this.#log('error', `inbound handler failed for id=${messageId}: ${String(err)}`)
    }
  }

  /** Yield to the macrotask queue, or return early when aborted. */
  #yieldToEventLoop(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, 0)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      // Deliberately NOT unref'd: a backoff sleep must keep the process alive
      // long enough to retry, and must always settle so stop() can finish.
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
