/**
 * Levelled logger for the channel, with an optional durable file sink.
 *
 * The file sink matters: a plugin loaded inside DSH has no readable stderr, so
 * without a log on disk a live failure is invisible and has to be guessed at.
 * Every line the channel emits is also appended to `<state dir>/channel.log`.
 */

import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'silent' | 'error' | 'info' | 'debug'

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 }

/** Cap before the log is trimmed; keeps a long-running channel bounded. */
const MAX_LOG_BYTES = 2 * 1024 * 1024
/** How much recent history to keep when trimming. */
const TRIM_TO_BYTES = 512 * 1024

export class Logger {
  #level: LogLevel
  #tag: string
  #sink: (line: string) => void
  #recent: string[] = []
  #filePath: string | undefined

  constructor(
    level: LogLevel = 'info',
    tag = 'wechat-clawbot',
    sink?: (line: string) => void,
    filePath?: string,
  ) {
    this.#level = level
    this.#tag = tag
    this.#sink = sink ?? ((line) => process.stderr.write(`${line}\n`))
    this.#filePath = filePath
    if (filePath) this.#prepareFile(filePath)
  }

  /** Point the logger at a durable log file (idempotent). */
  setFile(filePath: string): void {
    this.#filePath = filePath
    this.#prepareFile(filePath)
  }

  get filePath(): string | undefined {
    return this.#filePath
  }

  /** Create the directory and trim the log if it has grown too large. */
  #prepareFile(filePath: string): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_BYTES) {
        const content = fs.readFileSync(filePath)
        fs.writeFileSync(filePath, content.subarray(content.length - TRIM_TO_BYTES))
      }
    } catch {
      // Logging must never break the channel.
    }
  }

  #appendToFile(line: string): void {
    if (!this.#filePath) return
    try {
      fs.appendFileSync(this.#filePath, `${line}\n`, 'utf-8')
    } catch {
      // Disk problems must never break the channel.
    }
  }

  setLevel(level: LogLevel): void {
    this.#level = level
  }

  /** Tail of recent log lines, for status reporting. */
  tail(count = 50): string[] {
    return this.#recent.slice(-count)
  }

  #write(level: Exclude<LogLevel, 'silent'>, message: string): void {
    if (ORDER[this.#level] < ORDER[level]) return
    const line = `${new Date().toISOString()} [${this.#tag}] ${level.toUpperCase()} ${message}`
    this.#recent.push(line)
    if (this.#recent.length > 500) this.#recent.splice(0, this.#recent.length - 500)
    this.#sink(line)
    this.#appendToFile(line)
  }

  error(message: string): void {
    this.#write('error', message)
  }

  info(message: string): void {
    this.#write('info', message)
  }

  debug(message: string): void {
    this.#write('debug', message)
  }

  /**
   * Log an error with its stack, so a live failure is diagnosable after the
   * fact. `String(err)` alone loses the frames that identify the cause.
   */
  errorDetail(message: string, err: unknown): void {
    const detail =
      err instanceof Error && err.stack
        ? err.stack
        : String(err)
    this.error(`${message}: ${detail}`)
  }
}

/** Read the tail of a log file written by {@link Logger}. */
export function readLogTail(filePath: string, lines = 100): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const all = content.split('\n').filter((l) => l.length > 0)
    return all.slice(-lines)
  } catch {
    return []
  }
}

/** Redact a bearer token for logging. */
export function redactToken(token: string | undefined): string {
  if (!token) return '(none)'
  if (token.length <= 8) return '***'
  return `${token.slice(0, 4)}***${token.slice(-2)}`
}
