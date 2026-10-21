// The one file a person edits, or lets `portal` edit for them. It holds only
// decisions -- names, extra accounts, recipes, sites -- never a secret, so it
// can be committed to a dotfiles repo and carried to a new machine.
//
// Everything that can be read from the machine (which accounts exist, which
// Chrome profile is signed into which address) is discovered on every run
// instead of being written down here, so it never goes stale.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONFIG, LEGACY } from './paths.js'

const EMPTY = () => ({
  version: 1,
  // Accounts portal signed in itself: { provider, email, home, chrome? }.
  accounts: [],
  // name -> email. A name means a person, so it reaches their Claude and Codex accounts alike.
  names: {},
  // email -> Chrome profile directory, for an address no profile is signed into.
  chrome: {},
  // "provider:email" -> ISO date. Claude does not say when a plan renews, so it is typed in once.
  renews: {},
  // "provider:email" keys left off every screen.
  hidden: [],
  // name -> URL, for `portal open <site> <who>`.
  sites: {},
  // name -> { run: [...argv], check?: [...argv], browser?: 'env' | 'focus' }.
  recipes: {},
  // Where accounts are discovered from. 'auto' uses a source when it is present.
  sources: { orca: 'auto', default: 'auto' },
  setupDone: false,
})

let cached = null

export function load() {
  if (cached) return cached
  let raw = null
  try {
    raw = JSON.parse(readFileSync(CONFIG, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`could not read ${CONFIG}: ${err.message}`)
  }
  const cfg = { ...EMPTY(), ...(raw ?? {}) }
  cfg.exists = raw != null
  if (!raw) migrateLegacy(cfg)
  cached = cfg
  return cfg
}

export function save(cfg = cached) {
  const { exists, ...plain } = cfg
  mkdirSync(dirname(CONFIG), { recursive: true })
  const tmp = `${CONFIG}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(plain, null, 2) + '\n')
  renameSync(tmp, CONFIG)
  cfg.exists = true
  cached = cfg
}

// basketstar kept names in a file of its own; carry them over the first time.
function migrateLegacy(cfg) {
  if (!existsSync(LEGACY.aliases)) return
  try {
    const old = JSON.parse(readFileSync(LEGACY.aliases, 'utf8'))
    for (const [name, email] of Object.entries(old)) {
      if (typeof email === 'string') cfg.names[name.toLowerCase()] = email.toLowerCase()
    }
  } catch { /* an unreadable old file is not worth stopping for */ }
}

export const keyOf = (provider, email) => `${provider}:${String(email).toLowerCase()}`
