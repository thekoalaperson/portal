// Every screen, every situation, no live token, no network, no real machine
// state: each scenario builds a throwaway HOME (no Chrome, no orca, no real
// logins) with portal-signed-in accounts on disk, a fixture of provider
// responses, and a history database seeded with backdated readings so the
// engine has a pace to work with. Then it runs bin/portal and reads the screen.
//
//   node --test test/                      run everything
//   SHOW=overrun node --test test/         also print that scenario's home screen

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const H = 3_600_000
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

const PEOPLE = {
  hash: 'hash@gmail.com',
  work: 'me@company.com',
  spare: 'spare@gmail.com',
}

// One machine: three people, each signed in to Claude and Codex in homes of
// their own, as `portal add` would have left them.
function machine(dir) {
  const home = join(dir, 'home'), portal = join(dir, 'portal')
  mkdirSync(home, { recursive: true })
  mkdirSync(portal, { recursive: true })
  chrome(home)
  const accounts = []
  for (const [name, email] of Object.entries(PEOPLE)) {
    const c = join(portal, 'homes', `claude-${name}`)
    mkdirSync(c, { recursive: true })
    writeFileSync(join(c, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationType: 'claude_max' } }))
    accounts.push({ provider: 'claude', email, home: c })
    const x = join(portal, 'homes', `codex-${name}`)
    mkdirSync(x, { recursive: true })
    writeFileSync(join(x, 'auth.json'), JSON.stringify({ tokens: {
      access_token: 'fake', account_id: `acct-${name}`,
      id_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: `acct-${name}`, chatgpt_subscription_active_until: new Date(Date.now() + 9 * 24 * H).toISOString() } }),
    } }))
    accounts.push({ provider: 'codex', email, home: x })
  }
  writeFileSync(join(portal, 'config.json'), JSON.stringify({
    version: 1, accounts, names: { hash: PEOPLE.hash, work: PEOPLE.work }, setupDone: true,
    recipes: { vpn: { run: ['vpnctl', 'login', '--user', '{email}'], browser: 'focus' } },
  }))
  writeFileSync(join(dir, 'keychain.json'), '{}')
  return { home, portal }
}

const claudeUsage = ({ weekly, session, cap, blocked }) => ({
  ok: true, plan: 'claude_max', tier: 'default_claude_max_20x', blocked: !!blocked,
  windows: [
    ...(session ? [{ kind: '5h', usedPercent: session.used, resetAt: session.resetH != null ? Date.now() + session.resetH * H : null }] : []),
    { kind: 'weekly', usedPercent: weekly.used, resetAt: Date.now() + weekly.resetH * H },
    ...(cap != null ? [{ kind: 'weekly:Fable', usedPercent: cap, resetAt: Date.now() + weekly.resetH * H }] : []),
  ],
})

const codexUsage = ({ weekly, blocked, unstarted, resets, credits }) => ({
  ok: true, plan: 'pro', blocked: !!blocked,
  windows: [unstarted
    ? { kind: 'weekly', usedPercent: 0, resetAt: null, startsOnUse: true }
    : { kind: 'weekly', usedPercent: weekly.used, resetAt: Date.now() + weekly.resetH * H }],
  resets: resets ? { banked: 1, usableNow: 1 } : null,
  credits: credits ? { unlimited: false, balance: 62477, localMessages: [15600, 81200], exhausted: false } : null,
})

