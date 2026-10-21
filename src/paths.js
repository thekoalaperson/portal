// Where portal keeps its own things. Nothing here is a secret: tokens stay
// wherever the official CLIs put them, and portal only ever reads them.
//
// PORTAL_HOME puts everything under one directory, which is how the tests --
// and a fresh-device dry run -- get a clean slate.

import { homedir } from 'node:os'
import { join } from 'node:path'

const root = process.env.PORTAL_HOME
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share')

export const CONFIG = root ? join(root, 'config.json') : join(configHome, 'portal', 'config.json')
const DATA = root ? join(root, 'data') : join(dataHome, 'portal')
export const DB = process.env.PORTAL_DB ?? join(DATA, 'history.db')
// One directory per account that portal signed in itself. The path is part of
// the account's identity: Claude names its Keychain entry after the exact
// text of CLAUDE_CONFIG_DIR, so these are never renamed.
export const HOMES = join(DATA, 'homes')
export const CACHE = join(DATA, 'cache.json')

// basketstar, the version before this one. Read once to carry names and
// history over; never written.
export const LEGACY = {
  aliases: join(homedir(), '.local/share/basketstar/aliases.json'),
  db: join(homedir(), '.local/share/basketstar/history.db'),
}

export const HOME = homedir()
export const MAC = process.platform === 'darwin'
