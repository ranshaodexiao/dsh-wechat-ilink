/**
 * WeChat CDN media transfer.
 *
 * Outbound: `getuploadurl` -> AES-128-ECB encrypt -> POST the ciphertext to the
 * CDN -> use the `x-encrypted-param` response header as `encrypt_query_param`.
 * Inbound: GET `/download?encrypted_query_param=...` -> AES-128-ECB decrypt.
 *
 * `aes_key` on the wire has two encodings; inbound decoding must accept both.
 */

import crypto from 'node:crypto'

import { CDN_BASE_URL } from './transport.js'
import type { CDNMedia } from './types.js'

/** Ciphertext length after PKCS7 padding. */
export function encryptedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

/** Random 16-byte key, hex encoded (32 chars). */
export function randomAesKeyHex(): string {
  return crypto.randomBytes(16).toString('hex')
}

/** Random 16-byte file key, hex encoded. */
export function randomFileKey(): string {
  return crypto.randomBytes(16).toString('hex')
}

export function md5Hex(data: Buffer): string {
  return crypto.createHash('md5').update(data).digest('hex')
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * Decode a wire `aes_key` into a raw 16-byte key.
 *
 * Accepts both encodings seen in the wild:
 *   A. base64(raw 16 bytes)
 *   B. base64(32-char hex string)
 * A bare 32-char hex string is also accepted.
 */
export function decodeAesKey(aesKey: string | undefined): Buffer | undefined {
  if (!aesKey) return undefined
  const trimmed = aesKey.trim()
  if (!trimmed) return undefined

  // Bare hex (32 chars) — as used by `image_item.aeskey`.
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }

  let decoded: Buffer
  try {
    decoded = Buffer.from(trimmed, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  return undefined
}

/**
 * Resolve the AES key for an inbound image, preferring `image_item.aeskey`
 * (already raw hex) over `media.aes_key`.
 */
export function resolveImageKey(image: {
  aeskey?: string
  media?: CDNMedia
}): Buffer | undefined {
  return decodeAesKey(image.aeskey) ?? decodeAesKey(image.media?.aes_key)
}

/** Encode a raw 16-byte key the way official clients do for outbound media. */
export function encodeAesKeyForWire(keyHex: string): string {
  return Buffer.from(keyHex, 'utf-8').toString('base64')
}

/** Identify an image type from its magic bytes. */
export function sniffImageMediaType(
  bytes: Buffer,
): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return 'image/gif'
  }
  return undefined
}

export interface CdnUploadResult {
  encryptQueryParam: string
  aesKeyHex: string
  fileKey: string
  cipherSize: number
}

export class CdnClient {
  #cdnBaseUrl: string
  #fetch: typeof fetch

  constructor(opts: { cdnBaseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.#cdnBaseUrl = opts.cdnBaseUrl?.trim() || CDN_BASE_URL
    this.#fetch = opts.fetchImpl ?? globalThis.fetch
  }

  /**
   * Upload ciphertext to the CDN and return the `x-encrypted-param` value.
   * `uploadFullUrl` (when the server provided one) takes precedence.
   */
  async upload(params: {
    encryptedQueryParam?: string
    fileKey: string
    uploadFullUrl?: string
    ciphertext: Buffer
    signal?: AbortSignal
  }): Promise<string> {
    const url = params.uploadFullUrl?.trim()
      ? params.uploadFullUrl.trim()
      : (() => {
          const base = this.#cdnBaseUrl.endsWith('/') ? this.#cdnBaseUrl : `${this.#cdnBaseUrl}/`
          const u = new URL('upload', base)
          u.searchParams.set('encrypted_query_param', params.encryptedQueryParam ?? '')
          u.searchParams.set('filekey', params.fileKey)
          return u.toString()
        })()

    const res = await this.#fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(params.ciphertext),
      ...(params.signal ? { signal: params.signal } : {}),
    })

    if (!res.ok) {
      const detail = res.headers.get('x-error-message') ?? ''
      throw new Error(`CDN upload HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    const param = res.headers.get('x-encrypted-param')
    if (!param) throw new Error('CDN upload succeeded but returned no x-encrypted-param header')
    return param
  }

  /** Download and AES-128-ECB decrypt one CDN object. */
  async download(params: {
    encryptQueryParam?: string
    fullUrl?: string
    aesKeyHex?: string
    signal?: AbortSignal
  }): Promise<Buffer> {
    const url = params.fullUrl?.trim()
      ? params.fullUrl.trim()
      : (() => {
          const base = this.#cdnBaseUrl.endsWith('/') ? this.#cdnBaseUrl : `${this.#cdnBaseUrl}/`
          const u = new URL('download', base)
          u.searchParams.set('encrypted_query_param', params.encryptQueryParam ?? '')
          return u.toString()
        })()

    const res = await this.#fetch(url, {
      method: 'GET',
      ...(params.signal ? { signal: params.signal } : {}),
    })
    if (!res.ok) throw new Error(`CDN download HTTP ${res.status}`)

    const ciphertext = Buffer.from(await res.arrayBuffer())
    const key = decodeAesKey(params.aesKeyHex)
    // Without a key the object is assumed to be stored in the clear.
    if (!key) return ciphertext
    try {
      return decryptAesEcb(ciphertext, key)
    } catch {
      // A wrong key or an unencrypted payload: fall back to the raw body.
      return ciphertext
    }
  }
}
