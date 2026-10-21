// First run, and `portal setup` any time after: look around, say what was
// found, fix what needs a sign-in, offer to add more. Everything it finds is
// used without asking; it only asks about the things it cannot do alone.

import { profiles, chromeInstalled } from './chrome.js'
import { save } from './config.js'
import { discover, remember } from './discover.js'
import { which } from './platform.js'
import { snapshot } from './poll.js'
import { readState } from './plan.js'
import { allRecipes } from './recipes.js'
import { signIn } from './signin.js'
import { bold, dim, green, red, shortEmail, yellow } from './ui/render.js'
import { Stopped, choose, close, interactive, yes } from './ui/prompt.js'
import { handleOf, nameOf } from './ui/words.js'

const say = (s = '') => console.log(s ? '  ' + s : '')
const tick = green('✓'), cross = dim('·')

export async function setup(cfg, opts = {}) {
  try {
    return await conversation(cfg, opts)
  } catch (err) {
    if (!(err instanceof Stopped)) throw err
    say()
    say(dim('setup stopped · nothing half-done was saved · run `portal setup` any time'))
    say()
  }
}

async function conversation(cfg, { firstRun = false } = {}) {
  say()
  say(bold('portal') + dim(firstRun ? ' · first run — setting up' : ' · setup'))
  say()

  let { accounts, found } = discover(cfg)
  const chrome = profiles()
  const commands = [...new Set(['claude', 'codex', ...Object.values(allRecipes(cfg)).map(r => r.run[0])])]
  const tools = await Promise.all(commands.map(async (t) => [t, await which(t)]))
  const toolLine = tools.map(([t, p]) => (p ? tick : cross) + ' ' + (p ? t : dim(t))).join('  ')

  say(dim('found on this machine'))
  say(`  chrome   ${!chromeInstalled() ? dim('not installed · accounts work without it, just no opening in profiles')
    : chrome.length === 0 ? dim('no profiles yet')
    : `${chrome.length} profile${chrome.length === 1 ? '' : 's'}` + dim(' · ' + chrome.slice(0, 4).map(p => p.label).join(', ') + (chrome.length > 4 ? ` +${chrome.length - 4}` : ''))}`)
  for (const provider of ['claude', 'codex']) {
    const mine = accounts.filter(a => a.provider === provider)
    say(`  ${provider.padEnd(7)}  ${mine.length ? `${mine.length} account${mine.length === 1 ? '' : 's'}` + dim(' · ' + mine.map(a => nameOf(a)).join(', ')) : dim('none yet')}`)
  }
  if (found.orca) say(`  orca     ${found.orca.length} accounts ${dim('· read-only; orca keeps managing them')}`)
  say(`  tools    ${toolLine}`)
  say()

  // Accounts that cannot be read live: each needs one sign-in of its own.
  let stuck = []
  if (accounts.length) {
    const snap = await snapshot(accounts, { quiet: true })
    stuck = snap.results.filter(r => readState(r.usage).kind !== 'live' && !r.account.hidden)
    if (stuck.length === 0) say(`${tick} all ${accounts.length} accounts read live`)
    else say(yellow(`${stuck.length} of ${accounts.length} can't be read live`) + dim(' — each needs one sign-in of its own, then it stays readable'))
  }

  // No terminal to ask questions on (piped, or run from inside another tool):
  // say exactly what to run instead. Each one opens the browser by itself.
  if (!interactive()) {
    const cmds = stuck.map(({ account }) => [`portal login ${account.provider} ${handleOf(account)}`, account])
    const width = Math.max(0, ...cmds.map(([c]) => c.length))
    for (const [c, account] of cmds) say(`  ${c.padEnd(width)}  ` + dim(`${account.email} · opens in Chrome "${account.chrome?.label ?? 'default'}"`))
    say(dim('add another account: portal login claude|codex <who>, or portal add in a terminal'))
    return finish(cfg)
  }

  if (stuck.length) {
    {
      for (const { account } of stuck) {
        if (!(await yes(`sign in ${bold(nameOf(account))} ${dim(`(${account.provider} · ${account.email})`)} now?`))) continue
        await signInLoud(cfg, account.provider, { email: account.email, profile: account.chrome })
      }
    }
    say()
  }

  // More accounts, until he says done.
  for (;;) {
    const fresh = accounts.length === 0
    const want = await choose(fresh ? 'add your first account:' : 'add another account?', ['done', 'claude', 'codex'], {
      label: (x) => x === 'done' ? (fresh ? 'skip for now' : 'no, done') : `${x} account`, fallback: fresh ? 1 : 0,
    })
    if (want === 'done') break
    const profile = await pickProfile(accounts, want)
    await signInLoud(cfg, want, { email: profile?.email || undefined, profile })
    ;({ accounts } = discover(cfg))
  }

  // Accounts with no Chrome profile signed into their address.
  const homeless = accounts.filter(a => !a.chrome)
  if (homeless.length && chrome.length) {
    say()
    for (const a of homeless) {
      const p = await choose(`which Chrome profile is ${bold(a.email)} used in?`, [null, ...chrome], {
        label: (x) => x ? `${x.label}${x.email ? dim(` · ${x.email}`) : ''}` : dim('none — skip'), fallback: 0,
      })
      if (p) cfg.chrome[a.email] = p.label
    }
  }
  close()
  return finish(cfg)
}

async function pickProfile(accounts, provider) {
  const chrome = profiles()
  if (chrome.length === 0) return null
  const taken = new Set(accounts.filter(a => a.provider === provider).map(a => a.email))
  const first = Math.max(0, chrome.findIndex(p => p.email && !taken.has(p.email)))
  return choose(`which Chrome profile should the ${provider} sign-in open in?`, chrome, {
    label: (p) => `${p.label}${p.email ? dim(` · ${p.email}`) : ''}${taken.has(p.email) ? dim(' · already added') : ''}`,
    fallback: first,
  })
}

async function signInLoud(cfg, provider, opts) {
  try {
    const r = await signIn(cfg, provider, opts)
    if (r.mismatch) say(yellow(`signed in as ${r.email}, not ${r.asked}`) + dim(' — saved as that'))
    else say(`${tick} ${provider} · ${r.email}`)
  } catch (err) {
    say(red('✗ ') + err.message)
  }
}

function finish(cfg) {
  remember(cfg, discover(cfg).accounts)
  cfg.setupDone = true
  save(cfg)
  say(`${tick} saved ${dim('· run')} portal ${dim('any time ·')} portal help ${dim('for everything else')}`)
  say()
}

export { shortEmail }
