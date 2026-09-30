/**
 * WeChat ClawBot (Tencent iLink) protocol types.
 *
 * Mirrors the wire format documented in Tencent's MIT-licensed
 * `@tencent-weixin/openclaw-weixin` (protocol v2.4.x).
 *
 * The API is JSON over HTTP; bytes fields are base64 strings in JSON.
 */

/** `base_info` attached to every business request. */
export interface BaseInfo {
  channel_version?: string
  /**
   * Self-declared bot identity, analogous to an HTTP User-Agent.
   * Observability only — never used for auth or routing.
   */
  bot_agent?: string
}

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const

export interface TextItem {
  text?: string
}

/** CDN media reference; `aes_key` is base64-encoded bytes in JSON. */
export interface CDNMedia {
  encrypt_query_param?: string
  aes_key?: string
  /** 0 = only the file id is encrypted; 1 = thumbnails packed in. */
  encrypt_type?: number
  /** Server-provided complete download URL. */
  full_url?: string
}

export interface ImageItem {
  media?: CDNMedia
  thumb_media?: CDNMedia
  /** Raw AES-128 key as a 32-char hex string; preferred over media.aes_key. */
  aeskey?: string
  url?: string
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
}

export interface VoiceItem {
  media?: CDNMedia
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number
  bits_per_sample?: number
  sample_rate?: number
  playtime?: number
  /** Server-side speech-to-text transcript. */
  text?: string
}

export interface FileItem {
  media?: CDNMedia
  file_name?: string
  md5?: string
  /** Plaintext file size, as a string. */
  len?: string
}

export interface VideoItem {
  media?: CDNMedia
  video_size?: number
  play_length?: number
  video_md5?: string
  thumb_media?: CDNMedia
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
}

export interface MessageItem {
  type?: number
  create_time_ms?: number
  update_time_ms?: number
  is_completed?: boolean
  msg_id?: string
  ref_msg?: RefMessage
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
}

export interface RefMessage {
  message_item?: MessageItem
  title?: string
  /** Server message id, used when newer clients omit the quoted body. */
  message_id?: string | number
}

export interface WeixinMessage {
  seq?: number
  /** Server message id. Quote before parsing: it can exceed 2^53. */
  message_id?: string | number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  update_time_ms?: number
  delete_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  /** Conversation capability token; MUST be echoed when replying. */
  context_token?: string
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface SendMessageReq {
  msg?: WeixinMessage
}

export interface SendMessageResp {
  ret?: number
  errcode?: number
  errmsg?: string
  message_id?: string | number
}

export interface GetConfigResp {
  ret?: number
  errcode?: number
  errmsg?: string
  typing_ticket?: string
}

export interface SendTypingReq {
  ilink_user_id?: string
  typing_ticket?: string
  /** 1 = start/keep typing, 2 = cancel. */
  status?: number
}

export interface GetUploadUrlReq {
  filekey?: string
  media_type?: number
  to_user_id?: string
  rawsize?: number
  rawfilemd5?: string
  filesize?: number
  thumb_rawsize?: number
  thumb_rawfilemd5?: string
  thumb_filesize?: number
  no_need_thumb?: boolean
  aeskey?: string
}

export interface GetUploadUrlResp {
  upload_param?: string
  thumb_upload_param?: string
  upload_full_url?: string
}

/** Persisted QR-login credentials for one bot account. */
export interface WeixinAccountData {
  token?: string
  savedAt?: string
  baseUrl?: string
  accountId?: string
  userId?: string
}
