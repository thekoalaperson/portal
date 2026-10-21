// The few places portal touches the operating system: reading a secret the
// official CLIs stored, and running a command. Read-only by design -- portal
// never writes, refreshes or copies a credential.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import { MAC } from './paths.js'

export const run = promisify(execFile)

// PORTAL_FAKE_KEYCHAIN=<file.json> stands in for the Keychain in tests: an
// object of "service|account" -> secret string.
// Read on every call: in tests a stand-in CLI renews an entry mid-run.
function fakeKeychain() {
  return process.env.PORTAL_FAKE_KEYCHAIN ? JSON.parse(readFileSync(process.env.PORTAL_FAKE_KEYCHAIN, 'utf8')) : false
}

export async function readSecret(service, account) {
  const f = fakeKeychain()
  if (f) return f[`${service}|${account ?? ''}`] ?? f[`${service}|`] ?? null
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
export const CLAUDE_SERVICE = 'Claude Code-credentials'
export const claudeService = (dir) => dir
  ? `${CLAUDE_SERVICE}-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`
  : CLAUDE_SERVICE

// Claude Code files the entry under $USER, or under a fixed name when $USER
// has characters it rejects (SSO names like first@example.com).
export function keychainUser() {
  let user
  try { user = process.env.USER || userInfo().username } catch { return 'claude-code-user' }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

export const fingerprint = (token) => createHash('sha256').update(token).digest('hex').slice(0, 16)

// The payload of a JWT, without checking its signature: only used to read
// non-secret claims (email, plan, renewal) out of an id_token on disk.
export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    return null
  }
}

// Is a command on PATH? Cached per run.
const found = new Map()
export async function which(cmd) {
  if (found.has(cmd)) return found.get(cmd)
  let path = null
  try {
    const { stdout } = await run('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8', timeout: 2000 })
    path = stdout.trim() || null
  } catch { /* not installed */ }
  found.set(cmd, path)
  return path
}
