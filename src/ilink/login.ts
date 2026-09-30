/**
 * QR login state machine for the WeChat ClawBot channel.
 *
 * Flow: `get_bot_qrcode` -> poll `get_qrcode_status` -> on `confirmed` persist
 * `bot_token` + `baseurl`. Statuses `scaned_but_redirect` and `binded_redirect`
 * move the polling host; `need_verifycode` requires a pairing code from the user.
 */

import { AccountStore } from './accounts.js'
import { ILinkClient, type QrcodeStatusResponse } from './transport.js'

export const DEFAULT_ILINK_BOT_TYPE = '3'

export interface QrLoginTicket {
  id: string
  qrcode: string
  /** URL to render as a QR code. */
  qrcodeUrl: string
  startedAt: number
}

export interface QrLoginOutcome {
  status: QrcodeStatusResponse['status']
  error?: string
  accountId?: string
  userId?: string
  baseUrl?: string
}

export interface QrLoginManagerOptions {
  store: AccountStore
  client: ILinkClient
  botType?: string
  /** Injectable clock, for tests. */
  now?: () => number
}

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000

interface ActiveLogin extends QrLoginTicket {
  botToken?: string
  pendingVerifyCode?: string
}

export class QrLoginManager {
  #store: AccountStore
  #client: ILinkClient
  #botType: string
  #now: () => number
  #active = new Map<string, ActiveLogin>()

  constructor(opts: QrLoginManagerOptions) {
    this.#store = opts.store
    this.#client = opts.client
    this.#botType = opts.botType ?? DEFAULT_ILINK_BOT_TYPE
    this.#now = opts.now ?? (() => Date.now())
  }

  #purge(): void {
    for (const [id, login] of this.#active) {
      if (this.#now() - login.startedAt >= ACTIVE_LOGIN_TTL_MS) this.#active.delete(id)
    }
  }

  /** Tokens of locally bound accounts, newest first (at most 10). */
  #localTokens(): string[] {
    const ids = this.#store.listAccountIds()
    const tokens: string[] = []
    for (let i = ids.length - 1; i >= 0 && tokens.length < 10; i -= 1) {
      const data = this.#store.load(ids[i] as string)
      const token = data?.token?.trim()
      if (token) tokens.push(token)
    }
    return tokens
  }

  /** Request a fresh QR code and start tracking the login attempt. */
  async start(): Promise<QrLoginTicket> {
    this.#purge()
    const resp = await this.#client.getBotQrcode({
      botType: this.#botType,
      localTokenList: this.#localTokens(),
    })
    if (!resp.qrcode) throw new Error('ilink get_bot_qrcode returned no qrcode token')

    const ticket: ActiveLogin = {
      id: `qr-${this.#now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      qrcode: resp.qrcode,
      qrcodeUrl: resp.qrcode_img_content,
      startedAt: this.#now(),
    }
    this.#active.set(ticket.id, ticket)
    return { id: ticket.id, qrcode: ticket.qrcode, qrcodeUrl: ticket.qrcodeUrl, startedAt: ticket.startedAt }
  }

  /** True when the ticket is still tracked and not yet expired. */
  has(ticketId: string): boolean {
    this.#purge()
    return this.#active.has(ticketId)
  }

  /**
   * Long-poll one step of a login attempt.
   * On `confirmed` the credential is persisted and the account registered.
   */
  async poll(params: {
    ticketId: string
    verifyCode?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<QrLoginOutcome> {
    this.#purge()
    const login = this.#active.get(params.ticketId)
    if (!login) return { status: 'expired', error: 'login ticket not found or expired' }

    if (params.verifyCode) login.pendingVerifyCode = params.verifyCode

    const resp = await this.#client.getQrcodeStatus({
      qrcode: login.qrcode,
      ...(login.pendingVerifyCode ? { verifyCode: login.pendingVerifyCode } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    })

    switch (resp.status) {
      case 'scaned_but_redirect':
        // The login is being served by a different IDC; follow it.
        if (resp.redirect_host) {
          const host = resp.redirect_host.startsWith('http')
            ? resp.redirect_host
            : `https://${resp.redirect_host}`
          this.#client.setBaseUrl(host)
        }
        return { status: resp.status }

      case 'binded_redirect':
        // Already bound elsewhere; nothing to persist.
        this.#active.delete(params.ticketId)
        return { status: resp.status }

      case 'need_verifycode':
        return { status: resp.status }

      case 'verify_code_blocked':
        this.#active.delete(params.ticketId)
        return { status: resp.status, error: 'too many wrong pairing codes; restart login' }

      case 'expired':
        this.#active.delete(params.ticketId)
        return { status: resp.status }

      case 'confirmed': {
        const token = resp.bot_token?.trim()
        const accountId = resp.ilink_bot_id?.trim()
        if (!token || !accountId) {
          this.#active.delete(params.ticketId)
          return { status: 'expired', error: 'confirmed without bot_token/ilink_bot_id' }
        }
        const baseUrl = resp.baseurl?.trim()
        const userId = resp.ilink_user_id?.trim()

        // Keep only the newest binding per WeChat user, so context tokens are unambiguous.
        if (userId) {
          for (const id of this.#store.listAccountIds()) {
            if (id === accountId) continue
            if (this.#store.load(id)?.userId?.trim() === userId) this.#store.clear(id)
          }
        }

        this.#store.save(accountId, {
          token,
          ...(baseUrl ? { baseUrl } : {}),
          ...(userId ? { userId } : {}),
        })
        this.#store.registerAccountId(accountId)
        this.#active.delete(params.ticketId)

        this.#client.setToken(token)
        if (baseUrl) this.#client.setBaseUrl(baseUrl)

        return {
          status: 'confirmed',
          accountId,
          ...(userId ? { userId } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        }
      }

      case 'wait':
      case 'scaned':
      default:
        return { status: resp.status }
    }
  }

  cancel(ticketId: string): void {
    this.#active.delete(ticketId)
  }
}
