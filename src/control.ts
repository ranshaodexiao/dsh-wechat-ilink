/**
 * WeChat-side session control.
 *
 * By default every WeChat message goes to the channel's own session. These
 * commands let the user point the channel at ANOTHER DSH session — for example
 * one they are actively working in — drive it from WeChat, and then return:
 *
 *   /list         list attachable sessions
 *   /use <ref>    attach to a session (number from /list, id prefix, or exact id)
 *   /back         detach and return to the channel's own session
 *   /where        show the current target
 *   /help         usage
 *
 * Only these exact command words are intercepted; anything else (including
 * other `/…` text) is forwarded to the agent unchanged.
 */

/** One attachable session, as presented to the user. */
export interface SessionChoice {
  id: string
  title?: string
  /** A live agent exists, so WeChat can drive it immediately. */
  live: boolean
  cwd?: string
  createdAt?: number
}

/**
 * Is this one of the plugin's own sessions rather than work the user might
 * steer?
 *
 *   - the channel's home session: `/back` already reaches it, and the footer
 *     reports it as the current target, so numbering it as a choice is noise;
 *   - the startup self-test's session (`<home>-selftest`).
 *
 * Exported so the host adapter and the tests share one definition.
 */
export function isInternalSession(id: string, homeSessionId: string): boolean {
  return id === homeSessionId || id === `${homeSessionId}-selftest`
}

/** Everything the control layer needs from the host environment. */
export interface ControlHost {
  /** The channel's own session id; `/back` returns here. */
  homeSessionId: string
  /** Attachable sessions, most relevant first. The host applies the filters. */
  listSessions(): Promise<SessionChoice[]>
  /** Does this exact session id exist (live or persisted)? */
  hasSession(id: string): Promise<boolean>
  /** Persist the new target so it survives a restart. */
  persistTarget(id: string | undefined): void
  log(level: 'info' | 'error' | 'debug', message: string): void
}

const COMMANDS = new Set(['help', 'list', 'where', 'back', 'use'])

/**
 * Short, human-typable form of a session id.
 *
 * Only `session-<uuid>` ids are truncated to their first uuid group; a named id
 * such as `wechat-clawbot` is returned unchanged (truncating on `-` would turn
 * it into `wechat`).
 */
export function shortId(id: string): string {
  if (!id.startsWith('session-')) return id
  const rest = id.slice('session-'.length)
  return rest.split('-')[0] ?? rest
}

