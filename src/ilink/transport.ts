/**
 * iLink HTTP transport.
 *
 * Implements the request contract of `@tencent-weixin/openclaw-weixin` 2.4.x:
 *   - common headers: `iLink-App-Id`, `iLink-App-ClientVersion`, optional `SKRouteTag`
 *   - business headers: `Content-Type`, `AuthorizationType`, `Authorization`, `X-WECHAT-UIN`
 *   - long-poll `getupdates` where a client-side timeout is a normal empty result
 */

import crypto from 'node:crypto'

import type {
  GetConfigResp,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendMessageReq,
  SendMessageResp,
  SendTypingReq,
} from './types.js'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** Default long-poll window for getUpdates. */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
const DEFAULT_API_TIMEOUT_MS = 15_000
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000

/** `session timeout` / expired — the credential must be renewed by QR login. */
export const ERR_SESSION_EXPIRED = -14

export interface ILinkTransportOptions {
  baseUrl?: string
  token?: string
  /** Sent as `iLink-App-Id`; identifies the calling app. */
  appId?: string
  /** Plugin version, advertised to the server. */
  channelVersion?: string
  /** UA-style self-declared bot identity. */
  botAgent?: string
  /** Optional `SKRouteTag` header. */
  routeTag?: string
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch
}

/** Encode `major.minor.patch` as `0x00MMNNPP`. */
export function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10))
  const major = Number.isFinite(parts[0]) ? (parts[0] as number) : 0
  const minor = Number.isFinite(parts[1]) ? (parts[1] as number) : 0
  const patch = Number.isFinite(parts[2]) ? (parts[2] as number) : 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/** `X-WECHAT-UIN`: random uint32 -> decimal string -> base64. */
export function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

const DEFAULT_BOT_AGENT = 'DSH-ClawBot'
const BOT_AGENT_MAX_LEN = 256

/**
 * Sanitize a UA-style bot identity.
 * Tokens failing the grammar are dropped; falls back to the default.
 */
export function sanitizeBotAgent(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return DEFAULT_BOT_AGENT
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_BOT_AGENT

  const productRe = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/

  const rawTokens = trimmed.split(/\s+/)
  const tokens: string[] = []
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i] as string
    if (tok.startsWith('(') && !tok.endsWith(')')) {
      let acc = tok
      while (i + 1 < rawTokens.length && !acc.endsWith(')')) {
        i += 1
        acc += ' ' + rawTokens[i]
      }
      tokens.push(acc)
    } else {
      tokens.push(tok)
    }
  }

  const accepted: string[] = []
  let pending: string | null = null
  for (const tok of tokens) {
    if (tok.startsWith('(') && tok.endsWith(')')) {
      const inner = tok.slice(1, -1)
      if (pending && commentCharRe.test(inner)) {
        accepted.push(`${pending} (${inner})`)
        pending = null
      } else if (pending) {
        accepted.push(pending)
        pending = null
      }
      continue
    }
    if (pending) {
      accepted.push(pending)
      pending = null
    }
    if (productRe.test(tok)) pending = tok
  }
  if (pending) accepted.push(pending)
  if (accepted.length === 0) return DEFAULT_BOT_AGENT

  const joined = accepted.join(' ')
  if (Buffer.byteLength(joined, 'utf-8') <= BOT_AGENT_MAX_LEN) return joined

  const truncated: string[] = []
  let len = 0
  for (const t of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(t, 'utf-8')
    if (len + add > BOT_AGENT_MAX_LEN) break
    truncated.push(t)
    len += add
  }
  return truncated.length > 0 ? truncated.join(' ') : DEFAULT_BOT_AGENT
}

const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id'])

/**
 * Quote uint64 identifiers before `JSON.parse` sees them, so values above
 * 2^53 are not silently rounded. Only real object keys are rewritten.
 */
