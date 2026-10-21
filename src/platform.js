// The few places portal touches the operating system: reading a secret the
// official CLIs stored, reading and writing its own small JSON files, and
// running a command. Read-only towards credentials by design -- portal never
// writes, refreshes or copies one.

import { execFile } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { MAC } from './paths.js'

// execFile as a promise; rejects with err.stdout/err.stderr on a non-zero exit.
export const run = (cmd, args, opts) => new Promise((resolve, reject) =>
  execFile(cmd, args, opts, (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })))

// node:crypto only loads on runs that read a Claude token -- a cached run never does.
const sha256 = (text) => process.getBuiltinModule('node:crypto').createHash('sha256').update(text).digest('hex')

// PORTAL_FAKE_KEYCHAIN=<file.json> stands in for the Keychain in tests: an
// object of "service|account" -> secret string. Read on every call: in tests a
// stand-in CLI renews an entry mid-run.
export async function readSecret(service, account) {
  if (process.env.PORTAL_FAKE_KEYCHAIN) {
    const f = readJson(process.env.PORTAL_FAKE_KEYCHAIN) ?? {}
    return f[`${service}|${account ?? ''}`] ?? f[`${service}|`] ?? null
  }
  if (!MAC) return null
  const args = ['find-generic-password', '-w', '-s', service]
  if (account) args.push('-a', account)
  try {
    const { stdout } = await run('security', args, { encoding: 'utf8', timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

// Claude Code names its Keychain entry after the exact text of
// CLAUDE_CONFIG_DIR: the first 8 hex of sha256(NFC(dir)). The default
// ~/.claude, with the variable unset, uses the bare name.
const CLAUDE_SERVICE = 'Claude Code-credentials'
export const claudeService = (dir) => dir ? `${CLAUDE_SERVICE}-${sha256(dir.normalize('NFC')).slice(0, 8)}` : CLAUDE_SERVICE

// Claude Code files the entry under $USER, or under a fixed name when $USER
// has characters it rejects (SSO names like first@example.com).
export function keychainUser() {
  let user
  try { user = process.env.USER || userInfo().username } catch { return 'claude-code-user' }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

export const fingerprint = (token) => sha256(token).slice(0, 16)

// The payload of a JWT, without checking its signature: only used to read
// non-secret claims (email, plan, renewal) out of an id_token on disk.
export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

// A JSON file, or null when it is missing or unreadable.
export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// Written whole or not at all: a temp file renamed into place.
export function writeJson(path, value, { pretty = false } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) + '\n')
  renameSync(tmp, path)
}

// Is a command on PATH? A scan of PATH, not a shell per lookup.
const found = new Map()
export function which(cmd) {
  if (!found.has(cmd)) {
    let path = null
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      try { accessSync(join(dir, cmd), constants.X_OK); path = join(dir, cmd); break } catch { /* not here */ }
    }
    found.set(cmd, path)
  }
  return found.get(cmd)
}
