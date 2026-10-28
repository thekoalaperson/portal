// portal: every Claude and Codex account in one place, and every account's
// Chrome profile one command away.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blocked, blockedFix, findProfile, launch, profileFor, profiles } from './chrome.js'
import { load, save } from './config.js'
import { discover } from './discover.js'
import { leftOf, readState } from './plan.js'
import { readJson } from './platform.js'
import { snapshot as poll } from './poll.js'
import { PROVIDERS, PROVIDER_ORDER } from './providers/index.js'
import { allRecipes, BUILTIN, prepare, probe, runPrepared, shellish } from './recipes.js'
import { locate, notFound, resolveAccounts, resolvePerson, resolveProfile } from './resolve.js'
import * as store from './store.js'
import { homeOf, inUse, installHook, share, unsharedMcp, VAR, writeChoice } from './use.js'
import { home, nextLine } from './ui/home.js'
import { interactive } from './ui/prompt.js'
import { bold, dim, green, red, screen, yellow } from './ui/render.js'
import { accountsScreen, detail, historyScreen, planScreen, scheduleScreen } from './ui/screens.js'
import { nameOf } from './ui/words.js'

const WATCH_MIN_S = 60   // polling faster than this earns a 429
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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
    if (/^--?[a-z]/i.test(arg)) {
      const [k, v] = arg.replace(/^--?/, '').split('=')
      flags[k] = v ?? true
    } else rest.push(arg)
  }
  return { flags, rest, passthrough }
}

const say = (s = '') => console.log(s)
const printJson = (snap) => say(JSON.stringify(jsonOf(snap), null, 2))
let FRESH = false
// --fresh asks every provider again even when the last reading is under a minute old.
const snapshot = (accounts, opts = {}) => poll(accounts, { fresh: FRESH, ...opts })

// ---------------------------------------------------------------- views

async function cmdHome(ctx) {
  const { cfg, accounts, flags } = ctx
  // A machine with nothing on it: walk through setup instead of an empty screen.
  if (accounts.length === 0) {
    if (interactive() && !flags.json) return (await import('./setup.js')).setup(cfg, ctx.allAccounts, { firstRun: true })
    return say(dim('\n  no accounts yet · run `portal setup` to add one\n'))
  }
  const snap = await snapshot(accounts)
  if (flags.json) return printJson(snap)
  say(home(snap, { all: !!flags.all }))
  // Keep what the first run carried over (names from basketstar), so it is
  // the user's file from now on.
  if (!cfg.exists) {
    say(dim('  first time here · ') + 'portal help' + dim(' for everything portal does\n'))
    save(cfg)
  }
}

function jsonOf(snap) {
  const analyses = new Map(Object.values(snap.plans).flatMap(p => p.analyses).map(a => [a.account, a]))
  return snap.results.map(({ account, usage }) => {
    const a = analyses.get(account)
    const { creds, ...acct } = account
    return {
      ...acct,
      state: readState(usage).kind,
      usage: usage.windows ? { ...usage, windows: usage.windows.map(w => ({ ...w, leftPercent: leftOf(w) })) } : usage,
      plan: a ? { left: a.left, resetAt: a.resetAt, verdict: a.verdict, need: a.need, doing: a.doing, peak: a.ceiling, waste: a.waste } : null,
    }
  })
}

async function cmdDetail(ctx, selector) {
  const t = resolveProfile(ctx.accounts, ctx.cfg, selector)
  if (!t.accounts.length) {
    const p = t.profile
    return say(dim(`\n  "${selector}" is the Chrome profile "${p.label}"${p.email ? ` (${p.email})` : ''}, with no Claude or Codex account here\n  `) +
      `portal open ${selector}` + dim(' opens it · ') + `portal login gh ${selector}` + dim(' signs in there · ') + `portal login claude ${selector}` + dim(' adds an account\n'))
  }
  const snap = await snapshot(t.accounts)
  if (ctx.flags.json) return printJson(snap)
  say(detail(snap.results, snap.plans))
}