export function parseWeixinApiJson<T>(rawText: string): T {
  let output = ''
  let index = 0
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++]
      continue
    }
    const stringStart = index
    index++
    let escaped = false
    while (index < rawText.length) {
      const char = rawText[index++]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') break
    }
    const stringToken = rawText.slice(stringStart, index)
    output += stringToken

    let cursor = index
    while (/\s/.test(rawText[cursor] ?? '')) cursor++
    if (rawText[cursor] !== ':') continue

    let key: unknown
    try {
      key = JSON.parse(stringToken)
    } catch {
      continue
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue

    output += rawText.slice(index, cursor + 1)
    cursor++
    while (/\s/.test(rawText[cursor] ?? '')) output += rawText[cursor++]

    const numberStart = cursor
    if (rawText[cursor] === '-') cursor++
    while (/\d/.test(rawText[cursor] ?? '')) cursor++
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-')) {
      output += `"${rawText.slice(numberStart, cursor)}"`
      index = cursor
    } else {
      index = numberStart
    }
  }
  return JSON.parse(output) as T
}

/** Raised when the server reports an expired session (errcode -14). */
export class SessionExpiredError extends Error {
  constructor(message = 'ilink session expired') {
    super(message)
    this.name = 'SessionExpiredError'
  }
}

function isSessionExpired(payload: { ret?: number; errcode?: number }): boolean {
  return payload.ret === ERR_SESSION_EXPIRED || payload.errcode === ERR_SESSION_EXPIRED
}

export class ILinkClient {
  #baseUrl: string
  #token: string | undefined
  #appId: string
  #clientVersion: number
  #channelVersion: string
  #botAgent: string
  #routeTag: string | undefined
  #fetch: typeof fetch

  constructor(opts: ILinkTransportOptions = {}) {
    this.#baseUrl = opts.baseUrl?.trim() || DEFAULT_BASE_URL
    this.#token = opts.token?.trim() || undefined
    this.#appId = opts.appId ?? 'bot'
    this.#channelVersion = opts.channelVersion ?? '0.0.0'
    this.#clientVersion = buildClientVersion(this.#channelVersion)
    this.#botAgent = sanitizeBotAgent(opts.botAgent)
    this.#routeTag = opts.routeTag
    this.#fetch = opts.fetchImpl ?? globalThis.fetch
  }

  get baseUrl(): string {
    return this.#baseUrl
  }

  /** Point subsequent requests at a different host (IDC redirect / baseurl change). */
  setBaseUrl(baseUrl: string): void {
    if (baseUrl.trim()) this.#baseUrl = baseUrl.trim()
  }

  setToken(token: string | undefined): void {
    this.#token = token?.trim() || undefined
  }

  buildBaseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: this.#channelVersion, bot_agent: this.#botAgent }
  }

  #commonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'iLink-App-Id': this.#appId,
      'iLink-App-ClientVersion': String(this.#clientVersion),
    }
    if (this.#routeTag) headers.SKRouteTag = this.#routeTag
    return headers
  }

  #businessHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      ...this.#commonHeaders(),
    }
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`
    return headers
  }

  async #request(params: {
    method: 'GET' | 'POST'
    endpoint: string
    body?: unknown
    timeoutMs?: number
    label: string
    /** When true, a client-side timeout resolves as a normal empty result. */
    tolerateTimeout?: boolean
    signal?: AbortSignal
  }): Promise<string | undefined> {
    const base = this.#baseUrl.endsWith('/') ? this.#baseUrl : `${this.#baseUrl}/`
    const url = new URL(params.endpoint, base)
    const controller = new AbortController()
    const timer =
      params.timeoutMs !== undefined && params.timeoutMs > 0
        ? setTimeout(() => controller.abort(), params.timeoutMs)
        : undefined

    const onExternalAbort = () => controller.abort()
    if (params.signal) {
      if (params.signal.aborted) controller.abort()
      else params.signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      const res = await this.#fetch(url.toString(), {
        method: params.method,
        headers: params.method === 'POST' ? this.#businessHeaders() : this.#commonHeaders(),
        ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`${params.label} HTTP ${res.status}: ${text.slice(0, 500)}`)
      }
      return text
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (params.tolerateTimeout && !params.signal?.aborted) return undefined
      }
      throw err
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      params.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** Long-poll for new messages; a client timeout resolves as an empty batch. */
  async getUpdates(params: {
    getUpdatesBuf?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<GetUpdatesResp> {
    const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
    const raw = await this.#request({
      method: 'POST',
      endpoint: 'ilink/bot/getupdates',
      body: {
        get_updates_buf: params.getUpdatesBuf ?? '',
        base_info: this.buildBaseInfo(),
      },
      timeoutMs: timeout,
      label: 'getUpdates',
      tolerateTimeout: true,
      ...(params.signal ? { signal: params.signal } : {}),
    })
    if (raw === undefined) {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf }
    }
    const resp = parseWeixinApiJson<GetUpdatesResp>(raw)
    if (isSessionExpired(resp)) {
      throw new SessionExpiredError(resp.errmsg ?? 'ilink session timeout')
    }
    return resp
  }

  /** Send one message; returns the server response. `context_token` is required. */
  async sendMessage(body: SendMessageReq, opts: { signal?: AbortSignal } = {}): Promise<SendMessageResp> {
    const raw = await this.#request({
      method: 'POST',
      endpoint: 'ilink/bot/sendmessage',
      body: { ...body, base_info: this.buildBaseInfo() },
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      label: 'sendMessage',
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    const resp = parseWeixinApiJson<SendMessageResp>(raw ?? '{}')
    if (isSessionExpired(resp)) throw new SessionExpiredError(resp.errmsg ?? 'ilink session timeout')
    if (resp.ret && resp.ret !== 0) {
      throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`)
    }
    return resp
  }

  /** Fetch per-user bot config, which carries the `typing_ticket`. */
  async getConfig(params: {
    ilinkUserId: string
    contextToken?: string
    signal?: AbortSignal
  }): Promise<GetConfigResp> {
    const raw = await this.#request({
      method: 'POST',
      endpoint: 'ilink/bot/getconfig',
      body: {
        ilink_user_id: params.ilinkUserId,
        context_token: params.contextToken,
        base_info: this.buildBaseInfo(),
      },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: 'getConfig',
      ...(params.signal ? { signal: params.signal } : {}),
    })
    const resp = parseWeixinApiJson<GetConfigResp>(raw ?? '{}')
    if (isSessionExpired(resp)) throw new SessionExpiredError(resp.errmsg ?? 'ilink session timeout')
    return resp
  }

  /** Send a typing indicator (status 1 = typing, 2 = cancel). */
  async sendTyping(body: SendTypingReq, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await this.#request({
      method: 'POST',
      endpoint: 'ilink/bot/sendtyping',
      body: { ...body, base_info: this.buildBaseInfo() },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: 'sendTyping',
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  }

  /** Request a pre-signed CDN upload URL for outbound media. */
  async getUploadUrl(req: GetUploadUrlReq, opts: { signal?: AbortSignal } = {}): Promise<GetUploadUrlResp> {
    const raw = await this.#request({
      method: 'POST',
      endpoint: 'ilink/bot/getuploadurl',
      body: { ...req, base_info: this.buildBaseInfo() },
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      label: 'getUploadUrl',
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return parseWeixinApiJson<GetUploadUrlResp>(raw ?? '{}')
  }

  /** Request a login QR code. Returns the polling token and a scannable URL. */
  async getBotQrcode(params: {
    botType?: string
    localTokenList?: string[]
  } = {}): Promise<{ qrcode: string; qrcode_img_content: string }> {
    const botType = params.botType ?? '3'
    const raw = await this.#request({
      method: 'POST',
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      body: { local_token_list: params.localTokenList ?? [] },
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      label: 'getBotQrcode',
    })
    return JSON.parse(raw ?? '{}') as { qrcode: string; qrcode_img_content: string }
  }

  /** Long-poll the scan status of a QR code. */
  async getQrcodeStatus(params: {
    qrcode: string
    verifyCode?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<QrcodeStatusResponse> {
    const query = new URLSearchParams({ qrcode: params.qrcode })
    if (params.verifyCode) query.set('verify_code', params.verifyCode)
    const raw = await this.#request({
      method: 'GET',
      endpoint: `ilink/bot/get_qrcode_status?${query.toString()}`,
      timeoutMs: params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
      label: 'getQrcodeStatus',
      tolerateTimeout: true,
      ...(params.signal ? { signal: params.signal } : {}),
    })
    if (raw === undefined) return { status: 'wait' }
    return JSON.parse(raw) as QrcodeStatusResponse
  }
}

export type QrcodeStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface QrcodeStatusResponse {
  status: QrcodeStatus
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  /** New host to poll when status is `scaned_but_redirect`. */
  redirect_host?: string
  errcode?: number
  errmsg?: string
}
