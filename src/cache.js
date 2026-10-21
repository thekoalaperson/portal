// Small facts worth remembering between runs, so a run does not repeat work
// the last one already did. Never a token: only a token's fingerprint and whose
// it is, and when a renewal last failed.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CACHE } from './paths.js'
import { fingerprint } from './platform.js'

const IDENTITY_TTL_MS = 7 * 24 * 3600_000

let data = null
let dirty = false

function load() {
  if (data) return data
  try { data = JSON.parse(readFileSync(CACHE, 'utf8')) } catch { data = {} }
  data.identity ??= {}
  data.freshen ??= {}
  data.usage ??= {}
  return data
}

// The last live reading of each account, whole (banked resets and credits
// included). A run within a minute of the last one shows it instead of asking
// the provider again, so `portal` then `portal open claude` is instant.
export function recentUsage(key, maxAgeMs) {
  const hit = load().usage[key]
  return hit && Date.now() - hit.at < maxAgeMs ? hit.usage : null
}
// What plan an account was on when last read, for when it cannot be read now.
export const lastUsage = (key) => load().usage[key]?.usage ?? null
export function rememberUsage(key, usage) {
  const { raw, ...rest } = usage
  load().usage[key] = { at: Date.now(), usage: rest }
  dirty = true
}

export function identity(token) {
  const hit = load().identity[fingerprint(token)]
  return hit && Date.now() - hit.at < IDENTITY_TTL_MS ? hit.body : null
}

export function rememberIdentity(token, body) {
  load().identity[fingerprint(token)] = { at: Date.now(), body }
  dirty = true
}

export function forget(token) {
  delete load().identity[fingerprint(token)]
  dirty = true
}

// A renewal that failed is not retried on every run: a dead sign-in would
// otherwise cost seconds each time.
export const freshenFailedAt = (home) => load().freshen[home ?? '~'] ?? null
export function noteFreshen(home, ok) {
  if (ok) delete load().freshen[home ?? '~']
  else load().freshen[home ?? '~'] = Date.now()
  dirty = true
}

export function flush() {
  if (!dirty) return
  const d = load()
  for (const [k, v] of Object.entries(d.identity)) if (Date.now() - v.at > IDENTITY_TTL_MS) delete d.identity[k]
  try {
    mkdirSync(dirname(CACHE), { recursive: true })
    const tmp = `${CACHE}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(d))
    renameSync(tmp, CACHE)
  } catch { /* a cache is allowed to be lost */ }
  dirty = false
}