function ageText(createdAt: number | undefined, now: number): string {
  if (!createdAt) return ''
  const ms = now - createdAt
  if (ms < 0) return ''
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export class SessionControl {
  #host: ControlHost
  #active: string
  /** Ids in the order shown by the last `/list`, for `/use <n>`. */
  #lastListed: string[] = []

  constructor(host: ControlHost, initial?: string) {
    this.#host = host
    const start = initial?.trim()
    this.#active = start && start.length > 0 ? start : host.homeSessionId
  }

  get activeSessionId(): string {
    return this.#active
  }

  get isHome(): boolean {
    return this.#active === this.#host.homeSessionId
  }

  get homeSessionId(): string {
    return this.#host.homeSessionId
  }

  /**
   * Intercept one inbound message.
   * Returns the reply when it was a control command, otherwise `undefined`
   * so the caller forwards the text to the agent.
   */
  async handle(text: string): Promise<string | undefined> {
    const raw = text.trim()
    if (!raw.startsWith('/')) return undefined

    const match = /^\/([a-zA-Z]+)\s*([\s\S]*)$/.exec(raw)
    if (!match) return undefined
    const command = (match[1] ?? '').toLowerCase()
    if (!COMMANDS.has(command)) return undefined
    const arg = (match[2] ?? '').trim()

    switch (command) {
      case 'help':
        return this.help()
      case 'where':
        return this.where()
      case 'back':
        return this.back()
      case 'list':
        return this.list(arg.toLowerCase() === 'all')
      case 'use':
        return this.use(arg)
      default:
        return undefined
    }
  }

  help(): string {
    const lines = [
      '微信 ↔ DSH 会话控制：',
      '',
      '/list          列出正在运行的会话',
      '/list all      列出全部会话（含已停止）',
      '/use <编号>    接入某个会话（编号来自 /list，也可用 id 前缀）',
      '/back          退回微信自己的会话',
      '/where         查看当前接入的是哪个会话',
      '/help          显示本帮助',
      '',
      `当前：${this.#describeActive()}`,
    ]
    lines.push('', '接入后，你在微信里发的消息会直接进入那个会话；', '在 DSH 界面里也能看到你发出的指令和 agent 的回复。')
    return lines.join('\n')
  }

  where(): string {
    return `当前接入：${this.#describeActive()}`
  }

  #describeActive(): string {
    if (this.isHome) return `${this.#active}（微信自己的会话）`
    return `${this.#active}（/back 可退回 ${this.#host.homeSessionId}）`
  }

  /** Return to the channel's own session. */
  back(): string {
    if (this.isHome) {
      return `本来就在微信自己的会话：${this.#host.homeSessionId}`
    }
    const previous = this.#active
    this.#active = this.#host.homeSessionId
    this.#host.persistTarget(undefined)
    this.#host.log('info', `session control: detached from ${previous}, back to ${this.#active}`)
    return `已退出 ${previous}\n现在回到：${this.#host.homeSessionId}`
  }

  /** Attach to another session. */
  async use(arg: string): Promise<string> {
    if (arg.length === 0) {
      return `用法：/use <编号 或 id 前缀>\n先用 /list 看看有哪些会话。`
    }

    const sessions = await this.#host.listSessions()

    // 1. A number from the last /list.
    if (/^\d+$/.test(arg)) {
      const index = Number.parseInt(arg, 10)
      const id = this.#lastListed[index - 1]
      if (id === undefined) {
        return `没有第 ${index} 项。先发 /list 重新列一遍。`
      }
      return this.#attach(id, sessions)
    }

    // 2. Exact id.
    const exact = sessions.find((s) => s.id === arg)
    if (exact) return this.#attach(exact.id, sessions)

    // 3. Unique prefix.
    const matches = sessions.filter((s) => s.id.startsWith(arg) || shortId(s.id).startsWith(arg))
    if (matches.length === 1) return this.#attach(matches[0]!.id, sessions)
    if (matches.length > 1) {
      return [
        `「${arg}」匹配到 ${matches.length} 个会话，请写长一点：`,
        ...matches.map((s) => `  ${shortId(s.id)}  ${s.title ?? ''}`.trimEnd()),
      ].join('\n')
    }

    // 4. An id that exists but is outside the listed window.
    if (await this.#host.hasSession(arg)) return this.#attach(arg, sessions)

    return `找不到匹配「${arg}」的会话。发 /list 看看有哪些。`
  }

  async #attach(id: string, sessions: SessionChoice[]): Promise<string> {
    if (id === this.#active) {
      return `已经接入这个会话了。\n${this.#describeActive()}`
    }

    this.#active = id
    this.#host.persistTarget(id)

    const known = sessions.find((s) => s.id === id)
    this.#host.log('info', `session control: attached to ${id} (live=${known?.live ?? 'unknown'})`)

    const lines = [`已接入：${id}`]
    if (known?.title) lines.push(`标题：${known.title}`)
    lines.push(
      known?.live === false
        ? '（这个会话当前没有在运行，下一条消息会把它唤醒）'
        : '（正在运行，你的消息会直接进入它）',
    )
    lines.push('', '发 /back 退回微信自己的会话。')
    return lines.join('\n')
  }

  /**
   * List attachable sessions.
   *
   * By default only RUNNING sessions are shown: the point of this command is to
   * remote-control something you are working in, and a run of stopped sessions
   * is just noise. `/list all` shows the rest.
   */
  async list(showAll = false): Promise<string> {
    let all: SessionChoice[]
    try {
      all = await this.#host.listSessions()
    } catch (err) {
      this.#host.log('error', `session control: /list failed: ${String(err)}`)
      return `列不出来：${String(err).slice(0, 200)}`
    }

    const sessions = showAll ? all : all.filter((s) => s.live)
    const idleCount = all.filter((s) => !s.live).length
    // How many sessions the host filtered out is logged, not messaged: it is
    // diagnostic detail, not something the user needs on their phone.
    this.#host.log(
      'debug',
      `session control: /list ${showAll ? 'all' : 'running'} — ` +
        `${all.length} attachable, ${idleCount} stopped`,
    )

    const footer = [`当前：${this.#describeActive()}`]

    if (sessions.length === 0) {
      this.#lastListed = []
      const lines = [showAll ? '没有可接入的会话。' : '现在没有正在运行的会话。']
      if (!showAll && all.length > 0) {
        lines.push(`另有 ${all.length} 个已停止的会话，发 /list all 查看。`)
      }
      lines.push('', ...footer)
      return lines.join('\n')
    }

    const now = Date.now()
    const lines: string[] = [showAll ? '可接入的会话：' : '正在运行的会话：', '']
    this.#lastListed = []

    sessions.forEach((s, i) => {
      this.#lastListed.push(s.id)
      const mark = s.live ? '●' : '○'
      const age = ageText(s.createdAt, now)
      const title = s.title?.trim() || '(无标题)'
      lines.push(`${i + 1}. ${mark} ${title}`)
      lines.push(`   /use ${i + 1}  ·  ${shortId(s.id)}${age ? `  ·  ${age}` : ''}`)
    })

    lines.push('')
    if (!showAll && idleCount > 0) {
      lines.push(`另有 ${idleCount} 个已停止的会话，发 /list all 查看。`)
    }
    if (showAll) {
      lines.push('● 正在运行（微信可直接接管）   ○ 已停止（接入会唤醒）')
    }
    lines.push(...footer)
    return lines.join('\n')
  }
}
