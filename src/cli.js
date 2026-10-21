// portal: every Claude and Codex account in one place, and every account's
// Chrome profile one command away.

import { profiles, launch } from './chrome.js'
import { keyOf, load, save } from './config.js'
import { discover } from './discover.js'
import { readState, leftOf } from './plan.js'
import { snapshot as poll } from './poll.js'
import { PROVIDERS, PROVIDER_ORDER } from './providers/index.js'
import { allRecipes, BUILTIN, prepare, probe, runPrepared, shellish } from './recipes.js'
import { people, resolveAccounts, resolvePerson } from './resolve.js'
import { setup } from './setup.js'
import { signIn } from './signin.js'
import * as store from './store.js'
import { home, nextLine } from './ui/home.js'
import { interactive } from './ui/prompt.js'
import { bold, dim, green, red, screen, yellow } from './ui/render.js'
import { accountsScreen, detail, historyScreen, planScreen, scheduleScreen } from './ui/screens.js'
import { nameOf } from './ui/words.js'

const WATCH_MIN_S = 60   // polling faster than this earns a 429

// Pages portal knows how to open. A site can be added like a name: portal site add mail https://mail.google.com
const SITES = {
  claude: { url: PROVIDERS.claude.urls.chat, usage: PROVIDERS.claude.urls.usage, provider: 'claude' },
  codex: { url: PROVIDERS.codex.urls.chat, usage: PROVIDERS.codex.urls.usage, provider: 'codex' },
  chatgpt: { url: 'https://chatgpt.com/', usage: PROVIDERS.codex.urls.usage, provider: 'codex' },
}

function parseArgs(argv) {
  const flags = {}, rest = []
  let passthrough = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { passthrough = argv.slice(i + 1); break }
    if (/^--?[a-z]/i.test(arg) && !/^-\d/.test(arg)) {
      const [k, v] = arg.replace(/^--?/, '').split('=')
      flags[k] = v ?? true
    } else rest.push(arg)
  }
  return { flags, rest, passthrough }
}

const say = (s = '') => console.log(s)
let FRESH = false
// --fresh asks every provider again even when the last reading is under a minute old.
const snapshot = (accounts, opts = {}) => poll(accounts, { fresh: FRESH, ...opts })

// ---------------------------------------------------------------- views

async function cmdHome(ctx) {
  const { cfg, accounts, flags } = ctx
  // A machine with nothing on it: walk through setup instead of an empty screen.
  if (accounts.length === 0) {
    if (interactive() && !flags.json) return setup(cfg, { firstRun: true })
    say(dim('\n  no accounts yet · run `portal setup` to add one\n'))
    return
  }
  const shown = accounts.filter(a => flags.hidden || !a.hidden)
  const snap = await snapshot(shown)
  if (flags.json) return say(JSON.stringify(jsonOf(snap), null, 2))
  say(home(snap, { showHidden: !!flags.hidden, all: !!flags.all }))
  if (!cfg.exists) say(dim('  first time here · ') + 'portal help' + dim(' for everything portal does\n'))
  // Keep what the first run carried over (names from basketstar), so it is
  // the user's file from now on.
  if (!cfg.exists) save(cfg)
}

function jsonOf(snap) {
  return snap.results.map(({ account, usage }) => {
    const a = snap.plans[account.provider]?.analyses.find(x => x.account.key === account.key)
    const { creds, ...acct } = account
    return {
      ...acct,
      state: readState(usage).kind,
      usage: usage.windows ? { ...usage, raw: undefined, windows: usage.windows.map(w => ({ ...w, leftPercent: leftOf(w) })) } : usage,
      plan: a ? { left: a.left, resetAt: a.resetAt, verdict: a.verdict, need: a.need, doing: a.doing, peak: a.ceiling, waste: a.waste } : null,
    }
  })
}

async function cmdDetail(ctx, selector) {
  const matches = resolvePerson(ctx.accounts, selector)
  const snap = await snapshot(matches)
  if (ctx.flags.json) return say(JSON.stringify(jsonOf(snap), null, 2))
  say(detail(snap.results, snap.plans))
}

