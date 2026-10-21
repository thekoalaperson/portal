// Which accounts exist on this machine. Nothing here is hand-maintained except
// the accounts portal signed in itself: everything else is read from where the
// official CLIs and other tools already keep it, on every run, so it never
// goes stale.
//
// An account is a person at a provider (provider + email). The same person can
// be reachable from several places -- orca, the default login, a portal home --
// and each place adds a credential to try. Reads try them freshest first and
// check whose token it is before believing it.
//
//   creds: { kind: 'keychain', dir | service, user } | { kind: 'file', path }
//          plus source ('portal' | 'orca' | 'default') and home: the config
//          dir the official CLI can be pointed at to renew it (null for the
//          default location). Who may renew what is decided in freshen.js.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { keyOf } from './config.js'
import { profileFor } from './chrome.js'
import { HOME, MAC } from './paths.js'
import { jwtClaims, keychainUser, readJson } from './platform.js'

const ORCA_DATA = MAC ? join(HOME, 'Library/Application Support/orca') : join(HOME, '.config/orca')
const ORCA_PARKED = 'Orca Claude Code Managed Credentials'

// ---------------------------------------------------------------- claude

// A Claude login in a config dir: its address and plan from the dir's own
// .claude.json, its token in the Keychain entry named after the dir (or the
// .credentials.json Claude falls back to off macOS). The default ~/.claude
// keeps its .claude.json in $HOME and its entry under the bare name.
export function claudeIn(dir, { isDefault = false } = {}) {
  const meta = readJson(isDefault ? join(HOME, '.claude.json') : join(dir, '.claude.json'))?.oauthAccount
  const home = isDefault ? null : dir
  return {
    email: meta?.emailAddress?.toLowerCase() ?? null,
    creds: [
      { kind: 'keychain', dir: home, user: keychainUser(), home },
      { kind: 'file', path: join(dir, '.credentials.json'), home },
    ],
    home,
    plan: meta?.organizationType ?? null,
    tier: meta?.organizationRateLimitTier ?? meta?.userRateLimitTier ?? null,
  }
}

// ----------------------------------------------------------------- codex

// A Codex login in a CODEX_HOME: everything is in auth.json, and the id_token
// in it says whose it is, on which plan, and until when the plan is paid for.
export function codexIn(home, { isDefault = false } = {}) {
  const path = join(home, 'auth.json')
  const blob = readJson(path)
  if (!blob) return null
  const claims = jwtClaims(blob.tokens?.id_token) ?? {}
  const auth = claims['https://api.openai.com/auth'] ?? {}
  return {
    email: claims.email?.toLowerCase() ?? null,
    creds: [{ kind: 'file', path, home: isDefault ? null : home }],
    home: isDefault ? null : home,
    plan: auth.chatgpt_plan_type ?? null,
    providerAccountId: blob.tokens?.account_id ?? auth.chatgpt_account_id ?? null,
    paidUntil: Date.parse(auth.chatgpt_subscription_active_until ?? '') || null,
  }
}

// ------------------------------------------------------------------ orca

// orca keeps its settings in a SQLite document store since 1.4.218, and in a
// JSON file before that. Both are internal formats, read defensively.
function orcaSettings() {
  const profile = join(ORCA_DATA, 'profiles/local-default')
  const dbPath = join(profile, 'profile-state.db')
  if (existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const row = db.prepare(`SELECT payload FROM profile_state_documents WHERE domain = 'settings'`).get()
      db.close()
      const s = row && JSON.parse(row.payload)
      if (s) return s.settings ?? s
    } catch { /* fall through to the JSON file */ }
  }
  const json = readJson(join(profile, 'orca-data.json'))
  return json?.settings ?? null
}

function orcaAccounts() {
  if (!existsSync(ORCA_DATA)) return []
  const s = orcaSettings()
  if (!s) return []
  const out = []
  for (const a of s.claudeManagedAccounts ?? []) {
    if (!a.email || !/^[a-zA-Z0-9_-]+$/.test(a.id ?? '')) continue
    // Before 1.4.227 orca parks a copy of the token under its own service;
    // from then on each account is a real CLAUDE_CONFIG_DIR, and Claude keeps
    // the token under that dir's name. Both are tried; whichever exists wins.
    const home = join(ORCA_DATA, 'claude-profiles', a.id, 'home')
    const inHome = existsSync(home) ? claudeIn(home) : null
    out.push({
      provider: 'claude', email: a.email, source: 'orca',
      plan: a.organizationName?.includes("'s Organization") ? 'personal' : null,
      creds: [{ kind: 'keychain', service: ORCA_PARKED, user: a.id, home: null }, ...(inHome?.creds ?? [])],
    })
  }
  for (const a of s.codexManagedAccounts ?? []) {
    if (!a.email) continue
    const home = a.managedHomePath ?? join(ORCA_DATA, 'codex-accounts', a.id, 'home')
    const found = codexIn(home)
    out.push({
      provider: 'codex', email: a.email, source: 'orca',
      plan: found?.plan ?? a.workspaceLabel ?? null,
      providerAccountId: a.providerAccountId ?? found?.providerAccountId ?? null,
      paidUntil: found?.paidUntil ?? null,
      creds: found?.creds ?? [{ kind: 'file', path: join(home, 'auth.json'), home }],
    })
  }
  return out
}

