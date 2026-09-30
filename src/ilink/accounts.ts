/**
 * Credential and cursor persistence for the WeChat ClawBot channel.
 *
 * State lives under `<DSH_HOME>/clawbot/`:
 *   accounts.json                    — index of bound account ids
 *   accounts/<accountId>.json        — bot token, base url, bound user id
 *   accounts/<accountId>.sync.json   — opaque `get_updates_buf` cursor
 *
 * Credentials are written with mode 0600 where the platform supports it.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { WeixinAccountData } from '../ilink/types.js'

/** Resolve the channel state directory (respects `DSH_HOME`). */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim() || path.join(env.USERPROFILE ?? env.HOME ?? '.', '.dsh')
  return path.join(home, 'clawbot')
}

export class AccountStore {
  #dir: string
  #accountsDir: string

  constructor(stateDir?: string) {
    this.#dir = stateDir ?? resolveStateDir()
    this.#accountsDir = path.join(this.#dir, 'accounts')
  }

  get dir(): string {
    return this.#dir
  }

  #indexPath(): string {
    return path.join(this.#dir, 'accounts.json')
  }

  #accountPath(accountId: string): string {
    return path.join(this.#accountsDir, `${accountId}.json`)
  }

  #syncPath(accountId: string): string {
    return path.join(this.#accountsDir, `${accountId}.sync.json`)
  }

  /** All bound account ids, oldest first. */
  listAccountIds(): string[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#indexPath(), 'utf-8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    } catch {
      return []
    }
  }

  registerAccountId(accountId: string): void {
    fs.mkdirSync(this.#dir, { recursive: true })
    const existing = this.listAccountIds()
    if (existing.includes(accountId)) return
    fs.writeFileSync(this.#indexPath(), JSON.stringify([...existing, accountId], null, 2), 'utf-8')
  }

  unregisterAccountId(accountId: string): void {
    const existing = this.listAccountIds()
    const updated = existing.filter((id) => id !== accountId)
    if (updated.length !== existing.length) {
      fs.mkdirSync(this.#dir, { recursive: true })
      fs.writeFileSync(this.#indexPath(), JSON.stringify(updated, null, 2), 'utf-8')
    }
  }

  load(accountId: string): WeixinAccountData | null {
    try {
      return JSON.parse(fs.readFileSync(this.#accountPath(accountId), 'utf-8')) as WeixinAccountData
    } catch {
      return null
    }
  }

  /** Persist credentials, merging into any existing record. */
  save(
    accountId: string,
    update: { token?: string; baseUrl?: string; userId?: string },
  ): void {
    fs.mkdirSync(this.#accountsDir, { recursive: true })
    const existing = this.load(accountId) ?? {}

    const token = update.token?.trim() || existing.token
    const baseUrl = update.baseUrl?.trim() || existing.baseUrl
    const userId =
      update.userId !== undefined
        ? update.userId.trim() || undefined
        : existing.userId?.trim() || undefined

    const data: WeixinAccountData = {
      ...(token ? { token, savedAt: new Date().toISOString() } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(userId ? { userId } : {}),
    }

    const file = this.#accountPath(accountId)
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Best effort; Windows ACLs do not map onto POSIX modes.
    }
  }

  /** Remove credentials and cursors for one account. */
  clear(accountId: string): void {
    for (const file of [
      this.#accountPath(accountId),
      this.#syncPath(accountId),
    ]) {
      try {
        fs.unlinkSync(file)
      } catch {
        // Already gone.
      }
    }
    this.unregisterAccountId(accountId)
  }

  loadSyncBuf(accountId: string): string {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#syncPath(accountId), 'utf-8')) as {
        get_updates_buf?: string
      }
      return typeof parsed.get_updates_buf === 'string' ? parsed.get_updates_buf : ''
    } catch {
      return ''
    }
  }

  saveSyncBuf(accountId: string, getUpdatesBuf: string): void {
    fs.mkdirSync(this.#accountsDir, { recursive: true })
    const file = this.#syncPath(accountId)
    fs.writeFileSync(file, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 2), 'utf-8')
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Best effort.
    }
  }

  clearSyncBuf(accountId: string): void {
    try {
      fs.unlinkSync(this.#syncPath(accountId))
    } catch {
      // Already gone.
    }
  }
}