async function cmdNext(ctx) {
  const snap = await snapshot(ctx.accounts)
  say('')
  let any = false
  for (const provider of PROVIDER_ORDER) {
    const p = snap.plans[provider]
    if (!p) continue
    if (p.steps.length) any = true
    say(nextLine(p, provider))
  }
  say('')
  if (!any) process.exitCode = 1
}

// plan, schedule, history: the same reading, a different screen.
const screenOf = (render) => async (ctx) => say(render(await snapshot(resolveAccounts(ctx.accounts, ctx.rest[0])), ctx))
const cmdPlan = screenOf((snap) => planScreen(snap.plans))
const cmdSchedule = screenOf((snap, ctx) => scheduleScreen(snap.results, { all: !!ctx.flags.all }))
const cmdHistory = screenOf((snap) => historyScreen(snap.plans))

async function cmdAccounts(ctx) {
  const snap = await snapshot(ctx.allAccounts)
  if (ctx.flags.json) return printJson(snap)
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
  const tick = async () => {
    const snap = await snapshot(ctx.accounts, { quiet: true, fresh: true })
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
  const sites = { ...SITES, ...Object.fromEntries(Object.entries(cfg.sites).map(([k, v]) => [k, typeof v === 'string' ? { url: v } : v])) }
  const dryRun = !!flags['dry-run']
  const show = (profile, email, url, who) => {
    if (!profile) throw new Error(`${email ?? who} has no Chrome profile · portal profile ${who ?? email} <profile>`)
    const cmd = launch(profile, url, { dryRun })
    say(dim(dryRun ? `would run: ${cmd}` : `${profile.label}${email ? ` · ${email}` : ''}${url ? ` → ${url}` : ''}`))
  }
  const go = (account, url) => show(account.chrome, account.email, url, nameOf(account))
  const goTo = (who, url) => { const t = resolveProfile(accounts, cfg, who); show(t.profile, t.email, url, who) }
  // One window per Chrome profile, however many accounts share it.
  const openEach = (list, url) => {
    const seen = new Set()
    for (const a of list.filter(x => x.chrome)) {
      if (!seen.has(a.chrome.dir)) { seen.add(a.chrome.dir); go(a, url) }
    }
  }

  if (target === 'all') return openEach(accounts, null)

  // "open hash claude" means the same as "open claude hash".
  if (!sites[target.toLowerCase()] && who && sites[who.toLowerCase()]) [target, who] = [who, target]
  const site = sites[target.toLowerCase()]
  if (!site) return goTo(target, null)

  // The usage page by default, a fresh chat with --chat: his call, last version.
  const url = flags.chat || !site.usage ? site.url : site.usage
  if (site.provider && flags.all) return openEach(accounts.filter(x => x.provider === site.provider), url)
  if (who) return goTo(who, url)
  if (site.provider) return go(await pickNow(accounts, site.provider), url)
  if (site.who) return goTo(site.who, url)
  throw new Error(`say whose profile: portal open ${target} <who>`)
}

// No one named: the account the planner would have him use right now, or the
// one that comes back first.
async function pickNow(accounts, provider) {
  const snap = await snapshot(accounts.filter(a => a.provider === provider), { quiet: true })
  const p = snap.plans[provider]
  const pick = p?.steps[0]?.a ?? p?.next?.a
  if (!pick) throw new Error(`no ${provider} account to pick`)
  say(dim(p.steps[0] ? `${nameOf(pick.account)} is the one to use now` : `nothing usable; ${nameOf(pick.account)} comes back first`))
  return pick.account
}

// ------------------------------------------------------------------ use

// portal use                    who `claude` and `codex` use in a terminal
// portal use hash               hash's Claude and Codex, in every terminal
// portal use claude hash        only Claude
// portal use claude             the Claude account to use now
// portal use default            back to the default logins
async function cmdUse(ctx) {
  const { cfg, accounts } = ctx
  let [first, second] = ctx.rest
  if (!first) return useStatus(ctx)
  // "use hash claude" means the same as "use claude hash".
  if (!PROVIDERS[first] && second && PROVIDERS[second]) [first, second] = [second, first]
  const provider = PROVIDERS[first] ? first : null
  const who = provider ? second : first

  const picks = {}   // provider -> account, or null for the default login
  if (who?.toLowerCase() === 'default') for (const p of provider ? [provider] : PROVIDER_ORDER) picks[p] = null
  else if (!who) picks[provider] = await pickNow(accounts, provider)
  else for (const a of resolvePerson(provider ? accounts.filter(a => a.provider === provider) : accounts, who)) picks[a.provider] = a

  say('')
  for (const [p, account] of Object.entries(picks)) {
    const home = account ? homeOf(account) : null
    if (home === undefined) throw new Error(`${account.email} has no ${p} config dir portal can point at · sign it in: portal login ${p} ${account.email}`)
    cfg.use[p] = home ? account.email : null
    const def = account && !home ? account : ctx.allAccounts.find(a => a.provider === p && homeOf(a) === null)
    say(`  ${bold(p.padEnd(6))} → ${green(home ? account.email : def?.email ?? 'the default login')}` + dim(home ? '' : ' · the default login'))
    if (!home) continue
    const { linked, own } = share(p, account)
    if (linked.length) say(dim(`           shares ${linked.join(', ')} with ~/.${p}`))
    if (own.length) say(dim(`           keeps its own ${own.join(', ')}`))
    const mcp = p === 'claude' ? unsharedMcp() : []
    if (mcp.length) say(yellow(`           your user MCP servers (${mcp.join(', ')}) live with the default login: add them here with claude mcp add`))
  }
  save(cfg)
  writeChoice(choiceOf(cfg, ctx.allAccounts))

  const hook = installHook()
  say('')
  if (hook.manual) say(yellow(`  ${hook.manual}`))
  else if (hook.added) say(dim(`  added a block to ${hook.rc} · this terminal follows once you open a new one or run: source ${hook.rc}`))
  else say(dim('  every terminal switches at its next prompt · a session already running keeps its account'))
  say('')
}

// Every provider `portal use` has a say in, with the dir it points at now.
function choiceOf(cfg, accounts) {
  return Object.fromEntries(Object.entries(cfg.use).map(([p, email]) => {
    const account = email && accounts.find(a => a.provider === p && a.email === email)
    const home = account ? homeOf(account) : null
    return [p, { email: home ? email : null, home: home ?? null }]
  }))
}

function useStatus(ctx) {
  const { cfg } = ctx
  const rows = PROVIDER_ORDER.map((p) => {
    const chosen = p in cfg.use
    const account = chosen && cfg.use[p] ? ctx.allAccounts.find(a => a.provider === p && a.email === cfg.use[p]) : ctx.allAccounts.find(a => a.provider === p && homeOf(a) === null)
    const here = inUse(ctx.allAccounts, p)
    return [bold(p), account ? green(account.email) : dim('—'), dim(chosen && cfg.use[p] ? 'portal use' : 'the default login'),
      here?.email === account?.email ? '' : yellow(`this terminal: ${here?.email ?? process.env[VAR[p]] ?? 'the default login, signed out'}`)]
  })
  say(screen({ what: 'use', note: 'the account `claude` and `codex` use in a terminal', rows, headers: ['tool', 'account', 'from', ''],
    footnotes: ['switch: portal use <who>   ·   one tool: portal use claude <who>   ·   the one to use now: portal use claude', 'back to the default logins: portal use default'] }))
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
    // A known account, or a new one named by its address or its Chrome
    // profile -- so an account can be added without a terminal to ask on.
    let email = null, profile = null
    if (who) {
      const t = locate(accounts, cfg, who)
      if (t) ({ email, profile } = t)
      else if (who.includes('@')) { email = who.toLowerCase(); profile = profileFor(email, cfg) }
      else throw notFound(accounts, who)
    }
    const { signIn } = await import('./signin.js')
    const r = await signIn(cfg, what, { email, profile, dryRun: !!flags['dry-run'], log: (s) => say(dim(s)) })
    if (r) (await import('./setup.js')).reportSignIn(r)
    return
  }

  const recipe = recipes[what]
  if (!recipe) throw new Error(`no login recipe "${what}" · known: claude, codex, ${Object.keys(recipes).join(', ')}\n  add one: portal recipe add ${what} -- <command…>`)
  const target = who ? resolveProfile(accounts, cfg, who) : null
  const profile = target?.profile ?? null
  if (who && !profile) throw new Error(`${target.email} has no Chrome profile · portal profile ${who} <profile>`)
  const prepared = prepare(recipe, { email: target?.email ?? null, profile, extra: [...extra, ...(passthrough ?? [])] })
  const how = !profile ? '' : prepared.focus ? `bring up Chrome "${profile.label}", then ` : `send the sign-in page to Chrome "${profile.label}": `
  if (flags['dry-run']) return say(dim(`would ${how}run: ${shellish(prepared.argv)}`))
  if (profile) say(dim(`signing in through Chrome "${profile.label}" · ${shellish(prepared.argv)}`))
  const r = await runPrepared(prepared, profile)
  if (r.error) throw new Error(`could not run ${prepared.argv[0]}: ${r.error}`)
  if (r.code !== 0) process.exitCode = r.code
}

