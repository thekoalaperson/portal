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
//   creds: { kind: 'keychain', service, user } | { kind: 'file', path }
//          plus source ('portal' | 'default' | 'orca') and refresh: how to get
//          the official CLI to renew it ({ home } -- null for the default
//          location -- or absent when no CLI owns it, like orca's parked copy)

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { keyOf } from './config.js'
import { profileFor } from './chrome.js'
import { HOME, HOMES, MAC } from './paths.js'
import { CLAUDE_SERVICE, claudeService, jwtClaims, keychainUser, readJson } from './platform.js'

const ORCA_DATA = MAC ? join(HOME, 'Library/Application Support/orca') : join(HOME, '.config/orca')
const ORCA_PARKED = 'Orca Claude Code Managed Credentials'

// ---------------------------------------------------------------- claude

// A Claude login in a config dir: its address and plan from the dir's own
// .claude.json, its token in the Keychain entry named after the dir (or the
// .credentials.json Claude falls back to off macOS).
function claudeIn(dir, { isDefault = false, owned = false } = {}) {
  const meta = readJson(isDefault ? join(HOME, '.claude.json') : join(dir, '.claude.json'))?.oauthAccount
  const email = meta?.emailAddress
  // Only a dir portal signed in itself is renewed by portal (see freshen.js);
  // the default login renews itself whenever Claude Code runs, and orca may
  // be rewriting it, so a second renewer there could sign Claude Code out.
  const refresh = owned ? { home: dir } : undefined
  const creds = [
    { kind: 'keychain', service: isDefault ? CLAUDE_SERVICE : claudeService(dir), user: keychainUser(), refresh },
    { kind: 'file', path: join(dir, '.credentials.json'), refresh },
  ]
  return {
    email, creds, home: isDefault ? null : dir,
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
    email: claims.email ?? null,
    // Codex homes are renewed through `codex app-server` -- orca never renews
    // Codex tokens, so the CLI stays the only renewer. ~/.codex is left to the
    // ChatGPT app and a bare `codex`, which renew it whenever they run.
    creds: [{ kind: 'file', path, refresh: isDefault ? undefined : { home } }],
    home,
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
  if (!existsSync(ORCA_DATA)) return null
  const s = orcaSettings()
  if (!s) return null
  const out = []
  const user = keychainUser()
  for (const a of s.claudeManagedAccounts ?? []) {
    if (!a.email || !/^[a-zA-Z0-9_-]+$/.test(a.id ?? '')) continue
    // Before 1.4.227 orca parks a copy of the token under its own service;
    // from then on each account is a real CLAUDE_CONFIG_DIR, and Claude keeps
    // the token under that dir's name. Both are tried; whichever exists wins.
    const home = join(ORCA_DATA, 'claude-profiles', a.id, 'home')
    const hasHome = existsSync(home)
    out.push({
      provider: 'claude', email: a.email, source: 'orca', orcaId: a.id,
      plan: a.organizationName?.includes("'s Organization") ? 'personal' : null,
      home: hasHome ? home : null,
      creds: [
        { kind: 'keychain', service: ORCA_PARKED, user: a.id },
        ...(hasHome ? [
          { kind: 'keychain', service: claudeService(home), user },
          { kind: 'file', path: join(home, '.credentials.json') },
        ] : []),
      ],
    })
  }
  for (const a of s.codexManagedAccounts ?? []) {
    if (!a.email) continue
    const home = a.managedHomePath ?? join(ORCA_DATA, 'codex-accounts', a.id, 'home')
    const found = codexIn(home)
    out.push({
      provider: 'codex', email: a.email, source: 'orca', orcaId: a.id,
      plan: found?.plan ?? a.workspaceLabel ?? null,
      providerAccountId: a.providerAccountId ?? found?.providerAccountId ?? null,
      paidUntil: found?.paidUntil ?? null,
      home, creds: found?.creds ?? [{ kind: 'file', path: join(home, 'auth.json'), refresh: { home } }],
    })
  }
  return out
}

// --------------------------------------------------------------- default

function defaultAccounts() {
  const out = []
  const claudeDirs = [[join(HOME, '.claude'), true]]
  if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR !== join(HOME, '.claude')) {
    claudeDirs.push([process.env.CLAUDE_CONFIG_DIR, false])
  }
  for (const [dir, isDefault] of claudeDirs) {
    const c = claudeIn(dir, { isDefault })
    if (c.email) out.push({ provider: 'claude', source: 'default', ...c })
  }
  const codexHomes = [...new Set([join(HOME, '.codex'), process.env.CODEX_HOME].filter(Boolean))]
  for (const home of codexHomes) {
    const isDefault = home === join(HOME, '.codex')
    const c = codexIn(home, { isDefault })
    if (c?.email) out.push({ provider: 'codex', source: 'default', ...c, home: isDefault ? null : home })
  }
  return out
}

