/**
 * Outbound replies to WeChat.
 *
 * Text is chunked to the client's practical limit, one `sendmessage` per chunk
 * with a fresh `client_id`, all reusing the conversation's `context_token`.
 * Typing indicators are cached per user and refreshed on failure.
 */

import { ILinkClient } from './ilink/transport.js'
import { newClientId, splitOutboundText } from './ilink/message.js'
import type { SendMessageReq } from './ilink/types.js'

const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000

export interface OutboundSenderOptions {
  client: ILinkClient
  maxMessageChars?: number
  log?: (message: string) => void
}

export class OutboundSender {
  #client: ILinkClient
  #maxChars: number
  #log: (message: string) => void
  #typingTickets = new Map<string, { ticket: string; fetchedAt: number }>()

  constructor(opts: OutboundSenderOptions) {
    this.#client = opts.client
    this.#maxChars = opts.maxMessageChars ?? 2000
    this.#log = opts.log ?? (() => {})
  }

  setMaxChars(value: number): void {
    if (Number.isFinite(value) && value > 0) this.#maxChars = value
  }

  /**
   * Send one text message, split into client-sized chunks.
   * `contextToken` is mandatory: it routes the reply to the right chat.
   */
  async sendText(params: {
    toUserId: string
    contextToken: string
    text: string
    signal?: AbortSignal
  }): Promise<number> {
    if (!params.contextToken) {
      throw new Error('cannot reply: missing context_token for this conversation')
    }
    const chunks = splitOutboundText(params.text, this.#maxChars)
    if (chunks.length === 0) return 0

    let sent = 0
    for (const chunk of chunks) {
      const body: SendMessageReq = {
        msg: {
          from_user_id: '',
          to_user_id: params.toUserId,
          client_id: newClientId(),
          message_type: 2, // BOT
          message_state: 2, // FINISH
          context_token: params.contextToken,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        },
      }
      await this.#client.sendMessage(body, params.signal ? { signal: params.signal } : {})
      sent += 1
    }
    this.#log(`sent ${sent} message chunk(s) to ${params.toUserId}`)
    return sent
  }

  /** Fetch (and cache) the typing ticket for a user. */
  async #typingTicket(params: {
    userId: string
    contextToken: string
    signal?: AbortSignal
  }): Promise<string | undefined> {
    const cached = this.#typingTickets.get(params.userId)
    if (cached && Date.now() - cached.fetchedAt < TYPING_TICKET_TTL_MS) return cached.ticket

    const resp = await this.#client.getConfig({
      ilinkUserId: params.userId,
      ...(params.contextToken ? { contextToken: params.contextToken } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    })
    const ticket = resp.typing_ticket?.trim()
    if (ticket) this.#typingTickets.set(params.userId, { ticket, fetchedAt: Date.now() })
    return ticket
  }

  /** Start or stop the "typing…" indicator. Never throws to the caller. */
  async setTyping(params: {
    userId: string
    contextToken: string
    typing: boolean
    signal?: AbortSignal
  }): Promise<void> {
    try {
      const ticket = await this.#typingTicket({
        userId: params.userId,
        contextToken: params.contextToken,
        ...(params.signal ? { signal: params.signal } : {}),
      })
      if (!ticket) return
      await this.#client.sendTyping(
        {
          ilink_user_id: params.userId,
          typing_ticket: ticket,
          status: params.typing ? 1 : 2,
        },
        params.signal ? { signal: params.signal } : {},
      )
    } catch (err) {
      // A stale ticket: drop it so the next attempt refetches.
      this.#typingTickets.delete(params.userId)
      this.#log(`typing indicator failed (ignored): ${String(err)}`)
    }
  }

  /** Keep the typing indicator alive while a long turn runs. */
  startTypingKeepalive(params: {
    userId: string
    contextToken: string
    intervalMs: number
  }): () => void {
    let stopped = false
    const tick = () => {
      if (stopped) return
      void this.setTyping({
        userId: params.userId,
        contextToken: params.contextToken,
        typing: true,
      })
    }
    tick()
    const timer = setInterval(tick, Math.max(1000, params.intervalMs))
    timer.unref?.()

    return () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      void this.setTyping({
        userId: params.userId,
        contextToken: params.contextToken,
        typing: false,
      })
    }
  }
}