async function cmdAdd(ctx) {
  const provider = ctx.rest[0]
  if (provider && !PROVIDERS[provider]) throw new Error('usage: portal add [claude|codex]')
  if (!interactive()) throw new Error('portal add asks which account and profile; run it in a terminal, or: portal login claude|codex <who>')
  const { Stopped, choose, close } = await import('./ui/prompt.js')
  const { pickProfile, reportSignIn } = await import('./setup.js')
  const { signIn } = await import('./signin.js')
  try {
    const which = provider ?? await choose('add which kind of account?', ['claude', 'codex'])
    const profile = await pickProfile(ctx.accounts, which)
    close()
    reportSignIn(await signIn(ctx.cfg, which, { email: profile?.email || undefined, profile, log: (s) => say(dim('  ' + s)) }), { indent: '  ' })
  } catch (err) {
    if (!(err instanceof Stopped)) throw err
    say(dim('\n  stopped · nothing was added\n'))
  }
}

// ---------------------------------------------------------------- names

async function cmdName(ctx) {
  const { cfg, flags } = ctx
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
  if (!who) throw new Error('usage: portal alias <name> <account or Chrome profile>   (or: portal alias <name> --remove)')
  const target = resolveProfile(ctx.allAccounts, cfg, who)
  // An address when there is one (it reaches the account and its profile
  // alike, on any machine); a profile's own name for a profile signed into none.
  cfg.names[key] = target.email ?? { profile: target.profile.label }
  save(cfg)
  say(dim(`"${name}" → ${target.email ?? `Chrome "${target.profile.label}"`}` + (target.accounts.length || !target.profile ? '' : ` · Chrome profile "${target.profile.label}", no Claude/Codex account`)))
}

