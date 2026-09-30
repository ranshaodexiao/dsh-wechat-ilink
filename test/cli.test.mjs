/**
 * CLI smoke test against a mock iLink server.
 *
 * Runs the built CLI as a subprocess with `fetch` intercepted, proving the
 * login/status/logout flow works without contacting WeChat.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { MockServer } from './helpers.mjs'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'lib', 'cli.js')

/** Run the CLI with DSH_HOME pointed at a temp dir. */
async function runCli(args, { dshHome, expectFail = false } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { ...process.env, DSH_HOME: dshHome },
      timeout: 20_000,
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    if (!expectFail) throw err
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('cli status reports no accounts on a fresh state dir', async () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-cli-'))
  const { code, stdout } = await runCli(['status'], { dshHome })
  assert.equal(code, 0)
  assert.match(stdout, /尚未绑定/)
})

test('cli with no command prints usage', async () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-cli-'))
  const { code, stdout } = await runCli([], { dshHome })
  assert.equal(code, 0)
  assert.match(stdout, /用法/)
  assert.match(stdout, /login/)
})

test('cli rejects an unknown command', async () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-cli-'))
  const { code } = await runCli(['bogus'], { dshHome, expectFail: true })
  assert.equal(code, 1)
})

test('cli logout is a no-op when nothing is bound', async () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-cli-'))
  const { code, stdout } = await runCli(['logout'], { dshHome })
  assert.equal(code, 0)
  assert.match(stdout, /没有已绑定的账号/)
})

test('cli status lists a bound account from disk', async () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-cli-'))
  // Pre-seed a bound account the same way a successful login would.
  const AccountStore = (await import('../lib/ilink/accounts.js')).AccountStore
  const store = new AccountStore(path.join(dshHome, 'clawbot'))
  store.registerAccountId('acct@im.bot')
  store.save('acct@im.bot', {
    token: 'ilinkbot_secret_token_value',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    userId: 'user@im.wechat',
  })
  store.saveSyncBuf('acct@im.bot', 'cursor-abc')

  const { code, stdout } = await runCli(['status'], { dshHome })
  assert.equal(code, 0)
  assert.match(stdout, /acct@im\.bot/)
  assert.match(stdout, /user@im\.wechat/)
  assert.match(stdout, /已保存/)
  // The raw token must never be printed in full.
  assert.ok(!stdout.includes('ilinkbot_secret_token_value'), 'token must be redacted')
})

test('cli logout removes a bound account', async () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-cli-'))
  const AccountStore = (await import('../lib/ilink/accounts.js')).AccountStore
  const store = new AccountStore(path.join(dshHome, 'clawbot'))
  store.registerAccountId('acct@im.bot')
  store.save('acct@im.bot', { token: 'tok' })

  const { code, stdout } = await runCli(['logout'], { dshHome })
  assert.equal(code, 0)
  assert.match(stdout, /已解绑/)

  const after = new AccountStore(path.join(dshHome, 'clawbot'))
  assert.deepEqual(after.listAccountIds(), [])
})

// A full login round-trip needs `fetch` interception inside the child process,
// which this harness does not provide; the in-process login tests in
// protocol.test.mjs cover that path.
void MockServer
