/**
 * Test helper: an in-process fake iLink server plus a scripted fetch.
 *
 * No sockets and no network: `fetch` is replaced by a function that dispatches
 * to registered route handlers, so the protocol layer can be exercised offline.
 */

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} url
 * @property {string} path
 * @property {Record<string,string>} headers
 * @property {unknown} body
 */

/**
 * @typedef {(req: RecordedRequest) => {status?: number, body?: unknown, headers?: Record<string,string>}} RouteHandler
 */

export class MockServer {
  /** @type {Map<string, RouteHandler>} */
  #routes = new Map()
  /** @type {RecordedRequest[]} */
  requests = []

  /**
   * Register a handler for an `ilink/bot/<name>` endpoint.
   * @param {string} name
   * @param {RouteHandler} handler
   */
  on(name, handler) {
    this.#routes.set(name, handler)
    return this
  }

  /** @returns {ReturnType<RouteHandler>} */
  static json(body, status = 200) {
    return { status, body }
  }

  /** @returns {typeof fetch} */
  get fetchImpl() {
    return (async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString())
      const method = (init?.method ?? 'GET').toUpperCase()
      /** @type {Record<string,string>} */
      const headers = {}
      const rawHeaders = init?.headers ?? {}
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v)

      let body
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }

      /** @type {RecordedRequest} */
      const req = { method, url: url.toString(), path: url.pathname, headers, body }
      this.requests.push(req)

      // Route key: the last path segment, e.g. "getupdates".
      const segments = url.pathname.split('/').filter(Boolean)
      const key = segments.slice(-1)[0] ?? ''

      const handler = this.#routes.get(key)
      if (!handler) {
        return new Response(JSON.stringify({ ret: -1, errmsg: `no route for ${key}` }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const result = handler(req)
      const status = result.status ?? 200
      const resBody = result.body === undefined ? '' : JSON.stringify(result.body)
      return new Response(resBody, {
        status,
        headers: { 'Content-Type': 'application/json', ...(result.headers ?? {}) },
      })
    })
  }

  /**
   * Last request that hit an endpoint, if any.
   * @param {string} name
   * @returns {RecordedRequest | undefined}
   */
  lastRequest(name) {
    for (let i = this.requests.length - 1; i >= 0; i -= 1) {
      if (this.requests[i]?.path.endsWith(`/${name}`)) return this.requests[i]
    }
    return undefined
  }

  /** @param {string} name @returns {RecordedRequest[]} */
  requestsFor(name) {
    return this.requests.filter((r) => r.path.endsWith(`/${name}`))
  }
}

/**
 * Build a minimal inbound WeChat text message.
 * @param {{from: string, to: string, text: string, contextToken: string, messageId?: number|string, seq?: number}} params
 * @returns {Record<string, unknown>}
 */
export function inboundTextMessage(params) {
  return {
    seq: params.seq ?? 1,
    message_id: params.messageId ?? 1000,
    from_user_id: params.from,
    to_user_id: params.to,
    client_id: 'client-1',
    create_time_ms: 1_700_000_000_000,
    session_id: `${params.from}#${params.to}`,
    message_type: 1,
    message_state: 2,
    context_token: params.contextToken,
    item_list: [{ type: 1, text_item: { text: params.text } }],
  }
}

/** A temp state directory rooted in the OS temp area. @returns {Promise<string>} */
export async function makeTempStateDir() {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-test-'))
}