// Backdated readings, one every 20 minutes over 8 hours, at a steady pace.
function seed(db, provider, email, kind, { usedNow, rate, peak, session, sessionRate }) {
  const d = new DatabaseSync(db)
  d.exec(`CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL,
    email TEXT NOT NULL, kind TEXT NOT NULL, used_percent REAL NOT NULL, reset_at INTEGER, PRIMARY KEY (ts, account_id, kind));
    CREATE INDEX IF NOT EXISTS idx_samples_person ON samples (provider, email, kind, ts DESC);`)
  const ins = d.prepare('INSERT OR REPLACE INTO samples VALUES (?, ?, ?, ?, ?, ?, ?)')
  const now = Date.now()
  for (let i = 24; i >= 1; i--) {
    const ts = now - i * 20 * 60_000
    const hoursAgo = i / 3
    // A burst at the peak pace two days ago sets the ceiling.
    ins.run(ts, provider, `${provider}:${email}`, email, kind, Math.max(0, usedNow - rate * hoursAgo), null)
    if (session != null) ins.run(ts, provider, `${provider}:${email}`, email, '5h', Math.max(0, session - (sessionRate ?? rate * 2) * hoursAgo), null)
  }
  if (peak) {
    const t0 = now - 48 * H
    ins.run(t0, provider, `${provider}:${email}`, email, kind, 10, null)
    ins.run(t0 + H, provider, `${provider}:${email}`, email, kind, 10 + peak, null)
  }
  d.close()
}

// The machine's own logins must not leak in: orca's terminals set these.
const { CODEX_HOME, CLAUDE_CONFIG_DIR, ...cleanEnv } = process.env

function run(dir, env, args, { allowExit = [] } = {}) {
  try {
    return execFileSync(process.execPath, [join(root, 'bin/portal'), ...args], {
      env: { ...cleanEnv, ...env, NO_COLOR: '1', FORCE_COLOR: '', COLUMNS: '92' }, encoding: 'utf8',
    })
  } catch (err) {
    if (allowExit.includes(err.status)) return err.stdout ?? ''
    return { failed: true, code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

// Chrome's own record of its profiles, one per person, as Chrome writes it.
function chrome(home) {
  const dir = join(home, 'Library/Application Support/Google/Chrome')
  mkdirSync(dir, { recursive: true })
  const info_cache = {}
  Object.entries(PEOPLE).forEach(([name, email], i) => { info_cache[i ? `Profile ${i}` : 'Default'] = { name: name[0].toUpperCase() + name.slice(1), user_name: email } })
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { info_cache } }))
}

const SCREENS = [[], ['next'], ['plan'], ['schedule'], ['history'], ['accounts'], ['hash'], ['--json'], ['help'], ['recipe'], ['site'],
  ['open', 'claude', '--dry-run'], ['open', 'claude', 'work', '--dry-run'], ['login', 'google', 'work', '--dry-run'],
  ['login', 'claude', 'hash', '--dry-run'], ['login', 'vpn', 'work', '--dry-run', '--', '--region', 'eu'], ['check']]

// hash is the Claude account each scenario is about; work and spare fill in.
const SCENARIOS = {
  ontrack:  { hash: { weekly: { used: 39, resetH: 12 }, session: { used: 30, resetH: 3 }, rate: 5.1, peak: 6 }, expect: [/use hash — on track to use it all/] },
  wasting:  { hash: { weekly: { used: 39, resetH: 30 }, session: { used: 30, resetH: 3 }, rate: 1, peak: 6 }, expect: [/use hash — ~\d+% goes unused at reset/] },
  overrun:  { hash: { weekly: { used: 70, resetH: 30 }, session: { used: 20, resetH: 4 }, rate: 4, peak: 6 }, expect: [/runs dry ~/, /then switch to company\.com ~/] },
  idle:     { hash: { weekly: { used: 39, resetH: 12 }, rate: 0, peak: 6 }, expect: [/idle → all 61% goes unused at reset/] },
  sessionLow: { hash: { weekly: { used: 39, resetH: 12 }, session: { used: 85, resetH: 2 }, rate: 2.5, sessionRate: 10, peak: 6 },
    expect: [/5h 15% left/, /5h window runs out ~.* → switch to company\.com/] },
  sessionHigh: { hash: { weekly: { used: 39, resetH: 12 }, session: { used: 40, resetH: 2 }, rate: 2.5, peak: 6 },
    expect: [/use hash/], reject: [/5h \d+%/] },
  modelCap: { hash: { weekly: { used: 39, resetH: 12 }, session: { used: 10, resetH: 3 }, cap: 80, rate: 2.7, peak: 6 }, expect: [/61% left\s+\(fable 20%\)/] },
  allLocked: { hash: { weekly: { used: 100, resetH: 5 }, blocked: true, rate: 0 }, othersLocked: true, codexLocked: true,
    expect: [/claude\s+nothing usable/, /codex\s+nothing usable/] },
  banked:   { hash: { weekly: { used: 39, resetH: 12 }, rate: 2 }, codexLocked: true, banked: true, expect: [/can spend a banked reset now/] },
  credits:  { hash: { weekly: { used: 39, resetH: 12 }, rate: 2 }, codexLocked: true, credits: true, expect: [/can keep going on credits/, /62,477 credits/] },
  unstarted: { hash: { weekly: { used: 39, resetH: 12 }, rate: 2 }, codexUnstarted: true, expect: [/codex\s+use hash/, /on first use/] },
  expired:  { hash: { expired: true }, expect: [/claude\s+use (company\.com|spare)/] },
}