// ---------------------------------------------------------------- portal

// Accounts portal signed in itself, from the config. The home is the source of
// truth for the address: whoever is signed in there now is who it is.
function portalAccounts(cfg) {
  const out = []
  for (const a of cfg.accounts ?? []) {
    // A config carried over from another machine names accounts whose sign-in
    // folder is not here yet: they are still his accounts, just not signed in
    // on this machine, so `portal setup` and `portal login` can offer them.
    if (!a.home || !existsSync(a.home)) {
      if (a.email) out.push({ provider: a.provider, email: a.email, source: 'known', creds: [], home: null })
      continue
    }
    const found = a.provider === 'claude' ? claudeIn(a.home, { owned: true }) : codexIn(a.home)
    const email = found?.email ?? a.email
    if (!email) continue
    out.push({ ...found, provider: a.provider, email, source: 'portal', home: a.home })
  }
  return out
}

// Every account on this machine, as the config remembers them: so a config
// carried to a new computer lists every account to sign in there, not only
// the ones portal signed in itself. Addresses only -- nothing secret.
export function remember(cfg, accounts) {
  cfg.accounts ??= []
  for (const a of accounts) {
    if (!cfg.accounts.some(x => x.provider === a.provider && x.email === a.email)) cfg.accounts.push({ provider: a.provider, email: a.email })
  }
}

// Homes portal created but never finished signing into, for `portal doctor`.
export function strayHomes(cfg) {
  if (!existsSync(HOMES)) return []
  const known = new Set((cfg.accounts ?? []).map(a => a.home))
  return readdirSync(HOMES).map(d => join(HOMES, d)).filter(d => !known.has(d))
}

// ------------------------------------------------------------------ join

const SOURCE_RANK = { portal: 0, orca: 1, default: 2, known: 3 }

export function discover(cfg) {
  const found = { portal: portalAccounts(cfg), orca: null, default: [] }
  if (cfg.sources?.orca !== false) found.orca = orcaAccounts()
  if (cfg.sources?.default !== false) found.default = defaultAccounts()

  const byKey = new Map()
  const all = [...found.portal, ...(found.orca ?? []), ...found.default]
  // An account the config knows only by name adds nothing where it was found another way.
    .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])
  for (const f of all) {
    const key = keyOf(f.provider, f.email)
    let acct = byKey.get(key)
    if (!acct) {
      acct = {
        key, provider: f.provider, email: f.email.toLowerCase(),
        plan: null, tier: null, providerAccountId: null, paidUntil: null,
        creds: [], homes: [], sources: [], orcaId: null,
      }
      byKey.set(key, acct)
    }
    if (f.source !== 'known' || acct.sources.length === 0) acct.sources.push(f.source)
    for (const c of f.creds ?? []) {
      const id = c.kind === 'file' ? `file:${c.path}` : `kc:${c.service}|${c.user ?? ''}`
      if (acct.creds.some(x => x.id === id)) continue
      acct.creds.push({ ...c, id, source: f.source })
    }
    if (f.home && !acct.homes.includes(f.home)) acct.homes.push(f.home)
    acct.plan ??= f.plan ?? null
    acct.tier ??= f.tier ?? null
    acct.providerAccountId ??= f.providerAccountId ?? null
    acct.orcaId ??= f.orcaId ?? null
    // The latest "paid until" any copy of the id_token knows.
    if (f.paidUntil && (!acct.paidUntil || f.paidUntil > acct.paidUntil)) acct.paidUntil = f.paidUntil
  }

  const accounts = [...byKey.values()]
  for (const a of accounts) {
    a.names = Object.entries(cfg.names ?? {}).filter(([, e]) => e === a.email).map(([n]) => n)
    a.chrome = profileFor(a.email, cfg)
    a.hidden = (cfg.hidden ?? []).includes(a.key)
    a.renews = renewal(a, cfg)
  }
  accounts.sort((a, b) => a.provider.localeCompare(b.provider) || a.email.localeCompare(b.email))
  return { accounts, found }
}

// When the plan next renews. Codex says how long the plan is paid for, as of
// the last time the token was refreshed; a date already past means it has
// renewed since, so it is rolled forward a month at a time and marked as an
// estimate. Claude says nothing, so it is whatever was typed in once.
function renewal(a, cfg) {
  const typed = cfg.renews?.[a.key]
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
