// The one pipeline every screen goes through: read every account at once,
// renew any expired sign-in through its official CLI and read it again, fall
// back to the last reading where a read still fails, record, plan.

import { readFileSync } from 'node:fs'
import * as cache from './cache.js'
import { freshen, pending } from './freshen.js'
import { planAll } from './plan.js'
import { PROVIDERS } from './providers/index.js'
import * as store from './store.js'
import { dim } from './ui/render.js'

const FETCH_TIMEOUT_MS = 12_000
const REUSE_MS = 60_000   // a reading this young is still the truth; don't ask again

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
  let usage
  try {
    usage = await PROVIDERS[account.provider].fetchUsage(account, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    usage = { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message }
  }
  if (usage.ok) cache.rememberUsage(account.key, usage)
  return usage
}

function settle(account, usage) {
  // No live reading: fall back to what the last one means now, if it means
  // anything -- and to the plan it was on, which does not change between reads.
  if (!usage.ok) {
    const replay = store.replay(account, { inactive: usage.inactive === true })
    if (replay) {
      const last = cache.lastUsage(account.key)
      usage = { plan: last?.plan, tier: last?.tier, ...usage, ...replay }
    }
  }
  return { account, usage }
}

export async function snapshot(accounts, { renew = true, quiet = false, fresh = false } = {}) {
  let usages = await Promise.all(accounts.map(a => read(a, { reuse: !fresh })))

  // Expired sign-ins the official CLIs can renew: renew them all at once, then
  // read those accounts again.
  const jobs = []
  usages.forEach((u, i) => {
    if (!u.ok && u.refreshable?.length) {
      for (const r of u.refreshable) jobs.push({ provider: accounts[i].provider, home: r.home, index: i })
    }
  })
  const todo = renew && !process.env.PORTAL_FIXTURE ? pending(jobs) : []
  let renewed = []
  if (todo.length) {
    if (!quiet && process.stderr.isTTY) process.stderr.write(dim(`  renewing ${todo.length} sign-in${todo.length > 1 ? 's' : ''} through the official CLI…`))
    renewed = await freshen(todo)
    if (!quiet && process.stderr.isTTY) process.stderr.write('\r\x1b[2K')
    const again = [...new Set(todo.map(j => j.index))]
    const reread = await Promise.all(again.map(i => read(accounts[i], { reuse: false })))
    again.forEach((i, k) => { usages[i] = reread[k] })
  }

  const results = accounts.map((a, i) => settle(a, usages[i]))
  const recorded = store.recordMany(results.filter(r => !r.usage.reused))
  cache.flush()
  let plans
  return { results, recorded, renewed, get plans() { return plans ??= planAll(results) } }
}