async function cmdNext(ctx) {
  const snap = await snapshot(ctx.accounts.filter(a => !a.hidden))
  say('')
  let any = false
  for (const provider of PROVIDER_ORDER) {
    const p = snap.plans[provider]
    if (!p && !snap.results.some(r => r.account.provider === provider)) continue
    if (p?.steps.length) any = true
    say(nextLine(p, provider))
  }
  say('')
  if (!any) process.exitCode = 1
}

async function cmdPlan(ctx) {
  const snap = await snapshot(resolveAccounts(ctx.accounts, ctx.rest[0]))
  say(planScreen(snap.plans))
}

async function cmdSchedule(ctx) {
  const snap = await snapshot(resolveAccounts(ctx.accounts, ctx.rest[0]))
  say(scheduleScreen(snap.results, { all: !!ctx.flags.all }))
}

async function cmdHistory(ctx) {
  const snap = await snapshot(resolveAccounts(ctx.accounts, ctx.rest[0]))
  say(historyScreen(snap.plans))
}

async function cmdAccounts(ctx) {
  const snap = await snapshot(ctx.accounts)
  if (ctx.flags.json) return say(JSON.stringify(jsonOf(snap), null, 2))
  say(accountsScreen(snap.results))
}

async function cmdWatch(ctx) {
  const asked = Number(ctx.flags.interval)
  const interval = (Number.isFinite(asked) && asked >= WATCH_MIN_S ? asked : 300) * 1000
  const live = process.stdout.isTTY
  if (live) process.stdout.write('\x1b[?25l')
  const restore = () => { if (live) process.stdout.write('\x1b[?25h\n') }
  process.on('SIGINT', () => { restore(); process.exit(0) })
  process.on('exit', restore)
  const accounts = ctx.accounts.filter(a => !a.hidden)
  const tick = async () => {
    const snap = await snapshot(accounts, { quiet: true, fresh: true })
    if (live) process.stdout.write('\x1b[2J\x1b[H')
    say(home(snap))
    say(dim(`  updated ${new Date().toLocaleTimeString()} · every ${interval / 1000}s · ${store.stats().samples} readings · ctrl-c to stop`))
    setTimeout(tick, interval)
  }
  await tick()
}

// ----------------------------------------------------------------- open

// portal open claude            the account the planner picks, on its usage page
// portal open claude hash       hash's Claude, in hash's Chrome profile
// portal open hash              hash's Chrome profile
// portal open mail work         a site he added, in work's profile
// portal open all               every profile, one window each
async function cmdOpen(ctx) {
  const { cfg, flags, accounts } = ctx
  let [target, who] = ctx.rest
  if (!target) throw new Error('usage: portal open <claude|codex|chatgpt|site|who> [who]')
  const sites = { ...SITES, ...Object.fromEntries(Object.entries(cfg.sites ?? {}).map(([k, v]) => [k, typeof v === 'string' ? { url: v } : v])) }
  const dryRun = !!flags['dry-run']
  const go = (account, url) => {
    if (!account.chrome) throw new Error(`${account.email} has no Chrome profile · portal profile ${nameOf(account)} <profile>`)
    const cmd = launch(account.chrome, url, { dryRun })
    say(dim(dryRun ? `would run: ${cmd}` : `${account.chrome.label} · ${account.email}${url ? ` → ${url}` : ''}`))
  }

  if (target === 'all') {
    const seen = new Set()
    for (const a of accounts.filter(x => x.chrome && !x.hidden)) {
      if (seen.has(a.chrome.dir)) continue
      seen.add(a.chrome.dir)
      go(a, null)
    }
    return
  }

  // "open hash claude" means the same as "open claude hash".
  if (!sites[target.toLowerCase()] && who && sites[who.toLowerCase()]) [target, who] = [who, target]
  const site = sites[target.toLowerCase()]
  if (!site) return go(resolvePerson(accounts, target)[0], null)

  // The usage page by default, a fresh chat with --chat: his call, last version.
  const url = flags.chat || !site.usage ? site.url : site.usage
  if (site.provider && flags.all) {
    const seen = new Set()
    for (const a of accounts.filter(x => x.provider === site.provider && x.chrome && !x.hidden)) {
      if (seen.has(a.chrome.dir)) continue
      seen.add(a.chrome.dir)
      go(a, url)
    }
    return
  }
  if (who) {
    const matches = resolvePerson(accounts, who)
    return go((site.provider && matches.find(a => a.provider === site.provider)) ?? matches[0], url)
  }
  if (site.provider) {
    // No one named: the account the planner would have him use right now.
    const snap = await snapshot(accounts.filter(a => a.provider === site.provider && !a.hidden), { quiet: true })
    const p = snap.plans[site.provider]
    const pick = p?.steps[0]?.a ?? p?.next?.a
    if (!pick) throw new Error(`no ${site.provider} account to open`)
    say(dim(p.steps[0] ? `${nameOf(pick.account)} is the one to use now` : `nothing usable; ${nameOf(pick.account)} comes back first`))
    return go(pick.account, url)
  }
  if (site.who) return go(resolvePerson(accounts, site.who)[0], url)
  throw new Error(`say whose profile: portal open ${target} <who>`)
}

