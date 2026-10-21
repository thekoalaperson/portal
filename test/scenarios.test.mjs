// Every screen, every situation, no live token, no network, no real machine
// state: each scenario builds a throwaway HOME (no Chrome, no orca, no real
// logins) with portal-signed-in accounts on disk, a fixture of provider
// responses, and a history database seeded with backdated readings so the
// engine has a pace to work with. Then it runs bin/portal and reads the screen.
//
//   node --test test/                      run everything
//   SHOW=overrun node --test test/         also print that scenario's home screen

import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA } from '../src/store.js'
import { H, cleanEnv, jwt, root, runPortal } from './helpers.mjs'

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
  d.exec(SCHEMA)
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

// Scenarios are independent (each has its own home and database), so they
// run side by side; each one's own commands run one after another.
describe('scenarios', { concurrency: true }, () => {
for (const [name, sc] of Object.entries(SCENARIOS)) {
  it(`scenario: ${name}`, async () => {
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

    let homeScreen
    for (const args of SCREENS) {
      const out = await runPortal(env, args, { allowExit: args[0] === 'next' ? [1] : [] })
      assert.ok(typeof out === 'string', `portal ${args.join(' ')} failed (${out.code}):\n${out.out}`)
      assert.doesNotMatch(out, /undefined|NaN|\[object|null%/, `portal ${args.join(' ')} leaked a bad value:\n${out}`)
      homeScreen ??= out   // SCREENS starts with the home screen
    }
    if (process.env.SHOW === name) console.log(homeScreen)
    for (const re of sc.expect) assert.match(homeScreen, re, `${name}: expected ${re}\n${homeScreen}`)
    for (const re of sc.reject ?? []) assert.doesNotMatch(homeScreen, re, `${name}: did not expect ${re}\n${homeScreen}`)
  })
}
})

test('a fresh machine with nothing on it says how to start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-fresh-'))
  const home = join(dir, 'home')
  mkdirSync(home)
  writeFileSync(join(dir, 'keychain.json'), '{}')
  const env = { HOME: home, PORTAL_HOME: join(dir, 'portal'), PORTAL_FAKE_KEYCHAIN: join(dir, 'keychain.json'), PORTAL_NO_PROMPT: '1' }
  const out = await runPortal(env, [])
  assert.ok(typeof out === 'string', JSON.stringify(out))
  assert.match(out, /no accounts yet · run `portal setup`/)
  const setupOut = await runPortal(env, ['setup'])
  assert.ok(typeof setupOut === 'string', JSON.stringify(setupOut))
  assert.match(setupOut, /found on this machine/)
  assert.match(setupOut, /claude\s+none yet/)
  for (const args of [['help'], ['accounts'], ['next'], ['check'], ['recipe'], ['site']]) {
    const o = await runPortal(env, args)
    assert.ok(typeof o === 'string' || o.code === 1, `portal ${args.join(' ')} crashed on a fresh machine:\n${o.out}`)
  }
})