function cmdProfile(ctx) {
  const [who, ...rest] = ctx.rest
  const wanted = rest.join(' ')
  if (!who || !wanted) {
    if (!profiles().length && blocked) throw new Error(`can't read Chrome profiles: macOS blocks this terminal from Chrome's data · ${blockedFix()}`)
    const names = Object.entries(ctx.cfg.names)
    const rows = profiles().map(p => {
      const mine = names.filter(([, v]) => typeof v === 'string' ? !!p.email && v === p.email : v?.profile === p.label || v?.profile === p.dir).map(([n]) => n)
      const kinds = [...new Set(ctx.allAccounts.filter(a => a.chrome?.dir === p.dir).map(a => a.provider))]
      return [bold(p.label), p.email || dim('not signed in'), mine.join(', ') || dim('—'), kinds.join(', ') || dim('—'), dim(p.dir)]
    })
    return say(screen({ what: 'chrome profiles', rows, headers: ['profile', 'signed in as', 'names', 'accounts', 'directory'],
      footnotes: ['name one: portal alias <name> <profile>   ·   then: portal open <name>, portal login gh <name>',
        'use one for an account no profile is signed into: portal profile <who> <profile>'] }))
  }
  const person = resolvePerson(ctx.allAccounts, who)[0]
  const p = findProfile(wanted)
  if (!p) throw new Error(`no Chrome profile "${wanted}" · see: portal profiles`)
  ctx.cfg.chrome[person.email] = p.label
  save(ctx.cfg)
  say(dim(`${person.email} → Chrome "${p.label}" (${p.dir})`))
}