// ---------------------------------------------------------------- login

// portal login claude hash        a Claude sign-in of hash's own, in hash's profile
// portal login google work        gcloud (Drive + ADC) as work, in work's profile
// portal login vpn work -- --region eu   (a recipe he added)
async function cmdLogin(ctx) {
  const { cfg, flags, accounts, passthrough } = ctx
  const [what, who, ...extra] = ctx.rest
  const recipes = allRecipes(cfg)
  if (!what) throw new Error(`usage: portal login <claude|codex|${Object.keys(recipes).join('|')}> <who> [-- extra args]`)

  if (PROVIDERS[what]) {
    let email = null, profile = null
    if (who) {
      const person = resolvePerson(accounts, who)
      email = person[0].email
      profile = person[0].chrome
    }
    const r = await signIn(cfg, what, { email, profile, dryRun: !!flags['dry-run'], log: (s) => say(dim(s)) })
    if (r) say(r.mismatch ? yellow(`signed in as ${r.email}, not ${r.asked}`) : green(`✓ ${what} · ${r.email}`) + dim(' · readable from now on'))
    return
  }

  const recipe = recipes[what]
  if (!recipe) throw new Error(`no login recipe "${what}" · known: claude, codex, ${Object.keys(recipes).join(', ')}\n  add one: portal recipe add ${what} -- <command…>`)
  let account = null
  if (who) account = resolvePerson(accounts, who)[0]
  const profile = account?.chrome ?? (who ? findProfile(who) : null)
  if (!profile && who) throw new Error(`no Chrome profile for "${who}"`)
  const prepared = prepare(recipe, { email: account?.email ?? profile?.email, profile, extra: [...extra, ...(passthrough ?? [])] })
  const how = !profile ? '' : prepared.focus ? `bring up Chrome "${profile.label}", then ` : `send the sign-in page to Chrome "${profile.label}": `
  if (flags['dry-run']) return say(dim(`would ${how}run: ${shellish(prepared.argv)}`))
  if (profile) say(dim(`signing in through Chrome "${profile.label}" · ${shellish(prepared.argv)}`))
  const r = await runPrepared(prepared, profile)
  if (r.error) throw new Error(`could not run ${prepared.argv[0]}: ${r.error}`)
  if (r.code !== 0) process.exitCode = r.code
}

const findProfile = (text) => {
  const want = text.toLowerCase()
  return profiles().find(p => p.label.toLowerCase() === want || p.dir.toLowerCase() === want || p.email === want) ?? null
}

async function cmdAdd(ctx) {
  const { Stopped } = await import('./ui/prompt.js')
  try { return await addConversation(ctx) } catch (err) { if (!(err instanceof Stopped)) throw err; say(dim('\n  stopped · nothing was added\n')) }
}

