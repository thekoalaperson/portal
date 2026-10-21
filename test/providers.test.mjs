// The live path, end to end, without the internet: a stand-in for the
// Anthropic and ChatGPT endpoints, stand-in `claude` and `codex` binaries that
// renew a sign-in the way the real ones do, a fake Keychain, and orca's
// SQLite settings. Covers credential reading, the identity check, response
// normalisation, renewal through the official CLI, and orca discovery.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { H, jwt, root, runPortal } from './helpers.mjs'

const iso = (h) => new Date(Date.now() + h * H).toISOString()
// Worked out here independently of src/platform.js, as a check on it.
const service = (dir) => `Claude Code-credentials-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`
const USER = 'tester'

// Who each token belongs to; anything else is a 401, like an expired token.
const TOKENS = {
  'fresh-claude-hash': 'hash@gmail.com',
  'orca-claude-work': 'me@company.com',
  'fresh-codex-hash': 'hash@gmail.com',
  'orca-codex-work': 'me@company.com',
}

function server() {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const token = (req.headers.authorization ?? '').replace('Bearer ', '')
      const email = TOKENS[token]
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (!email) return send(401, { error: 'expired' })
      if (req.url === '/api/oauth/profile') return send(200, { account: { email }, organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } })
      if (req.url === '/api/oauth/usage') return send(200, { limits: [
        { group: 'session', kind: 'session', percent: 85, resets_at: iso(2) },
        { group: 'weekly', kind: 'weekly_all', percent: 40, resets_at: iso(30) },
        { group: 'weekly', kind: 'weekly_model', scope: { model: { display_name: 'Fable' } }, percent: 70, resets_at: iso(30) },
      ] })
      if (req.url === '/backend-api/wham/usage') return send(200, {
        email, plan_type: 'pro',
        rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 20, limit_window_seconds: 604800, reset_after_seconds: 50 * 3600, reset_at: Math.floor(Date.now() / 1000) + 50 * 3600 } },
        rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 },
        credits: { has_credits: true, unlimited: false, balance: '1234.5', approx_local_messages: [100, 500] },
      })
      send(404, {})
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}

