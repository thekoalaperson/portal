// Which account `claude` and `codex` use in a terminal: `portal use`.
//
// Nothing is copied. Every account portal signed in already has a config dir
// of its own, so switching is pointing CLAUDE_CONFIG_DIR / CODEX_HOME at it.
// A copy of a sign-in would be a second refresher, and the first renewal
// would sign the other copy out.
//
// The choice is a small shell file that every terminal re-reads before its
// prompt (one marked block in the shell's rc file loads it), so open terminals
// switch at their next prompt and new ones start switched. A session already
// running keeps the account it started with.
//
// A portal home holds only its login, so the things a person has built up in
// the default dir -- settings, plugins, skills, memory -- are linked into it.

import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { HOME, USE_SH } from './paths.js'
import { readJson } from './platform.js'

export const VAR = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
const DEFAULT_DIR = { claude: join(HOME, '.claude'), codex: join(HOME, '.codex') }

// What a person's setup is made of, as opposed to whose login it is. Logins
// (.claude.json, auth.json) and anything a running CLI keeps open (Codex's
// SQLite files, which must sit beside their -wal) are never shared.
const SHARED = {
  claude: ['settings.json', 'CLAUDE.md', 'keybindings.json', 'agents', 'commands', 'skills', 'plugins', 'output-styles',
    'projects', 'history.jsonl', 'file-history'],
  codex: ['config.toml', 'AGENTS.md', 'hooks.json', 'prompts', 'skills', 'plugins', 'rules'],
}

const MARK = '# added by portal use'

// Where an account's login lives: null for the default location, undefined
// when it has none portal can point at (an orca account from before orca gave
// each account a dir of its own).
export function homeOf(account) {
  if (account.creds.some(c => c.source === 'default' && !c.home)) return null
  return account.creds.find(c => c.source === 'portal' && c.home)?.home ?? account.creds.find(c => c.home)?.home
}

// The account a terminal's CLAUDE_CONFIG_DIR / CODEX_HOME reaches.
export function inUse(accounts, provider, env = process.env) {
  const dir = env[VAR[provider]]
  if (!dir || dir === DEFAULT_DIR[provider]) return accounts.find(a => a.provider === provider && homeOf(a) === null) ?? null
  return accounts.find(a => a.provider === provider && a.creds.some(c => c.home === dir)) ?? null
}

// Link the shared parts of the default dir into the home portal signed an
// account in to (orca's dirs are orca's). Never over anything already there:
// a home with its own copy keeps it, and says so.
export function share(provider, account) {
  const linked = [], own = []
  const home = account.creds.find(c => c.source === 'portal' && c.home)?.home
  if (!home) return { linked, own }
  for (const name of SHARED[provider]) {
    const from = join(DEFAULT_DIR[provider], name), to = join(home, name)
    if (!existsSync(from)) continue
    let there = null
    try { there = lstatSync(to) } catch { /* not there */ }
    if (!there) { symlinkSync(from, to); linked.push(name) }
    else if (!there.isSymbolicLink()) own.push(name)
  }
  return { linked, own }
}

// MCP servers added with `claude mcp add --scope user` live in ~/.claude.json,
// beside the default login, so they can't be shared without its account.
export function unsharedMcp() {
  return Object.keys(readJson(join(HOME, '.claude.json'))?.mcpServers ?? {})
}

const quote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`
const tilde = (p) => p.startsWith(HOME + '/') ? `$HOME/${p.slice(HOME.length + 1)}` : p

// The file every terminal reads. The stamp makes a terminal apply a choice
// once: an `export` typed by hand afterwards stands until the next `portal use`.
export function writeChoice(choice) {
  const lines = []
  for (const [provider, c] of Object.entries(choice)) {
    lines.push(c.home ? `  export ${VAR[provider]}=${quote(c.home)}   # ${c.email}` : `  unset ${VAR[provider]}   # the default login${c.email ? `: ${c.email}` : ''}`)
  }
  const stamp = Date.now()
  mkdirSync(join(USE_SH, '..'), { recursive: true })
  writeFileSync(USE_SH, [
    '# Written by `portal use`: which account `claude` and `codex` use in a terminal.',
    '# Every terminal reads this before its prompt. Change it with `portal use`, not by hand.',
    `if [ "\${_PORTAL_USE-}" != "${stamp}" ]; then`,
    `  _PORTAL_USE=${stamp}`,
    ...lines,
    'fi',
    '',
  ].join('\n'))
}

// The block that makes a shell read the choice before every prompt.
function hookFor(shell) {
  const file = `"${tilde(USE_SH)}"`
  const fn = `_portal_use() { [ -r ${file} ] && . ${file}; return 0; }`
  if (shell === 'zsh') {
    return { rc: join(process.env.ZDOTDIR || HOME, '.zshrc'), lines: [fn,
      '(( ${precmd_functions[(I)_portal_use]} )) || precmd_functions+=(_portal_use)', '_portal_use'] }
  }
  if (shell === 'bash') {
    return { rc: join(HOME, process.platform === 'darwin' ? '.bash_profile' : '.bashrc'), lines: [fn,
      'case ";${PROMPT_COMMAND-};" in *";_portal_use;"*) ;; *) PROMPT_COMMAND="_portal_use${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;; esac', '_portal_use'] }
  }
  return null
}

// Put the block in the shell's rc file once. Says what it did, or what to do
// by hand when it can't (another shell, or PORTAL_NO_MODIFY_RC set).
export function installHook() {
  const shell = basename(process.env.SHELL ?? '')
  const hook = hookFor(shell)
  if (!hook) return { manual: `your shell (${shell || 'unknown'}) isn't one portal can set up yet · set ${VAR.claude} / ${VAR.codex} from ${USE_SH} yourself` }
  let text = ''
  try { text = readFileSync(hook.rc, 'utf8') } catch { /* no rc file yet */ }
  if (text.includes(MARK)) return { rc: hook.rc, already: true }
  const block = `\n${MARK}: which Claude/Codex account terminals use\n${hook.lines.join('\n')}\n`
  if (process.env.PORTAL_NO_MODIFY_RC) return { rc: hook.rc, manual: `add this to ${hook.rc}:${block}` }
  appendFileSync(hook.rc, block)
  return { rc: hook.rc, added: true }
}
