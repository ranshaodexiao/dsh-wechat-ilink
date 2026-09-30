#!/usr/bin/env node
/**
 * `dsh-wechat-clawbot` CLI — first-run QR binding and diagnostics.
 *
 *   dsh-wechat-clawbot login     scan a QR code to bind a WeChat account
 *   dsh-wechat-clawbot status    show binding state and cursor
 *   dsh-wechat-clawbot logs [n]  print the channel's durable log tail
 *   dsh-wechat-clawbot logout    unbind all accounts
 *
 * Equivalent long form, if you prefer not to rely on the bin shim:
 *
 *   node lib/cli.js login
 *
 * This runs standalone (no DSH runtime needed) because it only touches the
 * iLink protocol layer and the on-disk credential store.
 */

import fs from 'node:fs'
import path from 'node:path'

import { AccountStore, resolveStateDir } from './ilink/accounts.js'
import { ILinkClient, DEFAULT_BASE_URL } from './ilink/transport.js'
import { QrLoginManager } from './ilink/login.js'
import { redactToken, readLogTail } from './log.js'

const CHANNEL_VERSION = '2.4.9'

function makeRuntime(): { store: AccountStore; client: ILinkClient; login: QrLoginManager } {
  const store = new AccountStore(resolveStateDir())
  const client = new ILinkClient({
    baseUrl: DEFAULT_BASE_URL,
    channelVersion: CHANNEL_VERSION,
    botAgent: 'DSH-ClawBot/0.1.0',
    appId: 'bot',
  })
  return { store, client, login: new QrLoginManager({ store, client }) }
}

/** Render a QR code in the terminal, degrading gracefully if unavailable. */
async function printQr(url: string): Promise<void> {
  try {
    const mod = await import('qrcode-terminal')
    const generate = mod.default?.generate ?? mod.generate
    if (typeof generate === 'function') {
      generate(url, { small: true }, (art: string) => process.stdout.write(`${art}\n`))
      return
    }
  } catch {
    // Fall through to printing the URL.
  }
  process.stdout.write('（未安装 qrcode-terminal，请用下面的链接自行生成二维码）\n')
}

async function cmdLogin(): Promise<number> {
  const { store, login } = makeRuntime()

  process.stdout.write('正在向微信申请登录二维码…\n')
  const ticket = await login.start()

  process.stdout.write('\n请用手机微信扫描下面的二维码（微信 → 扫一扫）：\n\n')
  await printQr(ticket.qrcodeUrl)
  process.stdout.write(`\n二维码链接：${ticket.qrcodeUrl}\n`)
  process.stdout.write('\n等待扫码确认…（Ctrl+C 取消）\n')

  // Poll until the ticket resolves. A client-side long-poll timeout is normal.
  for (;;) {
    const outcome = await login.poll({ ticketId: ticket.id })

    switch (outcome.status) {
      case 'confirmed': {
        process.stdout.write('\n✅ 绑定成功！\n')
        process.stdout.write(`   账号   ${outcome.accountId}\n`)
        process.stdout.write(`   微信   ${outcome.userId ?? '(未知)'}\n`)
        process.stdout.write(`   凭据   ${store.dir}\n`)
        process.stdout.write('\n重启 DSH（或在 DSH 里重新加载插件）后即可在微信里发消息。\n')
        return 0
      }
      case 'scaned':
        process.stdout.write('   已扫码，请在手机上点击确认…\n')
        break
      case 'need_verifycode': {
        process.stdout.write('   需要在手机上输入配对码，请输入手机显示的配对码：')
        const code = await readLine()
        if (code) {
          const next = await login.poll({ ticketId: ticket.id, verifyCode: code })
          if (next.status === 'confirmed') {
            process.stdout.write('\n✅ 绑定成功！\n')
            return 0
          }
        }
        break
      }
      case 'scaned_but_redirect':
        process.stdout.write('   正在切换登录服务器…\n')
        break
      case 'verify_code_blocked':
        process.stderr.write('\n✖ 配对码错误次数过多，请重新运行 login。\n')
        return 1
      case 'expired':
        process.stderr.write('\n✖ 二维码已过期，请重新运行 login。\n')
        return 1
      case 'binded_redirect':
        process.stdout.write('\nℹ 该微信账号已在别处绑定。\n')
        return 0
      case 'wait':
      default:
        break
    }
  }
}

async function cmdStatus(): Promise<number> {
  const { store } = makeRuntime()
  const ids = store.listAccountIds()

  process.stdout.write(`状态目录：${store.dir}\n`)
  if (ids.length === 0) {
    process.stdout.write('尚未绑定任何微信账号。运行 `login` 扫码绑定。\n')
    return 0
  }

  process.stdout.write(`已绑定 ${ids.length} 个账号：\n`)
  for (const id of ids) {
    const data = store.load(id)
    const cursor = store.loadSyncBuf(id)
    process.stdout.write(`  - ${id}\n`)
    process.stdout.write(`      微信用户  ${data?.userId ?? '(未知)'}\n`)
    process.stdout.write(`      token     ${redactToken(data?.token)}\n`)
    process.stdout.write(`      保存时间  ${data?.savedAt ?? '(未知)'}\n`)
    process.stdout.write(`      游标      ${cursor ? '已保存' : '（空，将从头开始）'}\n`)
  }
  return 0
}

async function cmdLogout(): Promise<number> {
  const { store } = makeRuntime()
  const ids = store.listAccountIds()
  if (ids.length === 0) {
    process.stdout.write('没有已绑定的账号。\n')
    return 0
  }
  for (const id of ids) {
    store.clear(id)
    process.stdout.write(`已解绑 ${id}\n`)
  }
  process.stdout.write('完成。微信里的 ClawBot 会话将不再收到回复。\n')
  return 0
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let input = ''
    const onData = (chunk: Buffer | string) => {
      input += chunk.toString()
      if (input.includes('\n')) {
        process.stdin.removeListener('data', onData)
        process.stdin.pause()
        resolve(input.trim())
      }
    }
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

/** Print the channel's durable log tail. */
async function cmdLogs(): Promise<number> {
  const store = new AccountStore(resolveStateDir())
  const file = path.join(store.dir, 'channel.log')

  const requested = Number.parseInt(process.argv[3] ?? '', 10)
  const lines = Number.isFinite(requested) && requested > 0 ? requested : 80

  if (!fs.existsSync(file)) {
    process.stdout.write(`还没有日志文件：${file}\n`)
    process.stdout.write('插件在 DSH 里运行过一次之后才会有内容。\n')
    return 0
  }

  process.stdout.write(`日志文件：${file}\n\n`)
  for (const line of readLogTail(file, lines)) process.stdout.write(`${line}\n`)
  return 0
}

function usage(): void {
  process.stdout.write(
    [
      '用法：node lib/cli.js <命令>',
      '',
      '命令：',
      '  login    扫码绑定微信账号（首次使用）',
      '  status   查看绑定状态',
      '  logs [n] 查看插件运行日志（默认最后 80 行）',
      '  logout   解绑所有账号',
      '',
    ].join('\n'),
  )
}

const command = process.argv[2]

try {
  let code = 0
  switch (command) {
    case 'login':
      code = await cmdLogin()
      break
    case 'status':
      code = await cmdStatus()
      break
    case 'logs':
      code = await cmdLogs()
      break
    case 'logout':
      code = await cmdLogout()
      break
    default:
      usage()
      code = command === undefined ? 0 : 1
  }
  process.exit(code)
} catch (err) {
  process.stderr.write(`\n✖ 出错：${String(err)}\n`)
  process.exit(1)
}
