// Claude usage. Endpoints and response shape verified live.
//
// Tokens are read where Claude Code keeps them -- the Keychain entry named
// after each config dir, or orca's parked copy -- and never refreshed, copied
// or stored here. When a token has expired, the official CLI renews it (see
// freshen.js); portal only ever reads.
//
// Identity is checked before any usage is believed: the default entry holds
// whichever account was signed in last, and reporting one account's numbers
// under another's name is the one failure this tool must never have. The
// answer is remembered by the token's fingerprint, so a token is checked once,
// not on every run.

import { readFile } from 'node:fs/promises'
import { claudeService, readSecret } from '../platform.js'
import * as cache from '../cache.js'

export const urls = {
  chat: 'https://claude.ai/new',
  usage: 'https://claude.ai/settings/usage',
}

// PORTAL_CLAUDE_API points the reads at a stand-in server in tests.
const API = process.env.PORTAL_CLAUDE_API ?? 'https://api.anthropic.com'
const USAGE_URL = `${API}/api/oauth/usage`
const PROFILE_URL = `${API}/api/oauth/profile`
const EARLY_MS = 60_000   // a token this close to expiry is treated as expired

async function readCred(cred) {
  let raw = null
  if (cred.kind === 'keychain') raw = await readSecret(cred.service ?? claudeService(cred.dir), cred.user)
  else raw = await readFile(cred.path, 'utf8').catch(() => null)
  if (!raw) return null
  try {
    const o = JSON.parse(raw)?.claudeAiOauth
    // Claude Code empties the entry when a renewal is refused: signed out.
    if (!o?.accessToken) return null
    return {
      ...cred, token: o.accessToken, expiresAt: Number(o.expiresAt) || null, subscription: o.subscriptionType ?? null,
      // A sign-in renews itself for ~4 weeks after its last renewal, then needs a login.
      signInUntil: Number(o.refreshTokenExpiresAt) || null,
    }
  } catch {
    return null
  }
}

const get = (url, token, signal) => fetch(url, {
  signal,
  headers: {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': 'portal/1',
  },
})

// Whose token this is, from the provider. Remembered by the token's
// fingerprint, so each token is asked about once.
async function identity(token, signal) {
  const res = await get(PROFILE_URL, token, signal)
  if (!res.ok) return { status: res.status, body: null }
  const p = await res.json()
  const body = {
    email: p.account?.email ?? null,
    plan: p.organization?.organization_type ?? null,
    tier: p.organization?.rate_limit_tier ?? null,
  }
  cache.rememberIdentity(token, body)
  return { status: 200, body }
}

// The `limits` array is the canonical view -- the top-level five_hour/seven_day
// keys duplicate it, and the rest of the payload is feature-flag noise.
export function normalize(body) {
  const windows = []
  for (const l of body.limits ?? []) {
    const model = l.scope?.model?.display_name
    const kind =
      l.group === 'session' ? '5h'
      : l.kind === 'weekly_all' ? 'weekly'
      : model ? `weekly:${model}`
      : l.group === 'weekly' ? 'weekly'
      : l.kind
    windows.push({ kind, usedPercent: l.percent, resetAt: l.resets_at ? Date.parse(l.resets_at) : null })
  }
  // Older responses carry only the top-level keys.
  if (windows.length === 0) {
    for (const [key, kind] of [['five_hour', '5h'], ['seven_day', 'weekly']]) {
      const w = body[key]
      if (w?.utilization != null) windows.push({ kind, usedPercent: w.utilization, resetAt: w.resets_at ? Date.parse(w.resets_at) : null })
    }
  }
  const extra = body.extra_usage
  if (extra?.is_enabled && extra.utilization != null) {
    windows.push({ kind: 'monthly:overage', usedPercent: extra.utilization, resetAt: null })
  }
  return windows
}

const fresh = (c) => !c.expiresAt || c.expiresAt > Date.now() + EARLY_MS

// A failed read says which of the account's credentials had expired, so the
// caller can ask the official CLI to renew the ones it is allowed to.
const signedOut = (expired = []) => ({ ok: false, inactive: true, expired: expired.length > 0, error: expired.length ? 'sign-in expired' : 'not signed in', expiredCreds: expired })

export async function fetchUsage(account, { signal } = {}) {
  const read = (await Promise.all(account.creds.map(readCred))).filter(Boolean)
  // Unexpired first, then the one that lasts longest.
  read.sort((a, b) => Number(fresh(b)) - Number(fresh(a)) || (b.expiresAt ?? 0) - (a.expiresAt ?? 0))

  const expired = []
  for (const c of read) {
    if (!fresh(c)) { expired.push(c); continue }
    // A token checked before skips straight to its usage; a new one asks whose
    // it is and for its usage at once, and the usage counts only if it's his.
    const known = cache.identity(c.token)
    let who, res
    try {
      ;[who, res] = await Promise.all([
        known ? { status: 200, body: known } : identity(c.token, signal),
        get(USAGE_URL, c.token, signal),
      ])
    } catch (err) {
      return { ok: false, error: `network: ${err.message}` }
    }
    if (who.status === 401 || res.status === 401) { cache.forget(c.token); expired.push(c); continue }
    if (!who.body) return { ok: false, error: `profile HTTP ${who.status}` }
    // A token for someone else is no token.
    if (who.body.email && who.body.email.toLowerCase() !== account.email) continue
    if (!res.ok) return { ok: false, error: `usage HTTP ${res.status}` }
    let body
    try { body = await res.json() } catch (err) { return { ok: false, error: `usage: ${err.message}` } }
    return {
      ok: true,
      signInUntil: c.signInUntil,
      email: who.body.email ?? account.email,
      plan: who.body.plan ?? c.subscription ?? account.plan,
      tier: who.body.tier ?? account.tier,
      windows: normalize(body),
      source: c.source,
    }
  }
  return signedOut(expired)
}
