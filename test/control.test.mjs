/**
 * Session-control tests.
 *
 * `/use` lets WeChat drive ANOTHER DSH session; `/back` returns. Only the exact
 * command words are intercepted — every other message (including other `/…`
 * text) must pass through to the agent untouched.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionControl, isInternalSession, shortId } from '../lib/control.js'

/** A host with a fixed session list and a recorded persisted target. */
function makeHost(sessions, opts = {}) {
  const persisted = { calls: [], last: undefined }
  return {
    host: {
      homeSessionId: 'wechat-clawbot',
      // The host has already filtered archived/subagent/plugin sessions.
      listSessions: async () => sessions,
      hasSession: async (id) => opts.extraIds?.includes(id) ?? false,
      persistTarget: (id) => {
        persisted.calls.push(id)
        persisted.last = id
      },
      log: () => {},
    },
    persisted,
  }
}

const SESSIONS = [
  { id: 'session-0def7dc3-cc8d-409c-880a-7260511f8ceb', title: '开发微信 clawbot 插件', live: true },
  { id: 'session-5324fa3d-1e87-486f-baec-48b5e0d73841', title: '另一个会话', live: false },
]

// ---------------------------------------------------------------------------
// Command interception
// ---------------------------------------------------------------------------

test('only our exact commands are intercepted', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)

  // Ours.
  for (const text of ['/help', '/list', '/where', '/back', '/use 1']) {
    assert.notEqual(await control.handle(text), undefined, `${text} must be handled`)
  }

  // Everything else must fall through to the agent.
  for (const text of [
    '你好',
    '/model',
    '/new',
    '/useful',
    '/user 1',
    'use 1',
    'hello /use 1',
    '/',
    '/  ',
  ]) {
    assert.equal(await control.handle(text), undefined, `${text} must NOT be intercepted`)
  }
})

test('commands tolerate surrounding whitespace and case', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  assert.notEqual(await control.handle('  /HELP  '), undefined)
  assert.notEqual(await control.handle('/Where'), undefined)
})

// ---------------------------------------------------------------------------
// Attach / detach
// ---------------------------------------------------------------------------

test('defaults to the channel session and reports it as home', () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  assert.equal(control.activeSessionId, 'wechat-clawbot')
  assert.equal(control.isHome, true)
  assert.match(control.where(), /微信自己的会话/)
})

test('/use by list number attaches and persists', async () => {
  const { host, persisted } = makeHost(SESSIONS)
  const control = new SessionControl(host)

  await control.list() // populates the numbered list
  const reply = await control.use('1')

  assert.equal(control.activeSessionId, SESSIONS[0].id)
  assert.equal(control.isHome, false)
  assert.deepEqual(persisted.calls, [SESSIONS[0].id])
  assert.match(reply, /已接入/)
  assert.match(reply, /开发微信 clawbot 插件/)
})

test('/use by exact id attaches', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  await control.use(SESSIONS[1].id)
  assert.equal(control.activeSessionId, SESSIONS[1].id)
})

test('/use by unique id prefix attaches', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  await control.use('5324fa3d')
  assert.equal(control.activeSessionId, SESSIONS[1].id)
})

test('/use reports an out-of-range number without changing the target', async () => {
  const { host, persisted } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  await control.list()
  const reply = await control.use('99')
  assert.match(reply, /没有第 99 项/)
  assert.equal(control.activeSessionId, 'wechat-clawbot')
  assert.equal(persisted.calls.length, 0)
})

test('/use reports an unknown target without changing the target', async () => {
  const { host, persisted } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const reply = await control.use('nope-nothing')
  assert.match(reply, /找不到匹配/)
  assert.equal(control.activeSessionId, 'wechat-clawbot')
  assert.equal(persisted.calls.length, 0)
})

test('/use without an argument explains itself', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const reply = await control.use('')
  assert.match(reply, /用法/)
  assert.equal(control.activeSessionId, 'wechat-clawbot')
})

test('/use accepts an id that is outside the listed window', async () => {
  const { host } = makeHost(SESSIONS, { extraIds: ['session-old-1'] })
  const control = new SessionControl(host)
  await control.use('session-old-1')
  assert.equal(control.activeSessionId, 'session-old-1')
})