for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`scenario: ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), `portal-${name}-`))
    const { home, portal } = machine(dir)
    const db = join(dir, 'history.db')
    const fixture = []
    const h = sc.hash
    if (h.expired) fixture.push({ provider: 'claude', email: PEOPLE.hash, usage: { ok: false, inactive: true, expired: true, error: 'sign-in expired' } })
    else {
      fixture.push({ provider: 'claude', email: PEOPLE.hash, usage: claudeUsage(h) })
      seed(db, 'claude', PEOPLE.hash, h.cap != null && h.cap > h.weekly.used ? 'weekly:Fable' : 'weekly', { usedNow: h.cap ?? h.weekly.used, rate: h.rate, peak: h.peak, session: h.session?.used, sessionRate: h.sessionRate })
    }
    fixture.push({ provider: 'claude', email: PEOPLE.work, usage: claudeUsage({ weekly: { used: sc.othersLocked ? 100 : 95, resetH: 47 }, blocked: sc.othersLocked }) })
    fixture.push({ provider: 'claude', email: PEOPLE.spare, usage: claudeUsage({ weekly: { used: sc.othersLocked ? 100 : 20, resetH: 60 }, blocked: sc.othersLocked }) })
    for (const [who, email] of Object.entries(PEOPLE)) {
      fixture.push({ provider: 'codex', email, usage: codexUsage({
        weekly: { used: sc.codexLocked ? 100 : who === 'hash' ? 60 : 30, resetH: who === 'hash' ? 26 : 90 },
        blocked: sc.codexLocked, unstarted: sc.codexUnstarted && who !== 'hash',
        resets: sc.banked && who === 'work', credits: sc.credits && who === 'spare',
      }) })
    }
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture))
    const env = { HOME: home, PORTAL_HOME: portal, PORTAL_DB: db, PORTAL_FIXTURE: join(dir, 'fixture.json'), PORTAL_FAKE_KEYCHAIN: join(dir, 'keychain.json'), PORTAL_NO_PROMPT: '1' }

    for (const args of SCREENS) {
      const out = run(dir, env, args, { allowExit: args[0] === 'next' ? [1] : [] })
      assert.ok(typeof out === 'string', `portal ${args.join(' ')} failed (${out.code}):\n${out.out}`)
      assert.doesNotMatch(out, /undefined|NaN|\[object|null%/, `portal ${args.join(' ')} leaked a bad value:\n${out}`)
    }
    const homeScreen = run(dir, env, [])
    if (process.env.SHOW === name) console.log(homeScreen)
    for (const re of sc.expect) assert.match(homeScreen, re, `${name}: expected ${re}\n${homeScreen}`)
    for (const re of sc.reject ?? []) assert.doesNotMatch(homeScreen, re, `${name}: did not expect ${re}\n${homeScreen}`)
  })
}

test('a fresh machine with nothing on it says how to start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-fresh-'))
  const home = join(dir, 'home')
  mkdirSync(home)
  writeFileSync(join(dir, 'keychain.json'), '{}')
  const env = { HOME: home, PORTAL_HOME: join(dir, 'portal'), PORTAL_FAKE_KEYCHAIN: join(dir, 'keychain.json'), PORTAL_NO_PROMPT: '1' }
  const out = run(dir, env, [])
  assert.ok(typeof out === 'string', JSON.stringify(out))
  assert.match(out, /no accounts yet · run `portal setup`/)
  const setupOut = run(dir, env, ['setup'])
  assert.ok(typeof setupOut === 'string', JSON.stringify(setupOut))
  assert.match(setupOut, /found on this machine/)
  assert.match(setupOut, /claude\s+none yet/)
  for (const args of [['help'], ['accounts'], ['next'], ['check'], ['recipe'], ['site']]) {
    const o = run(dir, env, args)
    assert.ok(typeof o === 'string' || o.code === 1, `portal ${args.join(' ')} crashed on a fresh machine:\n${o.out}`)
  }
})

test('a fresh machine with only the default logins finds them without setup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-defaults-'))
  const home = join(dir, 'home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'solo@gmail.com', organizationType: 'claude_pro' } }))
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'x', account_id: 'a1',
    id_token: jwt({ email: 'solo@gmail.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }) } }))
  writeFileSync(join(dir, 'keychain.json'), '{}')
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify([
    { provider: 'claude', email: 'solo@gmail.com', usage: claudeUsage({ weekly: { used: 10, resetH: 50 } }) },
    { provider: 'codex', email: 'solo@gmail.com', usage: codexUsage({ weekly: { used: 5, resetH: 100 } }) },
  ]))
  const env = { HOME: home, PORTAL_HOME: join(dir, 'portal'), PORTAL_FIXTURE: join(dir, 'fixture.json'), PORTAL_FAKE_KEYCHAIN: join(dir, 'keychain.json'), PORTAL_NO_PROMPT: '1' }
  const out = run(dir, env, [])
  assert.ok(typeof out === 'string', JSON.stringify(out))
  assert.match(out, /claude\s+use solo/)
  assert.match(out, /codex\s+use solo/)
})

// The whole first-run conversation on a machine with nothing but Chrome and
// the two CLIs, answered the way a person would: add a Claude account, add a
// Codex account, done. The CLIs are stand-ins that "sign in" by writing what
// the real ones write, so the run is complete without a browser or network.
test('first run on a fresh machine: setup signs in a Claude and a Codex account', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-firstrun-'))
  const home = join(dir, 'home'), bin = join(dir, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  chrome(home)
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
email=new@gmail.com
while [ $# -gt 0 ]; do [ "$1" = "--email" ] && email="$2"; shift; done
mkdir -p "$CLAUDE_CONFIG_DIR"
printf '{"oauthAccount":{"emailAddress":"%s","organizationType":"claude_max"}}' "$email" > "$CLAUDE_CONFIG_DIR/.claude.json"
echo "Login successful"
`, { mode: 0o755 })
  const idToken = (email) => jwt({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })
  writeFileSync(join(bin, 'codex'), `#!/bin/sh
mkdir -p "$CODEX_HOME"
printf '{"tokens":{"access_token":"x","account_id":"a","id_token":"%s"}}' "${idToken(PEOPLE.work)}" > "$CODEX_HOME/auth.json"
echo "Successfully logged in"
`, { mode: 0o755 })
  writeFileSync(join(dir, 'keychain.json'), '{}')
  const env = {
    ...cleanEnv, HOME: home, PORTAL_HOME: join(dir, 'portal'), PORTAL_FAKE_KEYCHAIN: join(dir, 'keychain.json'),
    PORTAL_NO_BROWSER: '1', NO_COLOR: '1', PATH: `${bin}:${process.env.PATH}`,
  }
  // claude → first profile (hash) → codex → second profile (work) → done,
  // each typed only once its question is on screen, the way a person would.
  const answers = ['2', '', '3', '2', '1']
  const out = await converse(['python3', '-c', 'import pty,sys; pty.spawn(sys.argv[1:])', process.execPath, join(root, 'bin/portal')], env, answers)
  assert.match(out, /first run — setting up/)
  assert.match(out, /✓ claude · hash@gmail\.com/, out)
  assert.match(out, /✓ codex · me@company\.com/, out)
  assert.match(out, /✓ saved/, out)

  // And from then on both accounts are simply there.
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify([
    { provider: 'claude', email: PEOPLE.hash, usage: claudeUsage({ weekly: { used: 10, resetH: 50 } }) },
    { provider: 'codex', email: PEOPLE.work, usage: codexUsage({ weekly: { used: 5, resetH: 100 } }) },
  ]))
  const after = execFileSync(process.execPath, [join(root, 'bin/portal'), 'accounts'], { env: { ...env, PORTAL_FIXTURE: join(dir, 'fixture.json'), PORTAL_NO_PROMPT: '1' }, encoding: 'utf8' })
  assert.match(after, /hash\s+—|hash\s+hash/)
  assert.match(after, /company\.com/)
  assert.match(after, /portal sign-in/)
})