test('reads, checks identity, renews through the CLIs, and finds orca accounts', async () => {
  const srv = await server()
  const api = `http://127.0.0.1:${srv.address().port}`
  const dir = mkdtempSync(join(tmpdir(), 'portal-live-'))
  const home = join(dir, 'home'), portal = join(dir, 'portal'), bin = join(dir, 'bin')
  for (const d of [home, portal, bin]) mkdirSync(d, { recursive: true })
  const keychain = join(dir, 'keychain.json')

  // hash: signed in by portal, both tokens expired; the CLIs will renew them.
  const claudeHome = join(portal, 'data/homes/claude-hash')
  const codexHome = join(portal, 'data/homes/codex-hash')
  mkdirSync(claudeHome, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(join(claudeHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'hash@gmail.com' } }))
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ last_refresh: iso(-300), tokens: { access_token: 'old-codex-hash', account_id: 'acct-hash',
    id_token: jwt({ email: 'hash@gmail.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct-hash' } }) } }))

  // work: managed by orca (1.4.218 layout: parked Claude token, Codex home).
  const orca = join(home, 'Library/Application Support/orca')
  const orcaCodex = join(orca, 'codex-accounts/w1/home')
  mkdirSync(join(orca, 'profiles/local-default'), { recursive: true })
  mkdirSync(orcaCodex, { recursive: true })
  writeFileSync(join(orcaCodex, 'auth.json'), JSON.stringify({ last_refresh: iso(-1), tokens: { access_token: 'orca-codex-work', account_id: 'acct-work',
    id_token: jwt({ email: 'me@company.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-work' } }) } }))
  const db = new DatabaseSync(join(orca, 'profiles/local-default/profile-state.db'))
  db.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT)')
  db.prepare('INSERT INTO profile_state_documents VALUES (?, ?)').run('settings', JSON.stringify({
    claudeManagedAccounts: [{ id: 'c1', email: 'me@company.com', organizationName: 'Company' }],
    codexManagedAccounts: [{ id: 'w1', email: 'me@company.com', managedHomePath: orcaCodex, providerAccountId: 'acct-work', workspaceLabel: 'Plus' }],
  }))
  db.close()

  const cred = (token, expiresInH) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'r', expiresAt: Date.now() + expiresInH * H, refreshTokenExpiresAt: Date.now() + 20 * 24 * H } })
  writeFileSync(keychain, JSON.stringify({
    [`${service(claudeHome)}|${USER}`]: cred('old-claude-hash', -2),
    [`Orca Claude Code Managed Credentials|c1`]: cred('orca-claude-work', 5),
  }))
  writeFileSync(join(portal, 'config.json'), JSON.stringify({ version: 1, setupDone: true, names: { hash: 'hash@gmail.com', work: 'me@company.com' },
    accounts: [{ provider: 'claude', email: 'hash@gmail.com', home: claudeHome }, { provider: 'codex', email: 'hash@gmail.com', home: codexHome }] }))

  // Stand-in CLIs: renew the sign-in, then answer like the real ones.
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), crypto = require('crypto')
process.stdin.once('data', (d) => {
  const req = JSON.parse(String(d).split('\\n')[0])
  const dir = process.env.CLAUDE_CONFIG_DIR
  const svc = 'Claude Code-credentials-' + crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)
  const kc = JSON.parse(fs.readFileSync(process.env.PORTAL_FAKE_KEYCHAIN, 'utf8'))
  kc[svc + '|${USER}'] = ${JSON.stringify(cred('fresh-claude-hash', 8))}
  fs.writeFileSync(process.env.PORTAL_FAKE_KEYCHAIN, JSON.stringify(kc))
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: {} } }) + '\\n')
  process.exit(0)
})
`, { mode: 0o755 })
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('fs'), path = require('path')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  for (const line of buf.split('\\n').slice(0, -1)) {
    const m = JSON.parse(line)
    if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
    if (m.id === 2) {
      const f = path.join(process.env.CODEX_HOME, 'auth.json')
      const a = JSON.parse(fs.readFileSync(f, 'utf8'))
      a.tokens.access_token = 'fresh-codex-hash'; a.last_refresh = new Date().toISOString()
      fs.writeFileSync(f, JSON.stringify(a))
      process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: {} } }) + '\\n')
      process.exit(0)
    }
  }
  buf = buf.slice(buf.lastIndexOf('\\n') + 1)
})
`, { mode: 0o755 })

  const env = { HOME: home, USER, PORTAL_HOME: portal, PORTAL_FAKE_KEYCHAIN: keychain, PORTAL_NO_PROMPT: '1', PORTAL_NO_BROWSER: '1',
    PORTAL_CLAUDE_API: api, PORTAL_CODEX_API: api, NO_COLOR: '1', COLUMNS: '92', PATH: `${bin}:${process.env.PATH}` }
  const run = async (args) => {
    const out = await runPortal(env, args)
    assert.equal(typeof out, 'string', `portal ${args.join(' ')} failed: ${out.out}`)
    return out
  }

  try {
    const out = await run([])
    // hash: renewed, read live; its Fable cap binds tighter than the week.
    assert.match(out, /hash\s+Max 20x\s+\S+\s+60% left\s+\(fable 30%\)/, out)
    assert.match(out, /5h 15% left/, out)
    // work: read through orca's parked Claude token and orca's Codex home.
    assert.match(out, /company\.com\s+Max 20x/, out)
    assert.match(out, /company\.com\s+Pro\s+\S+\s+80% left/, out)
    assert.match(out, /1 banked reset/, out)
    assert.doesNotMatch(out, /as of|last readings shown/, out)
    // The renewals landed where the CLIs keep them; portal only read them.
    assert.match(readFileSync(keychain, 'utf8'), /fresh-claude-hash/)
    assert.match(readFileSync(join(codexHome, 'auth.json'), 'utf8'), /fresh-codex-hash/)

    const accounts = await run(['accounts'])
    assert.match(accounts, /company\.com\s+work.*orca/, accounts)
    assert.match(accounts, /hash\s+hash.*portal sign-in/, accounts)

    const json = JSON.parse(await run(['--json']))
    assert.equal(json.filter(a => a.state === 'live').length, 4)
    assert.ok(json.every(a => !('creds' in a)), 'credentials locations must not appear in --json')
  } finally {
    srv.close()
  }
})

// A Codex week nobody has used reports its reset a full window from now; one
// message starts the clock but still reads 0% used. Told apart by seconds.
test('a Codex week started by one message is started, not "on first use"', async () => {
  const { normalize } = await import(join(root, 'src/providers/codex.js'))
  const at = (sinceStart) => normalize({ rate_limit: { primary_window: {
    used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604800 - sinceStart,
    reset_at: Math.floor(Date.now() / 1000) + 604800 - sinceStart } } }).windows[0]
  assert.equal(at(0).startsOnUse, true)
  assert.equal(at(150).startsOnUse, undefined)
  assert.ok(at(150).resetAt > Date.now() + 167 * H)
})
