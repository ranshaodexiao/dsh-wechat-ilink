/**
 * Inbound message normalisation and outbound text shaping.
 *
 * Inbound: flatten a WeChat `WeixinMessage`'s `item_list` into one prompt plus
 * optional image references. Quoted (`ref_msg`) content is folded in as context.
 * Outbound: split long replies on natural boundaries for the WeChat client.
 */

import type { MessageItem, WeixinMessage } from './types.js'

/** Conservative per-message character budget used by the WeChat client. */
export const MAX_TEXT_CHARS = 2000

export interface InboundImageRef {
  /** `image_item.aeskey` (raw hex) or `media.aes_key`. */
  aesKeyHex?: string
  encryptQueryParam?: string
  fullUrl?: string
  midSize?: number
}

export interface NormalizedInbound {
  /** The composed prompt text (may be empty when only media was sent). */
  text: string
  images: InboundImageRef[]
  /** Transcribed voice text folded into `text`, when the server supplied it. */
  voiceTranscript?: string
  /** Human-readable notes about parts that could not be used. */
  skipped: string[]
}

function refMessageText(item: MessageItem): string | undefined {
  const ref = item.ref_msg
  if (!ref) return undefined
  const inner = ref.message_item
  if (inner?.text_item?.text?.trim()) return inner.text_item.text.trim()
  if (ref.title?.trim()) return ref.title.trim()
  return undefined
}

/**
 * Flatten one inbound message into a prompt.
 *
 * Text items are joined in order. Voice uses the server-side transcript only
 * (the plugin does not perform speech recognition). Images are returned as
 * references for the caller to download.
 */
export function normalizeInbound(message: WeixinMessage): NormalizedInbound {
  const parts: string[] = []
  const images: InboundImageRef[] = []
  const skipped: string[] = []
  let voiceTranscript: string | undefined

  for (const item of message.item_list ?? []) {
    switch (item.type) {
      case 1: {
        const text = item.text_item?.text
        if (text && text.trim()) {
          const quoted = refMessageText(item)
          parts.push(quoted ? `${text.trim()}\n\n[引用] ${quoted}` : text.trim())
        } else {
          const quoted = refMessageText(item)
          if (quoted) parts.push(`[引用] ${quoted}`)
        }
        break
      }

      case 2: {
        const img = item.image_item
        if (!img) {
          skipped.push('图片（缺少 image_item）')
          break
        }
        images.push({
          ...(img.aeskey ? { aesKeyHex: img.aeskey } : {}),
          ...(img.media?.encrypt_query_param
            ? { encryptQueryParam: img.media.encrypt_query_param }
            : {}),
          ...(img.media?.full_url ? { fullUrl: img.media.full_url } : {}),
          ...(img.mid_size !== undefined ? { midSize: img.mid_size } : {}),
        })
        const caption = item.text_item?.text?.trim()
        if (caption) parts.push(caption)
        break
      }

      case 3: {
        const transcript = item.voice_item?.text?.trim()
        if (transcript) {
          voiceTranscript = transcript
          parts.push(transcript)
        } else {
          skipped.push('语音（微信未提供转写，请改用文字）')
        }
        break
      }

      case 4:
        skipped.push(`文件${item.file_item?.file_name ? `「${item.file_item.file_name}」` : ''}（暂不支持）`)
        break

      case 5:
        skipped.push('视频（暂不支持）')
        break

      case 11:
      case 12:
        // Tool-call items are bot-side bookkeeping, never user input.
        break

      default:
        break
    }
  }

  const joined = parts.join('\n\n').trim()
  const note = skipped.length > 0 ? `\n\n[附件未处理：${skipped.join('；')}]` : ''

  return {
    text: `${joined}${note}`.trim(),
    images,
    ...(voiceTranscript ? { voiceTranscript } : {}),
    skipped,
  }
}

/**
 * Split a long reply into WeChat-sized chunks, preferring paragraph then line
 * then word boundaries. Each chunk is at most `limit` characters.
 */
export function splitOutboundText(text: string, limit = MAX_TEXT_CHARS): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized.length <= limit) return normalized.length > 0 ? [normalized] : []

  const chunks: string[] = []
  let remaining = normalized

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n')
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = limit

    chunks.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).replace(/^\n+/, '')
  }

  if (remaining.trim().length > 0) chunks.push(remaining.trimEnd())
  return chunks.filter((c) => c.length > 0)
}

/** Unique, sortable outbound client id. */
export function newClientId(): string {
  return `dsh-clawbot:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