async function addConversation(ctx) {
  const provider = ctx.rest[0]
  if (provider && !PROVIDERS[provider]) throw new Error('usage: portal add [claude|codex]')
  if (!interactive()) throw new Error('portal add asks which account and profile; run it in a terminal, or: portal login claude|codex <who>')
  const { choose, close } = await import('./ui/prompt.js')
  const which = provider ?? await choose('add which kind of account?', ['claude', 'codex'])
  const chrome = profiles()
  const taken = new Set(ctx.accounts.filter(a => a.provider === which).map(a => a.email))
  const profile = chrome.length ? await choose(`which Chrome profile should the ${which} sign-in open in?`, chrome, {
    label: (p) => `${p.label}${p.email ? dim(` · ${p.email}`) : ''}${taken.has(p.email) ? dim(' · already added') : ''}`,
    fallback: Math.max(0, chrome.findIndex(p => p.email && !taken.has(p.email))),
  }) : null
  close()
  const r = await signIn(ctx.cfg, which, { email: profile?.email || undefined, profile, log: (s) => say(dim('  ' + s)) })
  if (r) say(r.mismatch ? yellow(`  signed in as ${r.email}, not ${r.asked}`) : green(`  ✓ ${which} · ${r.email}`))
}

// ---------------------------------------------------------------- names

async function cmdName(ctx) {
  const { cfg, accounts, flags } = ctx
  const [name, who] = ctx.rest
  if (!name) return cmdAccounts(ctx)
  const key = name.toLowerCase()
  if (PROVIDERS[key] || SITES[key] || key === 'all') throw new Error(`"${name}" already means something to portal; pick another name`)
  if (flags.remove || flags.rm) {
    if (!(key in cfg.names)) throw new Error(`no name "${name}"`)
    delete cfg.names[key]
    save(cfg)
    return say(dim(`forgot "${name}"`))
  }
  if (!who) throw new Error('usage: portal name <name> <who>   (or: portal name <name> --remove)')
  cfg.names[key] = resolvePerson(accounts, who)[0].email
  save(cfg)
  say(dim(`"${name}" → ${cfg.names[key]}`))
}

function cmdProfile(ctx) {
  const [who, ...rest] = ctx.rest
  const wanted = rest.join(' ')
  if (!who || !wanted) {
    const rows = profiles().map(p => [bold(p.label), dim(p.dir), p.email || dim('not signed in')])
    return say(screen({ what: 'chrome profiles', rows, headers: ['profile', 'directory', 'signed in as'],
      footnotes: ['use one for an account: portal profile <who> <profile>'] }))
  }
  const person = resolvePerson(ctx.accounts, who)[0]
  const p = findProfile(wanted)
  if (!p) throw new Error(`no Chrome profile "${wanted}" · see: portal profile`)
  ctx.cfg.chrome[person.email] = p.label
  save(ctx.cfg)
  say(dim(`${person.email} → Chrome "${p.label}" (${p.dir})`))
}

function cmdHide(ctx, hide = true) {
  const matches = resolveAccounts(ctx.accounts, ctx.rest[0] ?? (() => { throw new Error(`usage: portal ${hide ? 'hide' : 'show'} <who>`) })())
  const set = new Set(ctx.cfg.hidden)
  for (const a of matches) hide ? set.add(a.key) : set.delete(a.key)
  ctx.cfg.hidden = [...set]
  save(ctx.cfg)
  say(dim(`${hide ? 'hidden' : 'shown'}: ${matches.map(a => `${a.provider} ${a.email}`).join(', ')}`))
}

function cmdRenews(ctx) {
  const [who, date] = ctx.rest
  if (!who || !date || Number.isNaN(Date.parse(date))) throw new Error('usage: portal renews <who> <YYYY-MM-DD>   (the next date the plan renews)')
  const matches = resolvePerson(ctx.accounts, who)
  const target = matches.find(a => a.provider === (ctx.flags.codex ? 'codex' : 'claude')) ?? matches[0]
  ctx.cfg.renews[target.key] = new Date(date).toISOString().slice(0, 10)
  save(ctx.cfg)
  say(dim(`${target.provider} ${target.email} renews ${ctx.cfg.renews[target.key]}`))
}

