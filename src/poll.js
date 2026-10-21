// The one pipeline every screen goes through: read every account at once,
// renew any expired sign-in through its official CLI and read it again, fall
// back to the last reading where a read still fails, record, plan.

import { readFileSync } from 'node:fs'
import * as cache from './cache.js'
import { due, freshen, renewable } from './freshen.js'
import { needsSignIn, planAll } from './plan.js'
import { PROVIDERS } from './providers/index.js'
import * as store from './store.js'
import { dim } from './ui/render.js'

const FETCH_TIMEOUT_MS = 12_000
const REUSE_MS = 60_000   // a reading this young is still the truth; don't ask again
const RETRY_AFTER_MS = 700

// PORTAL_FIXTURE=<file.json> replays recorded provider responses instead of
// polling, so the engine and the screens run without any live token. The file
// is an array of { provider, email, usage } in the providers' normalized shape.
let fixture = null
function fixtureFor(account) {
  if (fixture === null) {
    const path = process.env.PORTAL_FIXTURE
    fixture = path ? JSON.parse(readFileSync(path, 'utf8')) : false
  }
  if (!fixture) return null
  const hit = fixture.find(f => f.email === account.email && f.provider === account.provider)
  return hit ? structuredClone(hit.usage) : { ok: false, inactive: true, error: 'not in fixture' }
}

async function read(account, { reuse = true } = {}) {
  const fixed = fixtureFor(account)
  if (fixed) return fixed
  const recent = reuse && cache.recentUsage(account.key, REUSE_MS)
  if (recent) return { ...recent, reused: true }
  const attempt = async () => {
    try {
      return await PROVIDERS[account.provider].fetchUsage(account, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (err) {
      return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message }
    }
  }
  let usage = await attempt()
  // A blip (a 429, a dropped connection) is worth one more try before the
  // screen falls back to an old reading; a sign-in problem is not.
  if (!usage.ok && !needsSignIn(usage)) {
    await new Promise(r => setTimeout(r, RETRY_AFTER_MS))
    usage = await attempt()
  }
  if (usage.ok) cache.rememberUsage(account.key, usage)
  return usage
}

function settle(account, usage) {
  // No live reading: fall back to what the last one means now, if it means
  // anything -- and to the plan it was on, which does not change between reads.
  if (!usage.ok) {
    const replay = store.replay(account, { inactive: needsSignIn(usage) })
    if (replay) {
      const last = cache.lastUsage(account.key)
      usage = { plan: last?.plan, tier: last?.tier, ...usage, ...replay }
    }
  }
  return { account, usage }
}

export async function snapshot(accounts, { quiet = false, fresh = false } = {}) {
  let usages = await Promise.all(accounts.map(a => read(a, { reuse: !fresh })))

  // Expired sign-ins the official CLIs may renew: renew them all at once, then
  // read those accounts again. The expired credentials themselves go no further.
  const jobs = []
  usages.forEach((u, i) => {
    for (const c of u.expiredCreds ?? []) {
      if (renewable(accounts[i].provider, c)) jobs.push({ provider: accounts[i].provider, home: c.home, index: i })
    }
  })
  const todo = process.env.PORTAL_FIXTURE ? [] : due(jobs)
  if (todo.length) {
    if (!quiet && process.stderr.isTTY) process.stderr.write(dim(`  renewing ${todo.length} sign-in${todo.length > 1 ? 's' : ''} through the official CLI…`))
    await freshen(todo)
    if (!quiet && process.stderr.isTTY) process.stderr.write('\r\x1b[2K')
    const again = [...new Set(todo.map(j => j.index))]
    const reread = await Promise.all(again.map(i => read(accounts[i], { reuse: false })))
    again.forEach((i, k) => { usages[i] = reread[k] })
  }
  usages = usages.map(({ expiredCreds, ...u }) => u)

  const results = accounts.map((a, i) => settle(a, usages[i]))
  store.recordMany(results.filter(r => !r.usage.reused))
  cache.flush()
  let plans
  return { results, get plans() { return plans ??= planAll(results) } }
}
