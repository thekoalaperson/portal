// Signing a Claude or Codex account in through its official CLI, into a
// config dir of its own. This is the method both vendors document for several
// accounts at once (CLAUDE_CONFIG_DIR, CODEX_HOME): each dir keeps its own
// login, the CLI renews it, and portal only reads it.
//
// The dir's path never changes once used -- Claude names the Keychain entry
// after its exact text -- so it gets a random name, not the address.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { keyOf, save } from './config.js'
import { codexIn } from './discover.js'
import { HOMES } from './paths.js'
import { readJson, which } from './platform.js'
import { prepare, runPrepared, shellish } from './recipes.js'

const INSTALL = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'npm install -g @openai/codex   (or: brew install codex)',
}

export function newHome(provider) {
  return join(HOMES, `${provider}-${randomBytes(4).toString('hex')}`)
}

export function whoIsIn(provider, home) {
  if (provider === 'claude') return readJson(join(home, '.claude.json'))?.oauthAccount?.emailAddress?.toLowerCase() ?? null
  return codexIn(home)?.email?.toLowerCase() ?? null
}

// The portal home already holding this person's login, if there is one.
export const homeFor = (cfg, provider, email) =>
  (cfg.accounts ?? []).find(a => a.provider === provider && a.email === email && a.home && existsSync(a.home))?.home ?? null

export async function signIn(cfg, provider, { email, profile, dryRun = false, log = console.log }) {
  if (!(await which(provider))) {
    throw new Error(`${provider} is not installed. Install it, then run this again:\n  ${INSTALL[provider]}`)
  }
  const home = (email && homeFor(cfg, provider, email)) ?? newHome(provider)
  const recipe = provider === 'claude'
    ? { run: ['claude', 'auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])], browser: 'focus' }
    : { run: ['codex', 'login'], browser: 'focus' }
  const env = provider === 'claude' ? { CLAUDE_CONFIG_DIR: home } : { CODEX_HOME: home }
  const prepared = prepare(recipe, { email, profile, env })

  const envText = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
  if (dryRun) {
    log(`would ${profile ? `bring up Chrome "${profile.label}", then ` : ''}run: ${envText} ${shellish(prepared.argv)}`)
    return null
  }
  mkdirSync(home, { recursive: true })
  if (profile) log(`signing in through Chrome "${profile.label}"${email ? ` as ${email}` : ''} …`)
  const r = await runPrepared(prepared, profile)
  if (r.error) throw new Error(`could not run ${provider}: ${r.error}`)

  const who = whoIsIn(provider, home)
  if (!who) throw new Error(`${provider} did not finish signing in (exit ${r.code}); nothing was saved`)

  // Whoever is signed in there is who the account is, even if it is not the
  // address that was asked for.
  cfg.accounts = (cfg.accounts ?? []).filter(a => a.home !== home && !(a.provider === provider && a.email === who))
  cfg.accounts.push({ provider, email: who, home })
  // By profile name, not directory: "Profile 6" means nothing on another machine.
  if (profile && profile.email !== who) cfg.chrome[who] = profile.label
  save(cfg)
  return { email: who, home, asked: email, mismatch: !!email && email !== who, key: keyOf(provider, who) }
}