function cmdSite(ctx) {
  const { cfg } = ctx
  const [verb, name, url, who] = ctx.rest
  if (verb === 'add') {
    if (!name || !/^https?:\/\//.test(url ?? '')) throw new Error('usage: portal site add <name> <https://…> [default who]')
    cfg.sites[name.toLowerCase()] = who ? { url, who } : url
    save(cfg)
    return say(dim(`portal open ${name} <who> → ${url}`))
  }
  if (verb === 'rm' || verb === 'remove') {
    delete cfg.sites[String(name).toLowerCase()]
    save(cfg)
    return say(dim(`removed ${name}`))
  }
  const rows = [
    ...Object.entries(SITES).map(([k, v]) => [bold(k), v.url, dim(`built in · no who → the ${v.provider} account to use now`)]),
    ...Object.entries(cfg.sites ?? {}).map(([k, v]) => [bold(k), typeof v === 'string' ? v : v.url, dim(typeof v === 'string' ? '' : `default: ${v.who}`)]),
  ]
  say(screen({ what: 'sites', rows, headers: ['name', 'url', ''], footnotes: ['add one: portal site add <name> <url> [default who]   ·   open: portal open <name> <who>'] }))
}

function cmdRecipe(ctx) {
  const { cfg, passthrough, flags } = ctx
  const [verb, name] = ctx.rest
  if (verb === 'add') {
    if (!name || !passthrough?.length) throw new Error('usage: portal recipe add <name> [--check="cmd args"] [--env] -- <command> [args…]\n  {email} and {profile} in the command are filled in per account')
    cfg.recipes[name.toLowerCase()] = {
      run: passthrough,
      ...(typeof flags.check === 'string' ? { check: flags.check.split(/\s+/) } : {}),
      browser: flags.env ? 'env' : 'focus',
    }
    save(cfg)
    return say(dim(`portal login ${name} <who> → ${shellish(passthrough)}`))
  }
  if (verb === 'rm' || verb === 'remove') {
    delete cfg.recipes[String(name).toLowerCase()]
    save(cfg)
    return say(dim(`removed ${name}`))
  }
  const rows = [
    [bold('claude'), 'a Claude sign-in of its own', dim('claude auth login')],
    [bold('codex'), 'a Codex sign-in of its own', dim('codex login')],
    ...Object.entries(allRecipes(cfg)).map(([k, r]) => [bold(k), BUILTIN[k] && !cfg.recipes?.[k] ? r.about : 'yours', dim(shellish(r.run).slice(0, 48))]),
  ]
  say(screen({ what: 'login recipes', rows, headers: ['name', 'what', 'runs'],
    footnotes: ['run one: portal login <name> <who> [-- extra args]', 'add one: portal recipe add <name> -- <command> {email}'] }))
}

// Who every tool is signed in as right now, next to the people portal knows.
async function cmdCheck(ctx) {
  const recipes = Object.entries(allRecipes(ctx.cfg)).filter(([, r]) => r.check)
  const seen = new Set()
  const unique = recipes.filter(([, r]) => { const k = r.check.join(' '); if (seen.has(k)) return false; seen.add(k); return true })
  const results = await Promise.all(unique.map(async ([name, r]) => [name, r, await probe(r)]))
  const known = new Set(ctx.accounts.map(a => a.email))
  const rows = results.map(([name, r, res]) => [
    bold(name === 'google' ? 'gcloud' : name),
    !res ? dim('—') : res.ok ? (known.has(res.text) ? green(res.text) : res.text) : yellow(res.text || 'not signed in'),
    dim(shellish(r.check)),
  ])
  for (const provider of PROVIDER_ORDER) {
    const def = ctx.accounts.find(a => a.provider === provider && a.sources.includes('default'))
    rows.push([bold(provider), def ? green(def.email) : dim('—'), dim('the default login')])
  }
  say(screen({ what: 'check', note: 'who each tool is signed in as', rows, headers: ['tool', 'signed in as', 'from'] }))
}

// ----------------------------------------------------------------- help

const HELP = `
  ${bold('portal')} ${dim('— every Claude and Codex account in one place, each one a command away')}

  ${bold('see')}
    portal                         what to use now, when to switch, and what's left on every account
    portal <who>                   one account in full: every window, pace, renewal, sign-in
    portal next                    one line per provider: the account to use
    portal plan                    each week's pace: what it needs vs what it's getting, and what goes unused
    portal schedule                when each week comes back and each plan renews
    portal history                 the last 24h of every week, as a line
    portal watch                   the home screen, refreshed every 5 minutes
    portal accounts                every account: its names, sign-in, Chrome profile, renewal
    portal check                   who gcloud, gh, your recipes and the default CLIs are signed in as
      --all                          every window and model cap, not just what needs attention

  ${bold('open')}  ${dim('(in the account\'s own Chrome profile)')}
    portal open claude             the Claude account to use now, on its usage page
    portal open claude hash        hash's Claude usage page         ${dim('also: codex, chatgpt')}
    portal open codex --all        every Codex account, one window each
      --chat                         a new chat instead of the usage page
    portal open hash               hash's Chrome profile
    portal open all                every profile, one window each

  ${bold('sign in')}
    portal setup                   find accounts, sign in the ones that can't be read, add more
    portal add [claude|codex]      add an account: pick its Chrome profile, sign in once
    portal login claude hash       give hash's Claude a sign-in of its own, so it's always readable
    portal login google work       gcloud + Drive + ADC as work, the login page in work's profile
    portal login <recipe> <who>    gh, gcloud, adc, or your own  ${dim('-- passes flags through')}
    portal recipe add <name> -- <command {email}>      ${dim('register your own login, like an alias')}

  ${bold('names')}
    portal name work acme          "work" now means that account   ${dim('portal name work --remove')}
    portal profile <who> <profile> use a Chrome profile for an address no profile is signed into
    portal renews <who> <date>     when a Claude plan renews (Codex knows its own)
    portal hide <who> / show <who> keep an account off the screens  ${dim('(--hidden shows them)')}
    portal site add mail <url>     then: portal open mail work

  ${dim('<who> is a name you set, or any part of an address, Chrome profile name or plan.')}
  ${dim('Every number is what is left. --json for machines · --dry-run on open and login · --fresh to skip the 1-minute reuse')}
`

// --------------------------------------------------------------- main

const COMMANDS = {
  next: cmdNext, plan: cmdPlan, schedule: cmdSchedule, history: cmdHistory, watch: cmdWatch,
  accounts: cmdAccounts, ls: cmdAccounts, open: cmdOpen, o: cmdOpen,
  login: cmdLogin, auth: cmdLogin, add: cmdAdd,
  setup: (ctx) => setup(ctx.cfg), name: cmdName, alias: cmdName, profile: cmdProfile, profiles: cmdProfile,
  hide: (ctx) => cmdHide(ctx, true), show: (ctx) => cmdHide(ctx, false), renews: cmdRenews,
  site: cmdSite, sites: cmdSite, recipe: cmdRecipe, recipes: cmdRecipe, check: cmdCheck, whoami: cmdCheck,
}

export async function main(argv) {
  const { flags, rest, passthrough } = parseArgs(argv)
  FRESH = !!flags.fresh
  if (flags.help || flags.h || rest[0] === 'help') return say(HELP)
  if (flags.version || flags.v) return say('portal 1.0.0')
  try {
    const cfg = load()
    const { accounts } = discover(cfg)
    const command = COMMANDS[rest[0]] ? rest.shift() : null
    const ctx = { cfg, accounts, flags, rest, passthrough }
    if (command) await COMMANDS[command](ctx)
    else if (rest[0]) await cmdDetail(ctx, rest[0])
    else await cmdHome(ctx)
  } catch (err) {
    console.error(red('  ✗ ') + err.message)
    process.exitCode = 1
  }
}

export { keyOf, people, BUILTIN }
