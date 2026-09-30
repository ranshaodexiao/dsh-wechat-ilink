/**
 * Channel configuration.
 *
 * Declared without a hard dependency on `@deepseek-ai/schemastery` so the
 * package stays loadable in a plain Node context (tests, CLI). The DSH row
 * supplies this same shape; see `src/index.ts` for the interpreted fields.
 */

import type { NormalizedInbound } from './ilink/message.js'

export interface ChannelConfig {
  /** Master switch for the channel. */
  enabled: boolean
  /** DSH session id reused for the WeChat conversation. */
  sessionId?: string
  /** Working directory for sessions created by the channel. */
  cwd?: string
  /** Pin the model for channel sessions; empty follows the DSH default. */
  provider?: string
  model?: string
  reasoningEffort?: string
  /** WeChat user ids allowed to talk to the bot; empty means "the bound account only". */
  allowedUserIds?: string[]
  /** Send a typing indicator while a turn runs. */
  typing: boolean
  /** Re-send typing every N ms while a turn runs (keepalive). */
  typingKeepaliveMs: number
  /** Maximum characters per outbound WeChat message. */
  maxMessageChars: number
  /** Download inbound images and hand them to the model as image blocks. */
  acceptImages: boolean
  /** Send a short acknowledgement while a turn is running. */
  progressNotice: boolean
  /** Milliseconds to wait for a turn before giving up. */
  turnTimeoutMs: number
  /**
   * On startup, run one synthetic turn through the DSH agent path and log the
   * outcome. This turns "does the agent bridge work?" from an unknown into a
   * logged fact without needing an inbound WeChat message.
   *
   * It costs one model call per start and uses a separate session id, so it
   * never pollutes the real WeChat conversation. Default false.
   */
  selfTestOnStart: boolean
  /** Delay before the startup self-test, letting DSH finish wiring services. */
  selfTestDelayMs: number
  /** Log verbosity: 'silent' | 'error' | 'info' | 'debug'. */
  logLevel: 'silent' | 'error' | 'info' | 'debug'
}

export const DEFAULT_CONFIG: ChannelConfig = {
  enabled: true,
  typing: true,
  typingKeepaliveMs: 5_000,
  maxMessageChars: 2000,
  acceptImages: true,
  progressNotice: true,
  turnTimeoutMs: 300_000,
  selfTestOnStart: false,
  selfTestDelayMs: 3_000,
  logLevel: 'info',
}

export function resolveConfig(raw: Partial<ChannelConfig> | undefined): ChannelConfig {
  const merged = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  const allowed = Array.isArray(merged.allowedUserIds)
    ? merged.allowedUserIds.filter(
        (id): id is string => typeof id === 'string' && id.trim() !== '',
      )
    : []
  return {
    ...merged,
    enabled: merged.enabled !== false,
    typing: merged.typing !== false,
    acceptImages: merged.acceptImages !== false,
    progressNotice: merged.progressNotice !== false,
    selfTestOnStart: merged.selfTestOnStart === true,
    selfTestDelayMs:
      Number.isFinite(merged.selfTestDelayMs) && merged.selfTestDelayMs >= 0
        ? merged.selfTestDelayMs
        : DEFAULT_CONFIG.selfTestDelayMs,
    typingKeepaliveMs:
      Number.isFinite(merged.typingKeepaliveMs) && merged.typingKeepaliveMs > 0
        ? merged.typingKeepaliveMs
        : DEFAULT_CONFIG.typingKeepaliveMs,
    maxMessageChars:
      Number.isFinite(merged.maxMessageChars) && merged.maxMessageChars > 0
        ? merged.maxMessageChars
        : DEFAULT_CONFIG.maxMessageChars,
    turnTimeoutMs:
      Number.isFinite(merged.turnTimeoutMs) && merged.turnTimeoutMs > 0
        ? merged.turnTimeoutMs
        : DEFAULT_CONFIG.turnTimeoutMs,
    allowedUserIds: allowed,
  }
}

/** Decide whether an inbound sender is allowed to drive the agent. */
export function isSenderAllowed(
  config: ChannelConfig,
  params: { fromUserId: string | undefined; boundUserId: string | undefined },
): boolean {
  const from = params.fromUserId?.trim()
  if (!from) return false
  const allowed = config.allowedUserIds ?? []
  if (allowed.length > 0) {
    return allowed.includes(from)
  }
  // Default deny-by-default: only the WeChat account that scanned the QR code.
  const bound = params.boundUserId?.trim()
  return Boolean(bound) && from === bound
}

/** Render the prompt DSH receives, including attachment caveats. */
export function buildPrompt(normalized: NormalizedInbound): string {
  return normalized.text
}
