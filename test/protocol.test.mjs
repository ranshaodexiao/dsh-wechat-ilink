/**
 * Protocol-layer tests: transport, CDN crypto, message normalisation, login.
 * Fully offline — `fetch` is always a mock.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { MockServer, inboundTextMessage, makeTempStateDir } from './helpers.mjs'
import {
  ILinkClient,
  SessionExpiredError,
  buildClientVersion,
  parseWeixinApiJson,
  sanitizeBotAgent,
} from '../lib/ilink/transport.js'
import {
  decodeAesKey,
  encryptAesEcb,
  decryptAesEcb,
  encryptedSize,
  resolveImageKey,
  sniffImageMediaType,
} from '../lib/ilink/cdn.js'
import {
  normalizeInbound,
  newClientId,
  splitOutboundText,
} from '../lib/ilink/message.js'
import { AccountStore } from '../lib/ilink/accounts.js'
import { QrLoginManager } from '../lib/ilink/login.js'
import { OutboundSender } from '../lib/outbound.js'

// ---------------------------------------------------------------------------
// Header / version helpers
// ---------------------------------------------------------------------------

test('buildClientVersion encodes major.minor.patch as 0x00MMNNPP', () => {
  assert.equal(buildClientVersion('1.0.11'), 0x0001000b)
  assert.equal(buildClientVersion('2.4.9'), (2 << 16) | (4 << 8) | 9)
  assert.equal(buildClientVersion('0.0.0'), 0)
  assert.equal(buildClientVersion('garbage'), 0)
})

test('sanitizeBotAgent enforces the UA-style grammar', () => {
  assert.equal(sanitizeBotAgent('MyBot/1.2.0'), 'MyBot/1.2.0')
  assert.equal(sanitizeBotAgent('MyBot/1.2.0 (region=cn;env=prod)'), 'MyBot/1.2.0 (region=cn;env=prod)')
  assert.equal(sanitizeBotAgent('MyBot/1.2.0 LangChain/0.3.5'), 'MyBot/1.2.0 LangChain/0.3.5')
  // Tokens without a "/" are dropped; empty result falls back to the default.
  assert.equal(sanitizeBotAgent('not-a-product'), 'DSH-ClawBot')
  assert.equal(sanitizeBotAgent(undefined), 'DSH-ClawBot')
  assert.equal(sanitizeBotAgent('   '), 'DSH-ClawBot')
})

test('parseWeixinApiJson keeps uint64 message ids lossless', () => {
  const raw = '{"message_id":9812451782375481234,"text":"x","seq":429}'
  const parsed = parseWeixinApiJson(raw)
  assert.equal(parsed.message_id, '9812451782375481234')
  assert.equal(parsed.seq, 429)

  // Ids inside string values must not be rewritten.
  const raw2 = '{"nomessage_id":"9812451782375481234","message_id":12}'
  const parsed2 = parseWeixinApiJson(raw2)
  assert.equal(parsed2.nomessage_id, '9812451782375481234')
  assert.equal(parsed2.message_id, '12')
})

// ---------------------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------------------

test('getUpdates sends the documented headers and body shape', async () => {
  const server = new MockServer().on('getupdates', () => ({
    body: { ret: 0, msgs: [], get_updates_buf: 'buf-1' },
  }))
  const client = new ILinkClient({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'tok-abc',
    channelVersion: '2.4.9',
    botAgent: 'DSH/0.1.0',
    appId: 'bot',
    fetchImpl: server.fetchImpl,
  })

  const resp = await client.getUpdates({ getUpdatesBuf: '' })
  assert.equal(resp.ret, 0)
  assert.equal(resp.get_updates_buf, 'buf-1')

  const req = server.lastRequest('getupdates')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers['authorizationtype'], 'ilink_bot_token')
  assert.equal(req.headers['authorization'], 'Bearer tok-abc')
  assert.equal(req.headers['content-type'], 'application/json')
  assert.equal(req.headers['ilink-app-id'], 'bot')
  assert.equal(req.headers['ilink-app-clientversion'], String(buildClientVersion('2.4.9')))
  assert.ok(req.headers['x-wechat-uin'], 'X-WECHAT-UIN must be present')

  // X-WECHAT-UIN must be base64 of a decimal uint32.
  const decoded = Buffer.from(req.headers['x-wechat-uin'], 'base64').toString('utf8')
  assert.match(decoded, /^\d+$/)

  assert.equal(req.body.get_updates_buf, '')
  assert.equal(req.body.base_info.channel_version, '2.4.9')
  assert.equal(req.body.base_info.bot_agent, 'DSH/0.1.0')
})

test('getUpdates treats a client-side timeout as an empty batch', async () => {
  // Never resolves on its own; the long-poll timeout must convert this into ret:0.
  // The abort listener rejects so no promise is left dangling for the test runner.
  const hangingFetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const fail = () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      }
      if (init?.signal?.aborted) fail()
      else init?.signal?.addEventListener('abort', fail, { once: true })
    })

  const client = new ILinkClient({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'tok',
    fetchImpl: hangingFetch,
  })

  const resp = await client.getUpdates({ getUpdatesBuf: 'cursor-x', timeoutMs: 50 })
  assert.equal(resp.ret, 0)
  assert.deepEqual(resp.msgs, [])
  // The cursor must be preserved so the next poll resumes correctly.
  assert.equal(resp.get_updates_buf, 'cursor-x')
})

test('getUpdates raises SessionExpiredError on errcode -14', async () => {
  const server = new MockServer().on('getupdates', () => ({
    body: { ret: -14, errcode: -14, errmsg: 'session timeout' },
  }))
  const client = new ILinkClient({ token: 'tok', fetchImpl: server.fetchImpl })

  await assert.rejects(
    () => client.getUpdates({ getUpdatesBuf: '' }),
    (err) => err instanceof SessionExpiredError,
  )
})

test('sendMessage echoes context_token and uses BOT/FINISH', async () => {
  const server = new MockServer().on('sendmessage', () => ({ body: { ret: 0 } }))
  const client = new ILinkClient({ token: 'tok', fetchImpl: server.fetchImpl })

  await client.sendMessage({
    msg: {
      to_user_id: 'user@im.wechat',
      client_id: 'c1',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-token-value',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    },
  })

  const req = server.lastRequest('sendmessage')
  assert.equal(req.body.msg.context_token, 'ctx-token-value')
  assert.equal(req.body.msg.message_type, 2)
  assert.equal(req.body.msg.message_state, 2)
  assert.equal(req.body.msg.item_list[0].text_item.text, 'hello')
  assert.equal(req.body.base_info.channel_version, '0.0.0')
})

test('sendMessage surfaces a non-zero ret as an error', async () => {
  const server = new MockServer().on('sendmessage', () => ({ body: { ret: -2, errmsg: 'bad params' } }))
  const client = new ILinkClient({ token: 'tok', fetchImpl: server.fetchImpl })

  await assert.rejects(
    () => client.sendMessage({ msg: { to_user_id: 'u' } }),
    /sendMessage ret=-2/,
  )
})

test('sendMessage raises SessionExpiredError on errcode -14', async () => {
  const server = new MockServer().on('sendmessage', () => ({ body: { ret: -14, errmsg: 'expired' } }))
  const client = new ILinkClient({ token: 'tok', fetchImpl: server.fetchImpl })

  await assert.rejects(
    () => client.sendMessage({ msg: { to_user_id: 'u' } }),
    (err) => err instanceof SessionExpiredError,
  )
})

test('getBotQrcode requests bot_type and sends local_token_list', async () => {
  const server = new MockServer().on('get_bot_qrcode', () => ({
    body: { qrcode: 'qrc_1', qrcode_img_content: 'https://weixin.qq.com/x/abc' },
  }))
  const client = new ILinkClient({ token: 'tok', fetchImpl: server.fetchImpl })

  const resp = await client.getBotQrcode({ botType: '3', localTokenList: ['t1', 't2'] })
  assert.equal(resp.qrcode, 'qrc_1')

  const req = server.lastRequest('get_bot_qrcode')
  assert.match(req.url, /bot_type=3/)
  assert.deepEqual(req.body.local_token_list, ['t1', 't2'])
})

test('setBaseUrl follows a redirect host', async () => {
  const server = new MockServer().on('getupdates', (req) => ({
    body: { ret: 0, msgs: [], get_updates_buf: req.url },
  }))
  const client = new ILinkClient({ baseUrl: 'https://a.example', token: 't', fetchImpl: server.fetchImpl })
  client.setBaseUrl('https://b.example')
  await client.getUpdates({ getUpdatesBuf: '' })
  assert.match(server.requests[0].url, /^https:\/\/b\.example\//)
})

// ---------------------------------------------------------------------------
// CDN crypto
// ---------------------------------------------------------------------------

test('AES-128-ECB round-trips and reports the documented cipher size', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const plaintext = Buffer.from('hello wechat clawbot!')
  const cipher = encryptAesEcb(plaintext, key)
  assert.equal(cipher.length, encryptedSize(plaintext.length))
  assert.equal(encryptedSize(248731), 248736)
  assert.deepEqual(decryptAesEcb(cipher, key), plaintext)
})

test('decodeAesKey accepts both wire encodings and bare hex', () => {
  const rawHex = '00112233445566778899aabbccddeeff'
  const raw = Buffer.from(rawHex, 'hex')

  // Format A: base64(raw 16 bytes)
  const formatA = raw.toString('base64')
  assert.deepEqual(decodeAesKey(formatA), raw)

  // Format B: base64(hex string)
  const formatB = Buffer.from(rawHex, 'utf8').toString('base64')
  assert.deepEqual(decodeAesKey(formatB), raw)

  // Bare hex, as used by image_item.aeskey
  assert.deepEqual(decodeAesKey(rawHex), raw)

  assert.equal(decodeAesKey(undefined), undefined)
  assert.equal(decodeAesKey(''), undefined)
  assert.equal(decodeAesKey('not-a-key'), undefined)
})

test('resolveImageKey prefers image_item.aeskey over media.aes_key', () => {
  const preferred = '00112233445566778899aabbccddeeff'
  const fallback = 'ffeeddccbbaa99887766554433221100'
  const key = resolveImageKey({
    aeskey: preferred,
    media: { aes_key: Buffer.from(fallback, 'hex').toString('base64') },
  })
  assert.deepEqual(key, Buffer.from(preferred, 'hex'))
})

test('sniffImageMediaType identifies formats by magic bytes', () => {
  assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMediaType(Buffer.from('RIFF____WEBPVP8 ')), 'image/webp')
  assert.equal(sniffImageMediaType(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(sniffImageMediaType(Buffer.from('nope')), undefined)
})

// ---------------------------------------------------------------------------
// Message normalisation
// ---------------------------------------------------------------------------

test('normalizeInbound flattens text, captions, quotes and images', () => {
  const result = normalizeInbound({
    item_list: [
      { type: 1, text_item: { text: 'first line' } },
      {
        type: 1,
        text_item: { text: 'follow up' },
        ref_msg: { title: 'quoted summary', message_item: { type: 1, text_item: { text: 'original' } } },
      },
      { type: 2, image_item: { aeskey: '00112233445566778899aabbccddeeff', mid_size: 1234 } },
    ],
  })

  assert.equal(result.text, 'first line\n\nfollow up\n\n[引用] original')
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].aesKeyHex, '00112233445566778899aabbccddeeff')
})

test('normalizeInbound uses the voice transcript and reports unsupported parts', () => {
  const withTranscript = normalizeInbound({
    item_list: [{ type: 3, voice_item: { text: '三点到', playtime: 4000 } }],
  })
  assert.equal(withTranscript.text, '三点到')
  assert.equal(withTranscript.voiceTranscript, '三点到')

  const noTranscript = normalizeInbound({ item_list: [{ type: 3, voice_item: { playtime: 4000 } }] })
  assert.match(noTranscript.text, /语音/)
  assert.match(noTranscript.text, /附件未处理/)

  const fileMsg = normalizeInbound({ item_list: [{ type: 4, file_item: { file_name: 'a.pdf' } }] })
  assert.match(fileMsg.text, /a\.pdf/)
})

test('normalizeInbound ignores bot tool-call bookkeeping items', () => {
  const result = normalizeInbound({
    item_list: [
      { type: 11, text_item: { text: 'tool start' } },
      { type: 12, text_item: { text: 'tool result' } },
      { type: 1, text_item: { text: 'real question' } },
    ],
  })
  assert.equal(result.text, 'real question')
})

test('splitOutboundText prefers paragraph, line, then word boundaries', () => {
  assert.deepEqual(splitOutboundText('short', 100), ['short'])
  assert.deepEqual(splitOutboundText('', 100), [])

  const paragraph = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`
  const chunks = splitOutboundText(paragraph, 70)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((c) => c.length <= 70))
  assert.equal(chunks[0], 'a'.repeat(60))

  // A single long token with no boundary is hard-cut at the limit.
  const hard = splitOutboundText('x'.repeat(250), 100)
  assert.equal(hard.length, 3)
  assert.ok(hard.every((c) => c.length <= 100))

  // No content is lost when splitting.
  const text = 'word '.repeat(500)
  const rejoined = splitOutboundText(text, 100).join(' ').replace(/\s+/g, ' ').trim()
  assert.equal(rejoined, text.trim())
})

test('newClientId is unique across calls', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newClientId()))
  assert.equal(ids.size, 500)
})

// ---------------------------------------------------------------------------
// Account store
// ---------------------------------------------------------------------------

test('AccountStore persists credentials, cursors and the index', async () => {
  const dir = await makeTempStateDir()
  const store = new AccountStore(dir)

  assert.deepEqual(store.listAccountIds(), [])
  assert.equal(store.load('acct@im.bot'), null)
  assert.equal(store.loadSyncBuf('acct@im.bot'), '')

  store.registerAccountId('acct@im.bot')
  store.save('acct@im.bot', {
    token: 'tok-1',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    userId: 'user@im.wechat',
  })
  store.saveSyncBuf('acct@im.bot', 'cursor-abc')

  assert.deepEqual(store.listAccountIds(), ['acct@im.bot'])
  const loaded = store.load('acct@im.bot')
  assert.equal(loaded.token, 'tok-1')
  assert.equal(loaded.userId, 'user@im.wechat')
  assert.equal(store.loadSyncBuf('acct@im.bot'), 'cursor-abc')

  // A later save merges rather than dropping the bound userId.
  store.save('acct@im.bot', { token: 'tok-2' })
  assert.equal(store.load('acct@im.bot').userId, 'user@im.wechat')
  assert.equal(store.load('acct@im.bot').token, 'tok-2')

  store.clear('acct@im.bot')
  assert.equal(store.load('acct@im.bot'), null)
  assert.equal(store.loadSyncBuf('acct@im.bot'), '')
  assert.deepEqual(store.listAccountIds(), [])
})

// ---------------------------------------------------------------------------
// QR login state machine
// ---------------------------------------------------------------------------

test('QrLoginManager walks wait -> scaned -> confirmed and persists credentials', async () => {
  const dir = await makeTempStateDir()
  const store = new AccountStore(dir)

  const statuses = ['wait', 'scaned', 'confirmed']
  let call = 0
  const server = new MockServer()
    .on('get_bot_qrcode', () => ({ body: { qrcode: 'qrc_1', qrcode_img_content: 'https://weixin.qq.com/x/1' } }))
    .on('get_qrcode_status', () => {
      const status = statuses[call++] ?? 'confirmed'
      if (status === 'confirmed') {
        return {
          body: {
            status,
            bot_token: 'ilinkbot_token',
            ilink_bot_id: 'acct@im.bot',
            ilink_user_id: 'user@im.wechat',
            baseurl: 'https://ilinkai.weixin.qq.com',
          },
        }
      }
      return { body: { status } }
    })

  const client = new ILinkClient({ token: undefined, fetchImpl: server.fetchImpl })
  const manager = new QrLoginManager({ store, client })

  const ticket = await manager.start()
  assert.equal(ticket.qrcode, 'qrc_1')
  assert.ok(manager.has(ticket.id))

  assert.equal((await manager.poll({ ticketId: ticket.id })).status, 'wait')
  assert.equal((await manager.poll({ ticketId: ticket.id })).status, 'scaned')

  const done = await manager.poll({ ticketId: ticket.id })
  assert.equal(done.status, 'confirmed')
  assert.equal(done.accountId, 'acct@im.bot')
  assert.equal(done.userId, 'user@im.wechat')

  assert.deepEqual(store.listAccountIds(), ['acct@im.bot'])
  assert.equal(store.load('acct@im.bot').token, 'ilinkbot_token')

  // The confirmed ticket is consumed.
  assert.equal(manager.has(ticket.id), false)
  assert.equal((await manager.poll({ ticketId: ticket.id })).status, 'expired')
})

test('QrLoginManager follows scaned_but_redirect to a new host', async () => {
  const dir = await makeTempStateDir()
  const store = new AccountStore(dir)
  let call = 0
  const server = new MockServer()
    .on('get_bot_qrcode', () => ({ body: { qrcode: 'qrc_2', qrcode_img_content: 'u' } }))
    .on('get_qrcode_status', () => {
      call += 1
      if (call === 1) return { body: { status: 'scaned_but_redirect', redirect_host: 'other.example' } }
      return { body: { status: 'wait' } }
    })

  const client = new ILinkClient({ fetchImpl: server.fetchImpl })
  const manager = new QrLoginManager({ store, client })
  const ticket = await manager.start()

  assert.equal((await manager.poll({ ticketId: ticket.id })).status, 'scaned_but_redirect')
  assert.equal(client.baseUrl, 'https://other.example')
})

test('QrLoginManager reports need_verifycode and passes the code on', async () => {
  const dir = await makeTempStateDir()
  const store = new AccountStore(dir)
  let seenVerify
  const server = new MockServer()
    .on('get_bot_qrcode', () => ({ body: { qrcode: 'qrc_3', qrcode_img_content: 'u' } }))
    .on('get_qrcode_status', (req) => {
      seenVerify = new URL(req.url).searchParams.get('verify_code')
      return { body: { status: 'wait' } }
    })

  const client = new ILinkClient({ fetchImpl: server.fetchImpl })
  const manager = new QrLoginManager({ store, client })
  const ticket = await manager.start()

  await manager.poll({ ticketId: ticket.id, verifyCode: '1234' })
  assert.equal(seenVerify, '1234')
})

test('QrLoginManager drops an older binding for the same WeChat user', async () => {
  const dir = await makeTempStateDir()
  const store = new AccountStore(dir)
  store.registerAccountId('old@im.bot')
  store.save('old@im.bot', { token: 'old-token', userId: 'same@im.wechat' })

  const server = new MockServer()
    .on('get_bot_qrcode', () => ({ body: { qrcode: 'qrc_4', qrcode_img_content: 'u' } }))
    .on('get_qrcode_status', () => ({
      body: {
        status: 'confirmed',
        bot_token: 'new-token',
        ilink_bot_id: 'new@im.bot',
        ilink_user_id: 'same@im.wechat',
      },
    }))

  const client = new ILinkClient({ fetchImpl: server.fetchImpl })
  const manager = new QrLoginManager({ store, client })
  const ticket = await manager.start()
  await manager.poll({ ticketId: ticket.id })

  assert.deepEqual(store.listAccountIds(), ['new@im.bot'])
  assert.equal(store.load('old@im.bot'), null)
})

// ---------------------------------------------------------------------------
// Outbound sender
// ---------------------------------------------------------------------------

test('OutboundSender chunks long replies and requires a context_token', async () => {
  const server = new MockServer().on('sendmessage', () => ({ body: { ret: 0 } }))
  const client = new ILinkClient({ token: 't', fetchImpl: server.fetchImpl })
  const sender = new OutboundSender({ client, maxMessageChars: 50 })

  const sent = await sender.sendText({
    toUserId: 'user@im.wechat',
    contextToken: 'ctx-1',
    text: `${'a'.repeat(40)}\n\n${'b'.repeat(40)}`,
  })
  assert.equal(sent, 2)

  const reqs = server.requestsFor('sendmessage')
  assert.equal(reqs.length, 2)
  // Both chunks reuse the same conversation token but get fresh client ids.
  assert.equal(reqs[0].body.msg.context_token, 'ctx-1')
  assert.equal(reqs[1].body.msg.context_token, 'ctx-1')
  assert.notEqual(reqs[0].body.msg.client_id, reqs[1].body.msg.client_id)

  await assert.rejects(
    () => sender.sendText({ toUserId: 'u', contextToken: '', text: 'hi' }),
    /missing context_token/,
  )
})

test('OutboundSender caches the typing ticket and sends status 1/2', async () => {
  const server = new MockServer()
    .on('getconfig', () => ({ body: { ret: 0, typing_ticket: 'ticket-1' } }))
    .on('sendtyping', () => ({ body: { ret: 0 } }))

  const client = new ILinkClient({ token: 't', fetchImpl: server.fetchImpl })
  const sender = new OutboundSender({ client })

  await sender.setTyping({ userId: 'u@im.wechat', contextToken: 'ctx', typing: true })
  await sender.setTyping({ userId: 'u@im.wechat', contextToken: 'ctx', typing: false })

  // One getconfig (cached), two sendtyping calls.
  assert.equal(server.requestsFor('getconfig').length, 1)
  const typing = server.requestsFor('sendtyping')
  assert.equal(typing.length, 2)
  assert.equal(typing[0].body.status, 1)
  assert.equal(typing[1].body.status, 2)
  assert.equal(typing[0].body.typing_ticket, 'ticket-1')
})

test('OutboundSender swallows typing failures instead of failing the turn', async () => {
  const server = new MockServer().on('getconfig', () => ({ status: 500, body: { ret: -1 } }))
  const client = new ILinkClient({ token: 't', fetchImpl: server.fetchImpl })
  const sender = new OutboundSender({ client })

  await sender.setTyping({ userId: 'u', contextToken: 'ctx', typing: true })
})

// ---------------------------------------------------------------------------
// Channel listener
// ---------------------------------------------------------------------------

test('ChannelListener persists the cursor and deduplicates redelivered messages', async () => {
  const { ChannelListener } = await import('../lib/channel.js')
  const dir = await makeTempStateDir()
  const store = new AccountStore(dir)
  store.registerAccountId('acct@im.bot')

  let batch = 0
  const server = new MockServer().on('getupdates', () => {
    batch += 1
    if (batch === 1) {
      return {
        body: {
          ret: 0,
          msgs: [
            inboundTextMessage({
              from: 'user@im.wechat',
              to: 'acct@im.bot',
              text: 'hello',
              contextToken: 'ctx-1',
              messageId: 111,
            }),
          ],
          get_updates_buf: 'cursor-1',
        },
      }
    }
    // Redeliver the same message id, then stop the loop.
    if (batch === 2) {
      return {
        body: {
          ret: 0,
          msgs: [
            inboundTextMessage({
              from: 'user@im.wechat',
              to: 'acct@im.bot',
              text: 'hello',
              contextToken: 'ctx-1',
              messageId: 111,
            }),
          ],
          get_updates_buf: 'cursor-2',
        },
      }
    }
    return { body: { ret: 0, msgs: [], get_updates_buf: 'cursor-2' } }
  })

  const client = new ILinkClient({ token: 't', fetchImpl: server.fetchImpl })
  const received = []
  let resolveDone
  const done = new Promise((r) => (resolveDone = r))

  const listener = new ChannelListener({
    client,
    store,
    accountId: 'acct@im.bot',
    onInbound: (event) => {
      received.push(event)
      if (received.length >= 1) resolveDone()
    },
  })

  listener.start()
  await done
  // Give the loop a moment to process the duplicate batch.
  await new Promise((r) => setTimeout(r, 60))
  await listener.stop()

  // The duplicate must not produce a second inbound event.
  assert.equal(received.length, 1)
  assert.equal(received[0].normalized.text, 'hello')
  assert.equal(received[0].contextToken, 'ctx-1')

  // The cursor advanced and was persisted.
  assert.equal(store.loadSyncBuf('acct@im.bot'), 'cursor-2')
})

test('ChannelListener pauses on an expired session and clears the cursor', async () => {
  const { ChannelListener } = await import('../lib/channel.js')
  const dir = await makeTempStateDir()
  const store = new AccountStore(dir)
  store.registerAccountId('acct@im.bot')
  store.saveSyncBuf('acct@im.bot', 'stale')

  const server = new MockServer().on('getupdates', () => ({ body: { ret: -14, errmsg: 'expired' } }))
  const client = new ILinkClient({ token: 't', fetchImpl: server.fetchImpl })

  const listener = new ChannelListener({
    client,
    store,
    accountId: 'acct@im.bot',
    onInbound: () => {},
  })

  listener.start()
  // Wait for the loop to observe the expiry and return.
  for (let i = 0; i < 100 && listener.state !== 'expired'; i += 1) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(listener.state, 'expired')
  assert.equal(store.loadSyncBuf('acct@im.bot'), '')
  await listener.stop()
})

test('ChannelListener ignores bot-authored messages', async () => {
  const { ChannelListener } = await import('../lib/channel.js')
  const dir = await makeTempStateDir()
  const store = new AccountStore(dir)

  let batch = 0
  const server = new MockServer().on('getupdates', () => {
    batch += 1
    if (batch === 1) {
      const msg = inboundTextMessage({
        from: 'user@im.wechat',
        to: 'acct@im.bot',
        text: 'echo',
        contextToken: 'ctx',
        messageId: 5,
      })
      msg.message_type = 2 // BOT
      return { body: { ret: 0, msgs: [msg], get_updates_buf: 'c1' } }
    }
    return { body: { ret: 0, msgs: [], get_updates_buf: 'c1' } }
  })

  const client = new ILinkClient({ token: 't', fetchImpl: server.fetchImpl })
  const received = []
  const listener = new ChannelListener({
    client,
    store,
    accountId: 'acct@im.bot',
    onInbound: (e) => received.push(e),
  })

  listener.start()
  await new Promise((r) => setTimeout(r, 80))
  await listener.stop()

  assert.equal(received.length, 0)
})