// --------------------------------------------------------------- default

// The default dirs, and whatever CLAUDE_CONFIG_DIR / CODEX_HOME point at --
// unless that is a dir already found as portal's or orca's, as it is in a
// terminal `portal use` switched.
function defaultAccounts(known) {
  const out = []
  const claudeDirs = [[join(HOME, '.claude'), true]]
  const env = process.env.CLAUDE_CONFIG_DIR
  if (env && env !== join(HOME, '.claude') && !known.has(env)) claudeDirs.push([env, false])
  for (const [dir, isDefault] of claudeDirs) {
    const c = claudeIn(dir, { isDefault })
    if (c.email) out.push({ provider: 'claude', source: 'default', ...c })
  }
  const codexHomes = [...new Set([join(HOME, '.codex'), process.env.CODEX_HOME].filter(h => h && !known.has(h)))]
  for (const home of codexHomes) {
    const isDefault = home === join(HOME, '.codex')
    const c = codexIn(home, { isDefault })
    if (c?.email) out.push({ provider: 'codex', source: 'default', ...c })
  }
  return out
}

// ---------------------------------------------------------------- portal

// Accounts portal signed in itself: the config entries with a home that is
// here. Whoever is signed in there now is who it is.
function portalAccounts(cfg) {
  const out = []
  for (const a of cfg.accounts) {
    if (!a.home || !existsSync(a.home)) continue
    const found = a.provider === 'claude' ? claudeIn(a.home) : codexIn(a.home)
    const email = found?.email ?? a.email
    if (email) out.push({ ...found, provider: a.provider, email, source: 'portal' })
  }
  return out
}

// Every account on this machine, as the config remembers them: so a config
// carried to a new computer lists every account to sign in there, not only
// the ones portal signed in itself. Addresses only -- nothing secret.
export function remember(cfg, accounts) {
  for (const a of accounts) {
    if (!cfg.accounts.some(x => x.provider === a.provider && x.email === a.email)) cfg.accounts.push({ provider: a.provider, email: a.email })
  }
}

// ------------------------------------------------------------------ join

const cmp = (x, y) => x < y ? -1 : x > y ? 1 : 0

export function discover(cfg) {
  const byKey = new Map()
  const found = [...portalAccounts(cfg), ...(cfg.sources.orca !== false ? orcaAccounts() : [])]
  const known = new Set(found.flatMap(f => (f.creds ?? []).map(c => c.home)).filter(Boolean))
  if (cfg.sources.default !== false) found.push(...defaultAccounts(known))
  for (const f of found) {
    const key = keyOf(f.provider, f.email)
    let acct = byKey.get(key)
    if (!acct) {
      acct = { key, provider: f.provider, email: f.email.toLowerCase(), plan: null, tier: null, providerAccountId: null, paidUntil: null, creds: [], sources: [] }
      byKey.set(key, acct)
    }
    acct.sources.push(f.source)
    for (const c of f.creds ?? []) {
      const id = c.kind === 'file' ? `file:${c.path}` : `kc:${c.service ?? `dir:${c.dir ?? '~'}`}|${c.user}`
      if (!acct.creds.some(x => x.id === id)) acct.creds.push({ ...c, id, source: f.source })
    }
    acct.plan ??= f.plan ?? null
    acct.tier ??= f.tier ?? null
    acct.providerAccountId ??= f.providerAccountId ?? null
    // The latest "paid until" any copy of the id_token knows.
    if (f.paidUntil && (!acct.paidUntil || f.paidUntil > acct.paidUntil)) acct.paidUntil = f.paidUntil
  }
  // Accounts the config remembers that nothing on this machine is signed into
  // (a config carried from another computer): his all the same, waiting for a
  // `portal login`.
  for (const r of cfg.accounts) {
    const key = keyOf(r.provider, r.email)
    if (r.email && !byKey.has(key)) {
      byKey.set(key, { key, provider: r.provider, email: r.email.toLowerCase(), plan: null, tier: null, providerAccountId: null, paidUntil: null, creds: [], sources: ['known'] })
    }
  }

  const accounts = [...byKey.values()]
  for (const a of accounts) {
    a.names = Object.entries(cfg.names).filter(([, e]) => e === a.email).map(([n]) => n)
    a.chrome = profileFor(a.email, cfg)
    a.hidden = cfg.hidden.includes(a.key)
    a.renews = renewal(a, cfg)
  }
  return accounts.sort((a, b) => cmp(a.provider, b.provider) || cmp(a.email, b.email))
}

// When the plan next renews. Codex says how long the plan is paid for, as of
// the last time the token was refreshed; a date already past means it has
// renewed since, so it is rolled forward a month at a time and marked as an
// estimate. Claude says nothing, so it is whatever was typed in once.
function renewal(a, cfg) {
  const typed = cfg.renews[a.key]
  if (typed) return { at: rollMonthly(Date.parse(typed)), estimated: Date.parse(typed) < Date.now() }
  if (a.paidUntil) return { at: rollMonthly(a.paidUntil), estimated: a.paidUntil < Date.now() }
  return null
}

function rollMonthly(ms) {
  if (!ms) return null
  const d = new Date(ms)
  while (d.getTime() < Date.now()) d.setMonth(d.getMonth() + 1)
  return d.getTime()
}
