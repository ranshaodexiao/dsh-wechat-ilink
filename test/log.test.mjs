/**
 * Durable logging tests.
 *
 * A plugin inside DSH has no readable stderr, so the file sink is the only way
 * a live failure can be diagnosed. These tests pin that behaviour.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

import { Logger, readLogTail, redactToken } from '../lib/log.js'
import { makeTempStateDir } from './helpers.mjs'

test('Logger writes every line to the file sink', async () => {
  const dir = await makeTempStateDir()
  const file = path.join(dir, 'channel.log')

  const lines = []
  const logger = new Logger('info', 'test', (l) => lines.push(l), file)
  logger.info('hello')
  logger.error('boom')

  const content = fs.readFileSync(file, 'utf-8')
  assert.match(content, /INFO hello/)
  assert.match(content, /ERROR boom/)
  // The console sink still receives them too.
  assert.equal(lines.length, 2)
})

test('Logger respects the level for both sinks', async () => {
  const dir = await makeTempStateDir()
  const file = path.join(dir, 'channel.log')
  const logger = new Logger('error', 'test', () => {}, file)

  logger.debug('nope')
  logger.info('nope')
  logger.error('yes')

  const content = fs.readFileSync(file, 'utf-8')
  assert.ok(!content.includes('nope'), 'below-level lines must not be written')
  assert.match(content, /ERROR yes/)
})

test('Logger creates the parent directory', async () => {
  const dir = await makeTempStateDir()
  const file = path.join(dir, 'nested', 'deeper', 'channel.log')
  const logger = new Logger('info', 'test', () => {}, file)
  logger.info('created')

  assert.ok(fs.existsSync(file))
  assert.match(fs.readFileSync(file, 'utf-8'), /created/)
})

test('errorDetail records the stack, not just the message', async () => {
  const dir = await makeTempStateDir()
  const file = path.join(dir, 'channel.log')
  const logger = new Logger('error', 'test', () => {}, file)

  function inner() {
    throw new Error('the real cause')
  }
  try {
    inner()
  } catch (err) {
    logger.errorDetail('turn failed', err)
  }

  const content = fs.readFileSync(file, 'utf-8')
  assert.match(content, /turn failed/)
  assert.match(content, /the real cause/)
  // A stack frame from this file proves the stack was captured.
  assert.match(content, /log\.test\.mjs/, 'stack frames must be present')
})

test('errorDetail tolerates a non-Error throw', async () => {
  const dir = await makeTempStateDir()
  const file = path.join(dir, 'channel.log')
  const logger = new Logger('error', 'test', () => {}, file)
  logger.errorDetail('odd failure', 'just a string')
  assert.match(fs.readFileSync(file, 'utf-8'), /odd failure: just a string/)
})

test('readLogTail returns the last N lines', async () => {
  const dir = await makeTempStateDir()
  const file = path.join(dir, 'channel.log')
  const logger = new Logger('info', 'test', () => {}, file)

  for (let i = 1; i <= 10; i += 1) logger.info(`line ${i}`)

  const tail = readLogTail(file, 3)
  assert.equal(tail.length, 3)
  assert.match(tail[2], /line 10/)
  assert.match(tail[0], /line 8/)
})

test('readLogTail returns an empty array for a missing file', () => {
  assert.deepEqual(readLogTail('/definitely/not/here.log', 10), [])
})

test('Logger never throws when the file path is unwritable', () => {
  // A logging failure must not break the channel.
  const logger = new Logger('info', 'test', () => {}, '\u0000invalid\u0000/path.log')
  assert.doesNotThrow(() => logger.info('still fine'))
})

test('a large log is trimmed rather than growing without bound', async () => {
  const dir = await makeTempStateDir()
  const file = path.join(dir, 'channel.log')

  // Pre-seed a file larger than the 2 MiB cap.
  fs.writeFileSync(file, 'x'.repeat(3 * 1024 * 1024))
  const logger = new Logger('info', 'test', () => {}, file)
  logger.info('after trim')

  const size = fs.statSync(file).size
  assert.ok(size < 3 * 1024 * 1024, `expected the log to shrink, got ${size}`)
  assert.match(fs.readFileSync(file, 'utf-8'), /after trim/)
})

test('redactToken never reveals a full token', () => {
  assert.equal(redactToken(undefined), '(none)')
  assert.equal(redactToken('short'), '***')
  const redacted = redactToken('ilinkbot_abcdefghijklmnop')
  assert.ok(!redacted.includes('abcdefghij'), redacted)
  assert.match(redacted, /^ilin\*\*\*op$/)
})
