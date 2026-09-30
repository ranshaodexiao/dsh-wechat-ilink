/**
 * Inbound image tests: CDN download -> AES decrypt -> prompt image blocks.
 *
 * Fully offline. Covers the two `aes_key` encodings, format sniffing, the
 * attachments service contract, and every degradation path (no attachments
 * service, refused save, unrecognized format).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CdnClient, encryptAesEcb, sniffImageMediaType } from '../lib/ilink/cdn.js'
import { normalizeInbound } from '../lib/ilink/message.js'
import { DshBridge } from '../lib/bridge.js'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A tiny but structurally valid PNG-looking payload. */
function pngBytes(extra = 16) {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(extra, 0x42)])
}

// ---------------------------------------------------------------------------
// CDN download + decryption
// ---------------------------------------------------------------------------

test('CdnClient downloads and decrypts an encrypted image', async () => {
  const keyHex = '00112233445566778899aabbccddeeff'
  const plaintext = pngBytes()
  const ciphertext = encryptAesEcb(plaintext, Buffer.from(keyHex, 'hex'))

  const fetchImpl = async () => new Response(new Uint8Array(ciphertext), { status: 200 })

  const cdn = new CdnClient({ cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c', fetchImpl })
  const out = await cdn.download({ encryptQueryParam: 'AAFFquery==', aesKeyHex: keyHex })

  assert.deepEqual(out, plaintext)
  assert.equal(sniffImageMediaType(out), 'image/png')
})

test('CdnClient accepts a base64(hex) aes_key', async () => {
  const keyHex = 'ffeeddccbbaa99887766554433221100'
  const plaintext = pngBytes()
  const ciphertext = encryptAesEcb(plaintext, Buffer.from(keyHex, 'hex'))
  // Format B: base64 of the 32-char hex STRING.
  const formatB = Buffer.from(keyHex, 'utf8').toString('base64')

  const fetchImpl = async () => new Response(new Uint8Array(ciphertext), { status: 200 })
  const cdn = new CdnClient({ cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c', fetchImpl })

  const out = await cdn.download({ encryptQueryParam: 'q', aesKeyHex: formatB })
  assert.deepEqual(out, plaintext)
})

test('CdnClient falls back to raw bytes when the key is wrong', async () => {
  const plaintext = pngBytes()
  const ciphertext = encryptAesEcb(plaintext, Buffer.from('00112233445566778899aabbccddeeff', 'hex'))
  const fetchImpl = async () => new Response(new Uint8Array(ciphertext), { status: 200 })
  const cdn = new CdnClient({ cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c', fetchImpl })

  // A different 16-byte key: decryption fails, so the raw body is returned.
  const out = await cdn.download({ encryptQueryParam: 'q', aesKeyHex: 'ffffffffffffffffffffffffffffffff' })
  assert.deepEqual(out, ciphertext)
})

test('CdnClient surfaces a CDN download failure', async () => {
  const fetchImpl = async () => new Response('nope', { status: 403 })
  const cdn = new CdnClient({ cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c', fetchImpl })
  await assert.rejects(() => cdn.download({ encryptQueryParam: 'q' }), /CDN download HTTP 403/)
})

// ---------------------------------------------------------------------------
// normalizeInbound image references
// ---------------------------------------------------------------------------

test('normalizeInbound collects every image reference field', () => {
  const result = normalizeInbound({
    item_list: [
      {
        type: 2,
        image_item: {
          aeskey: '00112233445566778899aabbccddeeff',
          media: { encrypt_query_param: 'QP', full_url: 'https://cdn.example/x' },
          mid_size: 999,
        },
      },
    ],
  })

  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].aesKeyHex, '00112233445566778899aabbccddeeff')
  assert.equal(result.images[0].encryptQueryParam, 'QP')
  assert.equal(result.images[0].fullUrl, 'https://cdn.example/x')
  assert.equal(result.images[0].midSize, 999)
})

test('normalizeInbound keeps an image caption in the text', () => {
  const result = normalizeInbound({
    item_list: [
      { type: 1, text_item: { text: 'what is this' } },
      { type: 2, image_item: { media: { encrypt_query_param: 'QP' } } },
    ],
  })
  assert.equal(result.text, 'what is this')
  assert.equal(result.images.length, 1)
})

test('normalizeInbound reports a malformed image item without throwing', () => {
  const result = normalizeInbound({ item_list: [{ type: 2 }] })
  assert.equal(result.images.length, 0)
  assert.ok(result.text.length > 0)
})

// ---------------------------------------------------------------------------
// Bridge: image content blocks
// ---------------------------------------------------------------------------

function fakeAgent() {
  const events = []
  const calls = { followup: [] }
  return {
    agent: {
      id: 's',
      session: {
        get seq() {
          return events.length
        },
        snapshotEvents: (from = 0) => events.slice(from),
      },
      followup(message) {
        calls.followup.push(message)
        events.push({
          type: 'assistant/message',
          seq: events.length + 1,
          data: {
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            stream: [],
          },
        })
      },
      async whenIdle() {},
      cancel() {},
    },
    calls,
    events,
  }
}

function baseCtx(agent, overrides = {}) {
  const saved = []
  return {
    ctx: {
      agents: {
        get: () => agent,
        create: async () => ({ agent, dispose: async () => {} }),
      },
      sessions: { flush: async () => true },
      attachments: {
        async saveImages(inputs) {
          saved.push(...inputs)
          return inputs.map((input, i) => ({
            attachmentId: `att-${i}`,
            mediaType: input.mediaType,
            bytes: input.data.length,
            width: 1,
            height: 1,
            ...(input.name ? { name: input.name } : {}),
          }))
        },
      },
      ...overrides,
    },
    saved,
  }
}

const createUserMessage = (input) => ({ ...input, id: 'm' })

test('DshBridge attaches images as image content blocks', async () => {
  const { agent, calls } = fakeAgent()
  const { ctx, saved } = baseCtx(agent)
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  await bridge.prompt('look', [{ data: pngBytes(), mediaType: 'image/png', name: 'wechat-1' }])

  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')

  const content = calls.followup[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, 'look')
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].attachment.attachmentId, 'att-0')
})

test('DshBridge handles image-only prompts without a text block', async () => {
  const { agent, calls } = fakeAgent()
  const { ctx } = baseCtx(agent)
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  await bridge.prompt('', [{ data: pngBytes(), mediaType: 'image/png' }])

  const content = calls.followup[0].content
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'image')
})

test('DshBridge never sends an empty content array', async () => {
  const { agent, calls } = fakeAgent()
  const { ctx } = baseCtx(agent)
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  await bridge.prompt('   ', [])
  const content = calls.followup[0].content
  assert.ok(content.length > 0)
  assert.equal(content[0].type, 'text')
})

test('DshBridge degrades to text when ctx.attachments is missing', async () => {
  const { agent, calls } = fakeAgent()
  const ctx = {
    agents: { get: () => agent, create: async () => ({ agent, dispose: async () => {} }) },
    sessions: { flush: async () => true },
    // no attachments service
  }
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  const result = await bridge.prompt('look', [{ data: pngBytes(), mediaType: 'image/png' }])

  assert.equal(result.text, 'ok')
  const content = calls.followup[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'text')
  assert.ok(content[1].text.length > 0)
})

test('DshBridge reports a refused image save and still runs the turn', async () => {
  const { agent, calls } = fakeAgent()
  const { ctx } = baseCtx(agent, {
    attachments: {
      async saveImages() {
        throw new Error('image too large')
      },
    },
  })
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  const result = await bridge.prompt('look', [{ data: pngBytes(), mediaType: 'image/png' }])

  assert.equal(result.text, 'ok')
  const content = calls.followup[0].content
  assert.match(content[1].text, /image too large/)
})

test('DshBridge attaches multiple images in order', async () => {
  const { agent, calls } = fakeAgent()
  const { ctx } = baseCtx(agent)
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })

  await bridge.prompt('two', [
    { data: pngBytes(8), mediaType: 'image/png' },
    { data: pngBytes(24), mediaType: 'image/jpeg' },
  ])

  const content = calls.followup[0].content
  assert.equal(content.length, 3)
  assert.equal(content[1].attachment.attachmentId, 'att-0')
  assert.equal(content[2].attachment.attachmentId, 'att-1')
})

// ---------------------------------------------------------------------------
// End-to-end: encrypted CDN bytes -> bridge -> image block
// ---------------------------------------------------------------------------

test('an encrypted WeChat image travels end to end into a prompt block', async () => {
  const keyHex = '00112233445566778899aabbccddeeff'
  const original = pngBytes(32)
  const ciphertext = encryptAesEcb(original, Buffer.from(keyHex, 'hex'))

  const fetchImpl = async () => new Response(new Uint8Array(ciphertext), { status: 200 })
  const cdn = new CdnClient({ cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c', fetchImpl })

  // 1. normalize the inbound WeChat message
  const normalized = normalizeInbound({
    item_list: [
      { type: 1, text_item: { text: 'look at this' } },
      { type: 2, image_item: { aeskey: keyHex, media: { encrypt_query_param: 'QP' } } },
    ],
  })

  // 2. download + decrypt + sniff, exactly as the channel does
  const ref = normalized.images[0]
  const bytes = await cdn.download({
    encryptQueryParam: ref.encryptQueryParam,
    aesKeyHex: ref.aesKeyHex,
  })
  const mediaType = sniffImageMediaType(bytes)
  assert.equal(mediaType, 'image/png')
  assert.deepEqual(bytes, original)

  // 3. hand it to the bridge
  const { agent, calls } = fakeAgent()
  const { ctx } = baseCtx(agent)
  const bridge = new DshBridge({ ctx, sessionId: 's', createUserMessage })
  await bridge.prompt(normalized.text, [{ data: bytes, mediaType }])

  const content = calls.followup[0].content
  assert.equal(content[0].text, 'look at this')
  assert.equal(content[1].type, 'image')
})
