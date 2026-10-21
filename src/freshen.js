// Renewing an expired sign-in. Only the official CLI ever renews a token --
// portal asks it to, pointed at the account's own config dir, and then reads
// what it wrote. Refresh tokens rotate, so a second refresher would sign the
// CLI out; letting the owner do it keeps exactly one.
//
// Neither request below generates anything or uses quota:
//   claude  starts in stream-json mode and is asked for get_usage over its
//           control channel; no message is ever sent. Starting up is enough
//           for it to renew its own token.
//   codex   starts its app-server and is asked for account/rateLimits/read,
//           which renews the token when it has expired.

import { spawn } from 'node:child_process'
import * as cache from './cache.js'
import { which } from './platform.js'

const TIMEOUT_MS = 20_000
const RETRY_AFTER_MS = 30 * 60_000   // after a failed renewal, leave that home alone this long

function talk(cmd, args, env, { first, onLine }) {
  return new Promise((resolve) => {
    let done = false
    const p = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
    const finish = (ok, error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { p.stdin.end() } catch {}
      setTimeout(() => { try { p.kill() } catch {} }, 1500).unref()
      resolve({ ok, error })
    }
    const timer = setTimeout(() => finish(false, 'timed out'), TIMEOUT_MS)
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        onLine(msg, (o) => p.stdin.write(JSON.stringify(o) + '\n'), finish)
      }
    })
    p.on('error', (err) => finish(false, err.message))
    p.on('exit', () => finish(false, 'exited early'))
    p.stdin.on('error', () => {})
    p.stdin.write(JSON.stringify(first) + '\n')
  })
}

function claude(home) {
  const env = { ...process.env }
  if (home) env.CLAUDE_CONFIG_DIR = home
  else delete env.CLAUDE_CONFIG_DIR
  return talk('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], env, {
    first: { type: 'control_request', request_id: 'portal-usage', request: { subtype: 'get_usage', skip_behaviors: true } },
    onLine: (msg, _send, finish) => {
      if (msg.type === 'control_response') finish(msg.response?.subtype === 'success', msg.response?.error)
    },
  })
}

function codex(home) {
  const env = { ...process.env }
  if (home) env.CODEX_HOME = home
  else delete env.CODEX_HOME
  return talk('codex', ['app-server'], env, {
    first: { id: 1, method: 'initialize', params: { clientInfo: { name: 'portal', title: 'portal', version: '1.0.0' } } },
    onLine: (msg, send, finish) => {
      if (msg.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }) }
      else if (msg.id === 2) finish(!msg.error, msg.error?.message)
    },
  })
}

const RUN = { claude, codex }

// Renew every home in the list at once. Returns the homes that renewed.
export async function freshen(jobs) {
  const todo = []
  const seen = new Set()
  for (const { provider, home } of jobs) {
    const id = `${provider}:${home ?? '~'}`
    if (seen.has(id)) continue
    seen.add(id)
    const failed = cache.freshenFailedAt(id)
    if (failed && Date.now() - failed < RETRY_AFTER_MS) continue
    if (!(await which(provider))) continue
    todo.push({ provider, home, id })
  }
  const results = await Promise.all(todo.map(async (j) => {
    const r = await RUN[j.provider](j.home)
    cache.noteFreshen(j.id, r.ok)
    return { ...j, ...r }
  }))
  return results
}

export const pending = (jobs) => jobs.filter(({ provider, home }) => {
  const failed = cache.freshenFailedAt(`${provider}:${home ?? '~'}`)
  return !failed || Date.now() - failed >= RETRY_AFTER_MS
})