test('/use on an ambiguous prefix lists the candidates', async () => {
  const many = [
    { id: 'session-aaaa1111-x', title: 'A', live: true },
    { id: 'session-aaaa2222-y', title: 'B', live: true },
  ]
  const { host, persisted } = makeHost(many)
  const control = new SessionControl(host)
  const reply = await control.use('aaaa')
  assert.match(reply, /匹配到 2 个/)
  assert.equal(control.activeSessionId, 'wechat-clawbot')
  assert.equal(persisted.calls.length, 0)
})

test('/use notes when the target is not currently running', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const reply = await control.use(SESSIONS[1].id)
  assert.match(reply, /唤醒/)
})

test('/back returns home and clears the persisted target', async () => {
  const { host, persisted } = makeHost(SESSIONS)
  const control = new SessionControl(host)

  await control.use(SESSIONS[0].id)
  assert.equal(control.isHome, false)

  const reply = control.back()
  assert.equal(control.activeSessionId, 'wechat-clawbot')
  assert.equal(control.isHome, true)
  assert.match(reply, /回到/)
  // Last persist call is `undefined` -> the target file is removed.
  assert.equal(persisted.last, undefined)
})

test('/back when already home is a no-op that says so', () => {
  const { host, persisted } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const reply = control.back()
  assert.match(reply, /本来就在/)
  assert.equal(persisted.calls.length, 0)
})

test('/use on the already-active session does not re-persist', async () => {
  const { host, persisted } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  await control.use(SESSIONS[0].id)
  const before = persisted.calls.length
  const reply = await control.use(SESSIONS[0].id)
  assert.match(reply, /已经接入/)
  assert.equal(persisted.calls.length, before)
})

// ---------------------------------------------------------------------------
// Restored state
// ---------------------------------------------------------------------------

test('a persisted target is restored on construction', () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host, SESSIONS[0].id)
  assert.equal(control.activeSessionId, SESSIONS[0].id)
  assert.equal(control.isHome, false)
  assert.match(control.where(), /back 可退回/)
})

test('an empty persisted target falls back to home', () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host, '   ')
  assert.equal(control.activeSessionId, 'wechat-clawbot')
  assert.equal(control.isHome, true)
})

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

test('/list all numbers sessions and marks live ones', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const reply = await control.list(true)

  assert.match(reply, /1\. ● 开发微信 clawbot 插件/)
  assert.match(reply, /2\. ○ 另一个会话/)
  assert.match(reply, /\/use 1/)
  assert.match(reply, /\/use 2/)
  // Short ids are shown so the user can type them.
  assert.match(reply, /0def7dc3/)
})

test('/list survives a failing session query', async () => {
  const host = {
    homeSessionId: 'wechat-clawbot',
    listSessions: async () => {
      throw new Error('persistence unavailable')
    },
    hasSession: async () => false,
    persistTarget: () => {},
    log: () => {},
  }
  const control = new SessionControl(host)
  const reply = await control.list()
  assert.match(reply, /列不出来/)
  assert.match(reply, /persistence unavailable/)
})

test('/list on an empty corpus says so', async () => {
  const { host } = makeHost([])
  const control = new SessionControl(host)
  assert.match(await control.list(), /没有正在运行的会话/)
})

test('shortId produces a typable fragment', () => {
  assert.equal(shortId('session-0def7dc3-cc8d-409c-880a-7260511f8ceb'), '0def7dc3')
  assert.equal(shortId('wechat-clawbot'), 'wechat-clawbot')
  assert.equal(shortId('abc'), 'abc')
})

test('/list defaults to RUNNING sessions only', async () => {
  // The point of this command is to steer something you are working in, so a
  // run of stopped sessions is noise.
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const reply = await control.list()

  assert.match(reply, /正在运行的会话/)
  assert.match(reply, /1\. ● 开发微信 clawbot 插件/)
  // The stopped session is summarised, not numbered.
  assert.ok(!reply.includes('另一个会话'), reply)
  assert.match(reply, /另有 1 个已停止的会话，发 \/list all 查看/)
  assert.ok(!reply.includes('2. '), 'hidden sessions must not be numbered')
})

test('/list always ends with the current target', async () => {
  // The user asked for this line explicitly: it is how you notice you are
  // pointed at the wrong session.
  const { host } = makeHost(SESSIONS)

  const home = new SessionControl(host)
  assert.match(await home.list(), /当前：wechat-clawbot（微信自己的会话）/)

  const away = new SessionControl(host, SESSIONS[0].id)
  assert.match(await away.list(), /当前：session-0def7dc3/)
})

