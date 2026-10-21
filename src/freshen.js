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

// Who may renew which sign-in -- the whole policy, in one place. Refresh
// tokens rotate, so each sign-in must have exactly one renewer:
//   claude  only the config dirs portal signed in itself. The default login is
//           renewed by Claude Code whenever it runs, and orca's by orca.
//   codex   any CODEX_HOME but ~/.codex, which the ChatGPT app and a bare
//           `codex` keep fresh. orca never renews Codex tokens itself.
export function renewable(provider, cred) {
  if (provider === 'claude') return cred.source === 'portal' && !!cred.home
  return !!cred.home
}

const idOf = ({ provider, home }) => `${provider}:${home}`

// The renewals worth trying now: one per home, installed CLI, and not one that
// failed in the last half hour.
export function due(jobs) {
  const seen = new Set()
  return jobs.filter((j) => {
    const id = idOf(j)
    if (seen.has(id) || !which(j.provider)) return false
    seen.add(id)
    const failed = cache.freshenFailedAt(id)
    return !failed || Date.now() - failed >= RETRY_AFTER_MS
  })
}

// Renew every home in the list at once.
export async function freshen(jobs) {
  await Promise.all(jobs.map(async (j) => cache.noteFreshen(idOf(j), (await RUN[j.provider](j.home)).ok)))
}