// Run a command on a pseudo-terminal and answer each question as it appears.
function converse(argv, env, answers) {
  return new Promise((resolve, reject) => {
    const p = spawn(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', asked = 0
    const timer = setTimeout(() => { p.kill(); reject(new Error('conversation timed out:\n' + out)) }, 30_000)
    const finish = () => { clearTimeout(timer); p.kill(); resolve(out.replace(/\r/g, '')) }
    p.stdout.on('data', (d) => {
      out += d
      const questions = (out.match(/number \[/g) ?? []).length
      while (asked < questions && asked < answers.length) p.stdin.write(answers[asked++] + '\r')
      // Python's pty wrapper outlives its child on macOS; the last line is the end.
      if (/✓ saved|setup stopped/.test(out)) setTimeout(finish, 200)
    })
    p.on('exit', finish)
  })
}

// A new computer with the config carried over from the old one (dotfiles):
// the accounts it names have no sign-in folder here yet. They must still show
// up as his accounts, and setup must say exactly how to sign each one in.
test('a new computer with a carried-over config lists what to sign in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-carried-'))
  const home = join(dir, 'home'), portal = join(dir, 'portal')
  mkdirSync(home, { recursive: true })
  mkdirSync(portal, { recursive: true })
  chrome(home)
  writeFileSync(join(dir, 'keychain.json'), '{}')
  writeFileSync(join(portal, 'config.json'), JSON.stringify({
    version: 1, setupDone: true, names: { hash: PEOPLE.hash, work: PEOPLE.work },
    // Folders from the old machine; nothing exists at these paths here.
    accounts: [
      { provider: 'claude', email: PEOPLE.hash, home: '/old-machine/homes/claude-1' },
      { provider: 'codex', email: PEOPLE.work, home: '/old-machine/homes/codex-1' },
    ],
    recipes: { vpn: { run: ['vpnctl', 'login'], browser: 'focus' } },
  }))
  const env = { HOME: home, PORTAL_HOME: portal, PORTAL_FAKE_KEYCHAIN: join(dir, 'keychain.json'), PORTAL_NO_PROMPT: '1', PORTAL_NO_BROWSER: '1' }
  const setupOut = run(dir, env, ['setup'])
  assert.ok(typeof setupOut === 'string', JSON.stringify(setupOut))
  assert.match(setupOut, /2 of 2 can't be read live/, setupOut)
  assert.match(setupOut, /portal login claude hash\s+hash@gmail\.com · opens in Chrome "Hash"/, setupOut)
  assert.match(setupOut, /portal login codex work\s+me@company\.com · opens in Chrome "Work"/, setupOut)
  const home1 = run(dir, env, [])
  assert.ok(typeof home1 === 'string', JSON.stringify(home1))
  assert.match(home1, /not signed in/, home1)
  const dry = run(dir, env, ['login', 'claude', 'hash', '--dry-run'])
  assert.match(dry, /claude auth login --claudeai --email hash@gmail\.com/, dry)
})