test('/list does NOT mention filtered-out sessions', async () => {
  // Filtering is diagnostic detail, not something to put on the phone.
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const reply = await control.list()

  assert.ok(!reply.includes('已隐藏'), reply)
  assert.ok(!reply.includes('个已归档'), reply)
  assert.ok(!reply.includes('个子代理'), reply)
})

test('/list all shows stopped sessions too', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const reply = await control.list(true)

  assert.match(reply, /可接入的会话/)
  assert.match(reply, /1\. ● 开发微信 clawbot 插件/)
  assert.match(reply, /2\. ○ 另一个会话/)
  assert.match(reply, /● 正在运行（微信可直接接管）   ○ 已停止（接入会唤醒）/)
  assert.ok(!reply.includes('已停止的会话，发'), 'no "use /list all" hint when already showing all')
})

test('/list numbering follows the mode, so /use uses the last list', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)

  // Default list: only the live session, so #1 is it.
  await control.list()
  await control.use('1')
  assert.equal(control.activeSessionId, SESSIONS[0].id)

  // `/list all` renumbers: #2 is now the stopped session.
  const control2 = new SessionControl(host)
  await control2.list(true)
  await control2.use('2')
  assert.equal(control2.activeSessionId, SESSIONS[1].id)
})

test('/list omits the hidden line when nothing was filtered', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const reply = await control.list(true)
  assert.ok(!reply.includes('已隐藏'), reply)
})

test('/list with everything filtered says why', async () => {
  const { host } = makeHost([])
  const control = new SessionControl(host)
  const reply = await control.list(true)
  assert.match(reply, /没有可接入的会话/)
})

test('/list when nothing is running suggests /list all', async () => {
  const { host } = makeHost(SESSIONS.filter((s) => !s.live))
  const control = new SessionControl(host)
  const reply = await control.list()
  assert.match(reply, /现在没有正在运行的会话/)
  assert.match(reply, /另有 1 个已停止的会话，发 \/list all 查看/)
})

test("isInternalSession identifies the plugin's own sessions", () => {
  const home = 'wechat-clawbot'
  assert.equal(isInternalSession('wechat-clawbot', home), true)
  assert.equal(isInternalSession('wechat-clawbot-selftest', home), true)

  // Real work sessions are NOT internal.
  assert.equal(isInternalSession('session-0def7dc3-cc8d-409c-880a-7260511f8ceb', home), false)
  assert.equal(isInternalSession('some-other-name', home), false)
  // Only the exact selftest suffix, not any looser match.
  assert.equal(isInternalSession('wechat-clawbot-selftest-2', home), false)
  assert.equal(isInternalSession('wechat', home), false)
})

test('/list omits the home session and the self-test session', async () => {
  // The home session is reachable via /back and is not a choice worth
  // numbering; the self-test session is plumbing.
  const { host } = makeHost([
    { id: 'session-0def7dc3-cc8d-409c-880a-7260511f8ceb', title: '真正要接管的活', live: true },
  ])
  const control = new SessionControl(host)
  const reply = await control.list()

  assert.match(reply, /真正要接管的活/)
  assert.match(reply, /\/use 1/)
  // Only one numbered entry: neither of the plugin's own sessions appears.
  assert.ok(!reply.includes('2. '), reply)
})

test('/list while attached shows where you are and how to get back', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host, SESSIONS[0].id)
  const reply = await control.list()

  assert.match(reply, /当前：session-0def7dc3/)
  assert.match(reply, /\/back 可退回 wechat-clawbot/)
})

test('/where always answers, even on the home session', async () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  assert.match(control.where(), /当前接入：wechat-clawbot/)
  assert.match(control.where(), /微信自己的会话/)
})

test('/help states the current target in both states', () => {
  const { host } = makeHost(SESSIONS)

  assert.match(new SessionControl(host).help(), /当前：wechat-clawbot（微信自己的会话）/)
  assert.match(
    new SessionControl(host, SESSIONS[0].id).help(),
    /当前：session-0def7dc3/,
  )
})

test('/help documents every command', () => {
  const { host } = makeHost(SESSIONS)
  const control = new SessionControl(host)
  const help = control.help()
  for (const cmd of ['/list', '/list all', '/use', '/back', '/where', '/help']) {
    assert.ok(help.includes(cmd), `help must mention ${cmd}`)
  }
})
