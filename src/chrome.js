// Chrome profiles: which profile directory is signed into which address, and
// how to put a page -- or a login -- in front of the right one.
//
// Pages and browser logins otherwise land in whichever profile was used last,
// which is how a work login ends up on a personal account.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME, MAC } from './paths.js'

const LOCAL_STATE = MAC
  ? join(HOME, 'Library/Application Support/Google/Chrome/Local State')
  : join(HOME, '.config/google-chrome/Local State')

let cache = null
// True when the profiles exist but macOS keeps this terminal from reading
// another app's data, which otherwise looks exactly like having no profiles.
export let blocked = false
export const blockedFix = () => `give ${(process.env.TERM_PROGRAM ?? 'your terminal app').replace(/^Apple_Terminal$/, 'Terminal')} Full Disk Access (System Settings → Privacy & Security), reopen it`
// Every profile Chrome knows: its directory, the name shown in Chrome, and the
// Google address it is signed into (empty when it is not signed in).
export function profiles() {
  if (cache) return cache
  let info = {}
  try { info = JSON.parse(readFileSync(LOCAL_STATE, 'utf8')).profile?.info_cache ?? {} } catch (err) { blocked = err.code === 'EPERM' }
  cache = Object.entries(info)
    .map(([dir, p]) => ({ dir, label: p.name || dir, email: String(p.user_name ?? '').toLowerCase() }))
    .sort((a, b) => order(a.dir) - order(b.dir))
  return cache
}
const order = (dir) => dir === 'Default' ? 0 : Number(dir.replace(/\D/g, '')) || 1

export const chromeInstalled = () => MAC ? existsSync('/Applications/Google Chrome.app') : !!profiles().length

// A profile by its name in Chrome, its directory, or the address signed into
// it -- exactly as written first, then ignoring case.
export function findProfile(text) {
  const all = profiles()
  const want = String(text).toLowerCase()
  return all.find(p => p.label === text || p.dir === text) ??
    all.find(p => p.label.toLowerCase() === want || p.dir.toLowerCase() === want || (p.email && p.email === want)) ?? null
}

// The profile for an address: the one set by hand in the config, else the one
// signed into that address.
export function profileFor(email, cfg) {
  const want = cfg.chrome[String(email).toLowerCase()]
  if (want) return findProfile(want) ?? { dir: want, label: want, email: '' }
  return profiles().find(p => p.email && p.email === String(email).toLowerCase()) ?? null
}

// Open a page in a profile -- or just bring the profile's window forward.
export function launch(profile, url, { dryRun = false } = {}) {
  const args = MAC
    ? ['-na', 'Google Chrome', '--args', `--profile-directory=${profile.dir}`, ...(url ? [url] : [])]
    : [`--profile-directory=${profile.dir}`, ...(url ? [url] : [])]
  const cmd = MAC ? 'open' : 'google-chrome'
  // PORTAL_NO_BROWSER: tests, and anyone who wants to see what would open.
  if (dryRun || process.env.PORTAL_NO_BROWSER) return `${cmd} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`
  if (MAC) execFileSync(cmd, args)
  else spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  return null
}