function cmdHide(ctx, hide = true) {
  if (!ctx.rest[0]) throw new Error(`usage: portal ${hide ? 'hide' : 'show'} <who>`)
  const matches = resolveAccounts(ctx.allAccounts, ctx.rest[0])
  const set = new Set(ctx.cfg.hidden)
  for (const a of matches) hide ? set.add(a.key) : set.delete(a.key)
  ctx.cfg.hidden = [...set]
  save(ctx.cfg)
  say(dim(`${hide ? 'hidden' : 'shown'}: ${matches.map(a => `${a.provider} ${a.email}`).join(', ')}`))
}

function cmdRenews(ctx) {
  const [who, date] = ctx.rest
  if (!who || !date || Number.isNaN(Date.parse(date))) throw new Error('usage: portal renews <who> <YYYY-MM-DD>   (the next date the plan renews)')
  const matches = resolvePerson(ctx.allAccounts, who)
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
    ...Object.entries(cfg.sites).map(([k, v]) => [bold(k), typeof v === 'string' ? v : v.url, dim(typeof v === 'string' ? '' : `default: ${v.who}`)]),
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
    ...Object.entries(allRecipes(cfg)).map(([k, r]) => [bold(k), BUILTIN[k] && !cfg.recipes[k] ? r.about : 'yours', dim(shellish(r.run).slice(0, 48))]),
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
  const known = new Set(ctx.allAccounts.map(a => a.email))
  const rows = results.map(([name, r, res]) => [
    bold(name === 'google' ? 'gcloud' : name),
    !res ? dim('—') : res.ok ? (known.has(res.text) ? green(res.text) : res.text) : yellow(res.text || 'not signed in'),
    dim(shellish(r.check)),
  ])
  // What `claude` and `codex` reach from this terminal.
  for (const provider of PROVIDER_ORDER) {
    const here = inUse(ctx.allAccounts, provider)
    const dir = process.env[VAR[provider]]
    const from = !dir ? 'the default login' : ctx.cfg.use[provider] === here?.email ? 'portal use' : `$${VAR[provider]}`
    rows.push([bold(provider), here ? green(here.email) : dim(dir ? `unknown: ${dir}` : '—'), dim(from)])
  }
  say(screen({ what: 'check', note: 'who each tool is signed in as', rows, headers: ['tool', 'signed in as', 'from'] }))
}

// --------------------------------------------------------------- update

