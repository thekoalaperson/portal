// First run, and `portal setup` any time after: look around, say what was
// found, fix what needs a sign-in, offer to add more. Everything it finds is
// used without asking; it only asks about the things it cannot do alone.

import { profiles, chromeInstalled } from './chrome.js'
import { save } from './config.js'
import { discover, remember } from './discover.js'
import { which } from './platform.js'
import { snapshot } from './poll.js'
import { needsSignIn } from './plan.js'
import { allRecipes } from './recipes.js'
import { signIn } from './signin.js'
import { bold, dim, green, red, yellow } from './ui/render.js'
import { Stopped, choose, close, interactive, yes } from './ui/prompt.js'
import { nameOf, signInCommand } from './ui/words.js'

const say = (s = '') => console.log(s ? '  ' + s : '')
const tick = green('✓'), cross = dim('·')

// all: every account on this machine, hidden ones included (they are still
// remembered); the questions are only about the ones on screen.
export async function setup(cfg, all, opts = {}) {
  try {
    return await conversation(cfg, all, opts)
  } catch (err) {
    if (!(err instanceof Stopped)) throw err
    say()
    say(dim('setup stopped · nothing half-done was saved · run `portal setup` any time'))
    say()
  }
}

async function conversation(cfg, all, { firstRun = false } = {}) {
  say()
  say(bold('portal') + dim(firstRun ? ' · first run — setting up' : ' · setup'))
  say()

  let accounts = all.filter(a => !a.hidden)
  const chrome = profiles()
  const commands = [...new Set(['claude', 'codex', ...Object.values(allRecipes(cfg)).map(r => r.run[0])])]
  const toolLine = commands.map(t => which(t) ? `${tick} ${t}` : `${cross} ${dim(t)}`).join('  ')
  const fromOrca = accounts.filter(a => a.sources.includes('orca')).length

  say(dim('found on this machine'))
  say(`  chrome   ${!chromeInstalled() ? dim('not installed · accounts work without it, just no opening in profiles')
    : chrome.length === 0 ? dim('no profiles yet')
    : `${chrome.length} profile${chrome.length === 1 ? '' : 's'}` + dim(' · ' + chrome.slice(0, 4).map(p => p.label).join(', ') + (chrome.length > 4 ? ` +${chrome.length - 4}` : ''))}`)
  for (const provider of ['claude', 'codex']) {
    const mine = accounts.filter(a => a.provider === provider)
    say(`  ${provider.padEnd(7)}  ${mine.length ? `${mine.length} account${mine.length === 1 ? '' : 's'}` + dim(' · ' + mine.map(nameOf).join(', ')) : dim('none yet')}`)
  }
  if (fromOrca) say(`  orca     ${fromOrca} accounts ${dim('· read-only; orca keeps managing them')}`)
  say(`  tools    ${toolLine}`)
  say()

  // Accounts that only a login can make readable: each needs one sign-in of its own.
  let stuck = []
  if (accounts.length) {
    const snap = await snapshot(accounts, { quiet: true })
    stuck = snap.results.filter(r => needsSignIn(r.usage)).map(r => r.account)
    if (stuck.length === 0) say(`${tick} all ${accounts.length} accounts read live`)
    else say(yellow(`${stuck.length} of ${accounts.length} can't be read live`) + dim(' — each needs one sign-in of its own, then it stays readable'))
  }

  // No terminal to ask questions on (piped, or run from inside another tool):
  // say exactly what to run instead. Each one opens the browser by itself.
  if (!interactive()) {
    const width = Math.max(0, ...stuck.map(a => signInCommand(a).length))
    for (const a of stuck) say(`  ${signInCommand(a).padEnd(width)}  ` + dim(`${a.email} · opens in Chrome "${a.chrome?.label ?? 'default'}"`))
    say(dim('add another account: portal login claude|codex <who>, or portal add in a terminal'))
    return finish(cfg, all)
  }

  let signedIn = false
  for (const a of stuck) {
    if (!(await yes(`sign in ${bold(nameOf(a))} ${dim(`(${a.provider} · ${a.email})`)} now?`))) continue
    signedIn = await signInLoud(cfg, a.provider, { email: a.email, profile: a.chrome }) || signedIn
  }
  if (stuck.length) say()

  // More accounts, until he says done.
  for (;;) {
    const first = accounts.length === 0
    const want = await choose(first ? 'add your first account:' : 'add another account?', ['done', 'claude', 'codex'], {
      label: (x) => x === 'done' ? (first ? 'skip for now' : 'no, done') : `${x} account`, fallback: first ? 1 : 0,
    })
    if (want === 'done') break
    const profile = await pickProfile(accounts, want)
    if (await signInLoud(cfg, want, { email: profile?.email || undefined, profile })) {
      signedIn = true
      all = discover(cfg)
      accounts = all.filter(a => !a.hidden)
    }
  }
  if (signedIn) all = discover(cfg)

  // Accounts with no Chrome profile signed into their address.
  const homeless = all.filter(a => !a.hidden && !a.chrome)
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
  return finish(cfg, all)
}

// Which Chrome profile a new sign-in should open in; the first one not yet
// holding an account of this kind is the default.
export async function pickProfile(accounts, provider) {
  const chrome = profiles()
  if (chrome.length === 0) return null
  const taken = new Set(accounts.filter(a => a.provider === provider).map(a => a.email))
  return choose(`which Chrome profile should the ${provider} sign-in open in?`, chrome, {
    label: (p) => `${p.label}${p.email ? dim(` · ${p.email}`) : ''}${taken.has(p.email) ? dim(' · already added') : ''}`,
    fallback: Math.max(0, chrome.findIndex(p => p.email && !taken.has(p.email))),
  })
}

// What a sign-in came to, in one line.
export function reportSignIn(r, { indent = '' } = {}) {
  console.log(indent + (r.mismatch
    ? yellow(`signed in as ${r.email}, not ${r.asked}`) + dim(' — saved as that')
    : `${tick} ${r.provider} · ${r.email}` + dim(' · readable from now on')))
}

async function signInLoud(cfg, provider, opts) {
  try {
    reportSignIn(await signIn(cfg, provider, opts), { indent: '  ' })
    return true
  } catch (err) {
    say(red('✗ ') + err.message)
    return false
  }
}

function finish(cfg, all) {
  remember(cfg, all)
  save(cfg)
  say(`${tick} saved ${dim('· run')} portal ${dim('any time ·')} portal help ${dim('for everything else')}`)
  say()
}