test('a fresh machine with only the default logins finds them without setup', async () => {
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
  const out = await runPortal(env, [])
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
  const after = await runPortal({ ...env, PORTAL_FIXTURE: join(dir, 'fixture.json'), PORTAL_NO_PROMPT: '1' }, ['accounts'])
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
test('a new computer with a carried-over config lists what to sign in', async () => {
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
  const setupOut = await runPortal(env, ['setup'])
  assert.ok(typeof setupOut === 'string', JSON.stringify(setupOut))
  assert.match(setupOut, /2 of 2 can't be read live/, setupOut)
  assert.match(setupOut, /portal login claude hash\s+hash@gmail\.com · opens in Chrome "Hash"/, setupOut)
  assert.match(setupOut, /portal login codex work\s+me@company\.com · opens in Chrome "Work"/, setupOut)
  const home1 = await runPortal(env, [])
  assert.ok(typeof home1 === 'string', JSON.stringify(home1))
  assert.match(home1, /not signed in/, home1)
  const dry = await runPortal(env, ['login', 'claude', 'hash', '--dry-run'])
  assert.match(dry, /claude auth login --claudeai --email hash@gmail\.com/, dry)
  // A brand-new account, named by address or by Chrome profile, with no questions asked.
  const byAddress = await runPortal(env, ['login', 'codex', 'spare@gmail.com', '--dry-run'])
  assert.match(byAddress, /bring up Chrome "Spare", then run: CODEX_HOME=.* codex login/, byAddress)
  const byProfile = await runPortal(env, ['login', 'claude', 'Spare', '--dry-run'])
  assert.match(byProfile, /claude auth login --claudeai --email spare@gmail\.com/, byProfile)
})

// Chrome profiles are somewhere to open a page or run a login even when they
// hold no Claude or Codex account: a GitHub-only work profile, or one not
// signed into Google at all. They can be named, opened, and logged in from.
test('Chrome profiles without an AI account can be named, opened and used for logins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-profiles-'))
  const { home, portal } = machine(dir)
  const state = join(home, 'Library/Application Support/Google/Chrome/Local State')
  const ls = JSON.parse(readFileSync(state, 'utf8'))
  ls.profile.info_cache['Profile 8'] = { name: 'GitHub Work', user_name: 'gh@company.com' }
  ls.profile.info_cache['Profile 9'] = { name: 'Scratch', user_name: '' }
  writeFileSync(state, JSON.stringify(ls))
  const env = { HOME: home, PORTAL_HOME: portal, PORTAL_FAKE_KEYCHAIN: join(dir, 'keychain.json'), PORTAL_NO_PROMPT: '1', PORTAL_NO_BROWSER: '1',
    PORTAL_FIXTURE: join(dir, 'fixture.json') }
  writeFileSync(join(dir, 'fixture.json'), '[]')

  assert.match(await runPortal(env, ['alias', 'ghw', 'GitHub Work']), /"ghw" → gh@company\.com · Chrome profile "GitHub Work", no Claude\/Codex account/)
  assert.match(await runPortal(env, ['alias', 'scratch', 'Scratch']), /"scratch" → Chrome "Scratch"/)
  assert.match(await runPortal(env, ['open', 'ghw', '--dry-run']), /--profile-directory=Profile 8"?$/m)
  assert.match(await runPortal(env, ['open', 'scratch', '--dry-run']), /--profile-directory=Profile 9"?$/m)
  assert.match(await runPortal(env, ['open', 'github', '--dry-run']), /--profile-directory=Profile 8/)
  assert.match(await runPortal(env, ['open', 'chatgpt', 'ghw', '--dry-run']), /Profile 8.* https:\/\/chatgpt\.com\/codex\/settings\/usage/)
  assert.match(await runPortal(env, ['login', 'gh', 'ghw', '--dry-run']), /send the sign-in page to Chrome "GitHub Work": run: gh auth login/)
  assert.match(await runPortal(env, ['login', 'gcloud', 'ghw', '--dry-run']), /gcloud auth login gh@company\.com/)
  assert.match(await runPortal(env, ['login', 'claude', 'ghw', '--dry-run']), /bring up Chrome "GitHub Work".*claude auth login --claudeai --email gh@company\.com/)
  assert.match(await runPortal(env, ['ghw']), /is the Chrome profile "GitHub Work" \(gh@company\.com\), with no Claude or Codex account/)

  const list = await runPortal(env, ['profiles'])
  assert.match(list, /GitHub Work\s+gh@company\.com\s+ghw\s+—/, list)
  assert.match(list, /Scratch\s+not signed in\s+scratch\s+—/, list)
  assert.match(list, /Hash\s+hash@gmail\.com\s+hash\s+claude, codex/, list)

  const nope = await runPortal(env, ['open', 'nowhere', '--dry-run'])
  assert.equal(nope.code, 1)
  assert.match(nope.out, /no account or Chrome profile matches "nowhere"[\s\S]*profiles: Hash, Work, Spare, GitHub Work, Scratch/)
})

// `portal use` points every terminal's claude and codex at an account's own
// config dir: nothing copied, the person's settings linked in, and the shell
// block that applies it added to the rc file once.
test('portal use switches which account every terminal uses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-use-'))
  const { home, portal } = machine(dir)
  // The default logins, with the settings a person has built up around them.
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{"theme":"dark"}')
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'solo@gmail.com' }, mcpServers: { linear: {} } }))
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n')
  writeFileSync(join(portal, 'homes', 'claude-spare', 'settings.json'), '{}')   // one home with its own
  writeFileSync(join(dir, 'fixture.json'), '[]')
  const env = { HOME: home, PORTAL_HOME: portal, PORTAL_FAKE_KEYCHAIN: join(dir, 'keychain.json'), PORTAL_NO_PROMPT: '1',
    PORTAL_FIXTURE: join(dir, 'fixture.json'), SHELL: '/bin/zsh', ZDOTDIR: '' }
  const useSh = join(portal, 'data', 'use.sh'), zshrc = join(home, '.zshrc')
  const claudeHome = (who) => join(portal, 'homes', `claude-${who}`)

  const first = await runPortal(env, ['use', 'hash'])
  assert.match(first, /claude\s+→ hash@gmail\.com/, first)
  assert.match(first, /codex\s+→ hash@gmail\.com/, first)
  assert.match(first, /shares settings\.json, skills with ~\/\.claude/, first)
  assert.match(first, /shares config\.toml with ~\/\.codex/, first)
  assert.match(first, /user MCP servers \(linear\)/, first)
  assert.match(first, /added a block to .*\.zshrc/, first)
  assert.equal(readlinkSync(join(claudeHome('hash'), 'settings.json')), join(home, '.claude', 'settings.json'))
  assert.match(readFileSync(useSh, 'utf8'), new RegExp(`export CLAUDE_CONFIG_DIR='${claudeHome('hash')}'`))

  // Again, for one tool: the other keeps its choice, the rc block stays single.
  const again = await runPortal(env, ['use', 'claude', 'spare'])
  assert.match(again, /claude\s+→ spare@gmail\.com/, again)
  assert.match(again, /keeps its own settings\.json/, again)
  assert.doesNotMatch(again, /codex\s+→/, again)
  assert.match(again, /every terminal switches at its next prompt/, again)
  assert.ok(!lstatSync(join(claudeHome('spare'), 'settings.json')).isSymbolicLink())
  assert.equal(readFileSync(zshrc, 'utf8').split('# added by portal use').length, 2)

  // A real zsh reading the rc file ends up switched.
  if (spawnSync('zsh', ['-c', 'true']).status === 0) {
    const sh = spawnSync('zsh', ['-f', '-c', `. "${zshrc}"; print -r -- "$CLAUDE_CONFIG_DIR|$CODEX_HOME"`], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' })
    assert.equal(sh.stdout.trim(), `${claudeHome('spare')}|${join(portal, 'homes', 'codex-hash')}`, sh.stderr)
  }

  const status = await runPortal({ ...env, CLAUDE_CONFIG_DIR: claudeHome('spare') }, ['use'])
  assert.match(status, /claude\s+spare@gmail\.com\s+portal use/, status)
  // This terminal never picked up the Codex switch, and there is no default Codex login.
  assert.match(status, /codex\s+hash@gmail\.com\s+portal use\s+this terminal: the default login, signed out/, status)
  assert.doesNotMatch(status, /undefined|null/, status)
  const check = await runPortal({ ...env, CLAUDE_CONFIG_DIR: claudeHome('spare') }, ['check'])
  assert.match(check, /claude\s+spare@gmail\.com\s+portal use/, check)

  const back = await runPortal(env, ['use', 'default'])
  assert.match(back, /claude\s+→ solo@gmail\.com · the default login/, back)
  const sh = readFileSync(useSh, 'utf8')
  assert.match(sh, /unset CLAUDE_CONFIG_DIR/)
  assert.match(sh, /unset CODEX_HOME/)

  const nope = await runPortal(env, ['use', 'nobody'])
  assert.equal(nope.code, 1)
})