// The installer put a git checkout behind the `portal` link; updating is a
// fast-forward pull of it, and nothing else.
function cmdUpdate() {
  if (!existsSync(join(ROOT, '.git'))) throw new Error(`${ROOT} isn't a git checkout · reinstall with the one-line installer (see README)`)
  const head = () => spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const before = head()
  const r = spawnSync('git', ['-C', ROOT, 'pull', '--ff-only', '--quiet'], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`couldn't update ${ROOT} (local changes there?)`)
  const after = head()
  say(before === after ? dim(`  already up to date (${after})`) : green(`  ✓ updated ${before} → ${after}`))
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
    portal check                   who gcloud, gh, your recipes, claude and codex are signed in as
      --all                          every window and model cap, not just what needs attention

  ${bold('open')}  ${dim('(in the account\'s own Chrome profile)')}
    portal open claude             the Claude account to use now, on its usage page
    portal open claude hash        hash's Claude usage page         ${dim('also: codex, chatgpt')}
    portal open codex --all        every Codex account, one window each
      --chat                         a new chat instead of the usage page
    portal open hash               hash's Chrome profile
    portal open all                every profile, one window each

  ${bold('use')}  ${dim('(which account `claude` and `codex` use, in every terminal; nothing is copied)')}
    portal use                     who they use now
    portal use hash                hash's Claude and Codex         ${dim('portal use claude hash: only Claude')}
    portal use claude              the Claude account to use now
    portal use default             back to the default logins

  ${bold('sign in')}
    portal setup                   find accounts, sign in the ones that can't be read, add more
    portal add [claude|codex]      add an account: pick its Chrome profile, sign in once
    portal login claude <address>  the same without questions: by address or Chrome profile name
    portal login claude hash       give hash's Claude a sign-in of its own, so it's always readable
    portal login google work       gcloud + Drive + ADC as work, the login page in work's profile
    portal login <recipe> <who>    gh, gcloud, adc, or your own  ${dim('-- passes flags through')}
    portal recipe add <name> -- <command {email}>      ${dim('register your own login, like an alias')}

  ${bold('names')}
    portal alias work acme         "work" now means that account   ${dim('portal alias work --remove')}
    portal alias gh-work "GitHub Work"   a name for a Chrome profile, even one with no Claude/Codex account
    portal profiles                every Chrome profile: who it's signed in as, its names, its accounts
    portal profile <who> <profile> use a Chrome profile for an address no profile is signed into
    portal renews <who> <date>     when a Claude plan renews (Codex knows its own)
    portal hide <who> / show <who> keep an account off the screens  ${dim('(--hidden shows them)')}
    portal site add mail <url>     then: portal open mail work
    portal update                  get the latest portal

  ${dim('<who> is a name you set, or any part of an address, Chrome profile name or plan.')}
  ${dim('Every number is what is left. --json for machines · --dry-run on open and login · --fresh to skip the 1-minute reuse')}
`

// --------------------------------------------------------------- main

const COMMANDS = {
  next: cmdNext, plan: cmdPlan, schedule: cmdSchedule, history: cmdHistory, watch: cmdWatch,
  accounts: cmdAccounts, ls: cmdAccounts, open: cmdOpen, o: cmdOpen,
  login: cmdLogin, auth: cmdLogin, add: cmdAdd, use: cmdUse,
  setup: async (ctx) => (await import('./setup.js')).setup(ctx.cfg, ctx.allAccounts),
  name: cmdName, alias: cmdName, profile: cmdProfile, profiles: cmdProfile,
  hide: (ctx) => cmdHide(ctx, true), show: (ctx) => cmdHide(ctx, false), renews: cmdRenews,
  site: cmdSite, sites: cmdSite, recipe: cmdRecipe, recipes: cmdRecipe, check: cmdCheck, whoami: cmdCheck,
  update: cmdUpdate,
}

export async function main(argv) {
  const { flags, rest, passthrough } = parseArgs(argv)
  FRESH = !!flags.fresh
  if (flags.help || flags.h || rest[0] === 'help') return say(HELP)
  if (flags.version || flags.v) return say(`portal ${readJson(join(ROOT, 'package.json'))?.version}`)
  try {
    const cfg = load()
    // Accounts are found on first use (update, site, recipe never need them),
    // and hidden ones are left out here, once, unless --hidden asks for them.
    let all = null
    const ctx = {
      cfg, flags, rest, passthrough,
      get allAccounts() { return all ??= discover(cfg) },
      get accounts() { return flags.hidden ? this.allAccounts : this.allAccounts.filter(a => !a.hidden) },
    }
    const command = COMMANDS[rest[0]] ? rest.shift() : null
    if (command) await COMMANDS[command](ctx)
    else if (rest[0]) await cmdDetail(ctx, rest[0])
    else await cmdHome(ctx)
  } catch (err) {
    console.error(red('  ✗ ') + err.message)
    process.exitCode = 1
  }
}
