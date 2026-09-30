/**
 * Config schema for the WeChat ClawBot channel.
 *
 * DSH's Cordis loader validates a plugin's exported `Config` automatically via
 * `Config['~standard'].validate(raw)` (see `resolveConfig` in @deepseek-ai/cordis),
 * and validation must be synchronous.
 *
 * `@deepseek-ai/schemastery` is an OPTIONAL peer dependency: DSH provides it,
 * but this module must also import cleanly under plain Node (tests, CLI). When
 * schemastery is unavailable we fall back to a small hand-written Standard
 * Schema that mirrors the same defaults and constraints.
 */

/** Keys and their documented defaults, kept in one place. */
const DEFAULTS = {
  enabled: true,
  sessionId: 'wechat-clawbot',
  typing: true,
  typingKeepaliveMs: 5000,
  maxMessageChars: 2000,
  acceptImages: true,
  progressNotice: true,
  turnTimeoutMs: 300000,
  selfTestOnStart: false,
  selfTestDelayMs: 3000,
  logLevel: 'info',
} as const

const LOG_LEVELS = ['silent', 'error', 'info', 'debug'] as const

interface Issue {
  message: string
  path?: string[]
}

/** Compact Standard Schema used when schemastery is not resolvable. */
function fallbackSchema(): unknown {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-wechat-clawbot',
      validate(input: unknown) {
        if (input !== undefined && input !== null && typeof input !== 'object') {
          return { issues: [{ message: 'config must be an object' }] }
        }
        const raw = (input ?? {}) as Record<string, unknown>
        const issues: Issue[] = []

        const value: Record<string, unknown> = { ...DEFAULTS }

        for (const key of ['sessionId', 'cwd', 'provider', 'model', 'reasoningEffort'] as const) {
          const v = raw[key]
          if (v === undefined || v === null || v === '') continue
          if (typeof v !== 'string') {
            issues.push({ message: `${key} must be a string`, path: [key] })
            continue
          }
          value[key] = v
        }

        for (const key of ['enabled', 'typing', 'acceptImages', 'progressNotice', 'selfTestOnStart'] as const) {
          const v = raw[key]
          if (v === undefined || v === null) continue
          if (typeof v !== 'boolean') {
            issues.push({ message: `${key} must be a boolean`, path: [key] })
            continue
          }
          value[key] = v
        }

        for (const key of ['typingKeepaliveMs', 'maxMessageChars', 'turnTimeoutMs'] as const) {
          const v = raw[key]
          if (v === undefined || v === null) continue
          if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
            issues.push({ message: `${key} must be a positive number`, path: [key] })
            continue
          }
          value[key] = v
        }

        // Zero is meaningful here (run the self-test immediately).
        if (raw.selfTestDelayMs !== undefined && raw.selfTestDelayMs !== null) {
          const v = raw.selfTestDelayMs
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            issues.push({ message: 'selfTestDelayMs must be a number >= 0', path: ['selfTestDelayMs'] })
          } else {
            value.selfTestDelayMs = v
          }
        }

        const level = raw.logLevel
        if (level !== undefined && level !== null) {
          if (typeof level !== 'string' || !(LOG_LEVELS as readonly string[]).includes(level)) {
            issues.push({ message: `logLevel must be one of ${LOG_LEVELS.join(' | ')}`, path: ['logLevel'] })
          } else {
            value.logLevel = level
          }
        }

        const allowed = raw.allowedUserIds
        if (allowed !== undefined && allowed !== null) {
          if (!Array.isArray(allowed)) {
            issues.push({ message: 'allowedUserIds must be an array of strings', path: ['allowedUserIds'] })
          } else {
            value.allowedUserIds = allowed.filter((v): v is string => typeof v === 'string' && v !== '')
          }
        } else {
          value.allowedUserIds = []
        }

        return issues.length > 0 ? { issues, value } : { value }
      },
    },
  }
}

/**
 * The plugin's exported Config.
 *
 * Cordis validates this SYNCHRONOUSLY at registration time
 * (`runtime.Config['~standard'].validate(raw)`), so it cannot be built from a
 * dynamic `import()` of schemastery. The compact Standard Schema below is
 * therefore authoritative; `buildConfigSchema()` additionally exposes a
 * schemastery schema for the DSH settings UI when that module is present.
 */
export const Config = fallbackSchema()

/**
 * Build a schemastery-backed schema for richer settings-UI rendering.
 * Returns the compact schema when schemastery is not installed.
 */
export async function buildConfigSchema(): Promise<unknown> {
  try {
    // Indirect specifier: the package is an OPTIONAL peer supplied by DSH, so a
    // literal import() would fail type resolution in a plain checkout.
    const specifier = '@deepseek-ai/' + 'schemastery'
    const mod = (await import(specifier)) as { default?: SchemasteryLike }
    const Schema = mod.default
    if (!Schema || typeof Schema.object !== 'function') return Config

    return Schema.object({
      enabled: Schema.boolean().default(DEFAULTS.enabled),
      sessionId: Schema.string().default(DEFAULTS.sessionId),
      cwd: Schema.string(),
      provider: Schema.string(),
      model: Schema.string(),
      reasoningEffort: Schema.string(),
      allowedUserIds: Schema.array(Schema.string()).default([]),
      typing: Schema.boolean().default(DEFAULTS.typing),
      typingKeepaliveMs: Schema.number().default(DEFAULTS.typingKeepaliveMs),
      maxMessageChars: Schema.number().default(DEFAULTS.maxMessageChars),
      acceptImages: Schema.boolean().default(DEFAULTS.acceptImages),
      progressNotice: Schema.boolean().default(DEFAULTS.progressNotice),
      turnTimeoutMs: Schema.number().default(DEFAULTS.turnTimeoutMs),
      selfTestOnStart: Schema.boolean().default(DEFAULTS.selfTestOnStart),
      selfTestDelayMs: Schema.number().default(DEFAULTS.selfTestDelayMs),
      logLevel: Schema.union([...LOG_LEVELS]).default(DEFAULTS.logLevel),
    })
  } catch {
    return Config
  }
}

interface SchemasteryLike {
  object: (shape: Record<string, unknown>) => unknown
  string: () => { default: (v: string) => unknown }
  number: () => { default: (v: number) => unknown }
  boolean: () => { default: (v: boolean) => unknown }
  array: (inner: unknown) => { default: (v: unknown[]) => unknown }
  union: (values: readonly string[]) => { default: (v: string) => unknown }
}
