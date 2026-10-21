// The one file a person edits, or lets `portal` edit for them. It holds only
// decisions -- names, extra accounts, recipes, sites -- never a secret, so it
// can be committed to a dotfiles repo and carried to a new machine.
//
// Everything that can be read from the machine (which accounts exist, which
// Chrome profile is signed into which address) is discovered on every run
// instead of being written down here, so it never goes stale.

import { existsSync, readFileSync } from 'node:fs'
import { CONFIG, LEGACY } from './paths.js'
import { readJson, writeJson } from './platform.js'

const EMPTY = () => ({
  version: 1,
  // Accounts portal signed in itself ({ provider, email, home }), and every
  // other account this machine has seen ({ provider, email }) -- so a config
  // carried to a new computer knows what to sign in there.
  accounts: [],
  // name -> email, or -> { profile } for a Chrome profile signed into none.
  // A name means a person, so it reaches their Claude and Codex accounts alike.
  names: {},
  // email -> Chrome profile name, for an address no profile is signed into.
  chrome: {},
  // "provider:email" -> ISO date. Claude does not say when a plan renews, so it is typed in once.
  renews: {},
  // "provider:email" keys left off every screen.
  hidden: [],
  // name -> URL (or { url, who }), for `portal open <site> <who>`.
  sites: {},
  // name -> { run: [...argv], check?: [...argv], browser?: 'env' | 'focus' }.
  recipes: {},
  // provider -> the email `claude` / `codex` use in a terminal, or null for the
  // default login. A provider left out is never touched. Set by `portal use`.
  use: {},
  // Where accounts are discovered from. 'auto' uses a source when it is present.
  sources: { orca: 'auto', default: 'auto' },
})

export function load() {
  let raw = null
  try {
    raw = JSON.parse(readFileSync(CONFIG, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`could not read ${CONFIG}: ${err.message}`)
  }
  // Every field is there and the right shape from here on, hand-edited or not,
  // so nothing downstream has to guard against a missing or null one.
  const cfg = EMPTY()
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!(k in cfg) || (v != null && Array.isArray(v) === Array.isArray(cfg[k]) && typeof v === typeof cfg[k])) cfg[k] = v
  }
  cfg.exists = raw != null
  if (!raw) migrateLegacy(cfg)
  return cfg
}

export function save(cfg) {
  const { exists, ...plain } = cfg
  writeJson(CONFIG, plain, { pretty: true })
  cfg.exists = true
}

// basketstar kept names in a file of its own; carry them over the first time.
function migrateLegacy(cfg) {
  if (!existsSync(LEGACY.aliases)) return
  for (const [name, email] of Object.entries(readJson(LEGACY.aliases) ?? {})) {
    if (typeof email === 'string') cfg.names[name.toLowerCase()] = email.toLowerCase()
  }
}

export const keyOf = (provider, email) => `${provider}:${String(email).toLowerCase()}`
