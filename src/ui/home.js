// The screen `portal` opens on: per provider, what to use now and when to
// switch, then every account on one line each.
//
// Rules this screen keeps, most of them his own words from building the last
// version:
//   - Every number is what is LEFT, never what is used, and says so ("61% left").
//     Bars drain.
//   - The weekly budget is the number. The 5-hour window is a throttle: it only
//     shows up once it is at 20% left or below (or dry), and never when the week
//     has less left than it does -- then the week is what stops you.
//   - A model cap rides along as a small bracket, "(fable 32%)", when it is
//     tighter than the week; the plan uses whichever is tightest.
//   - An account locks only when a window is fully spent or the provider says so.
//   - Order: accounts with something left, soonest reset first (its tokens go
//     to waste first), then locked ones by when they come back.
//   - Rows never say "expired"; a stale row says "as of 2h ago", and the block
//     says once, at the bottom, which accounts are stale and how to fix that.
//   - The coloured edge: green on course, yellow something will go unused, red
//     nothing usable or a gap coming, dim when the advice rests on old readings.

import { GAP_NOTICE_H, LOCK_AT, isTopLevel, leftOf, readState } from '../plan.js'
import { PROVIDERS, PROVIDER_ORDER } from '../providers/index.js'
import { bold, clock, dateOnly, dim, green, hrs, meter, pace, padRight, percent, providerColor, red, relative, table, yellow } from './render.js'
import { bankedNote, colorOf, creditsNote, handleOf, nameOf, planName, verdictLong } from './words.js'

export const SESSION_SHOW_AT = 20      // % left at or below which the 5-hour window earns a mention
const LAPSE_WARN_MS = 3 * 86_400_000   // warn this long before a sign-in stops renewing itself

const windowOf = (usage, kind) => (usage.windows ?? []).find(w => w.kind === kind) ?? null
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')

// The provider's mood, for the edge down the side of its block.
function mood(p) {
  if (!p || p.steps.length === 0) return red
  const a = p.steps[0].a
  if (a.verdict === 'overrun' && p.gapHours > GAP_NOTICE_H) return red
  // Advice built on an old reading is a guess: say so with a neutral edge.
  if (a.state.kind !== 'live') return dim
  return a.severity === 'warn' ? yellow : green
}

const comeback = (c) => `${nameOf(c.a.account)} ${c.how === 'unlocks' ? 'is back' : 'refills'} ${clock(c.at)}`

// One to three lines: what to use and what happens to it, then when to move on.
export function insight(p) {
  if (!p || p.analyses.length === 0) return [red('nothing readable') + dim(' · see below')]
  if (p.steps.length === 0) {
    const out = [red('nothing usable') + dim(p.next ? ` · ${comeback(p.next)}` : ' · nothing coming back')]
    const resettable = p.analyses.filter(a => a.usage.resets?.usableNow > 0)
    if (resettable.length) out.push(green(`${resettable.map(a => nameOf(a.account)).join(', ')} can spend a banked reset now`))
    for (const a of p.analyses.filter(a => a.usage.credits && !a.usage.credits.exhausted)) {
      out.push(green(`${nameOf(a.account)} can keep going on credits`) + dim(' · ') + creditsNote(a.usage, { long: true }))
    }
    return out
  }

  const a = p.steps[0].a
  const out = [green('use ') + bold(nameOf(a.account)) + dim(' — ') + verdictLong(a) +
    (a.impossible ? dim(` · even your peak ${pace(a.ceiling)} leaves ~${Math.round(a.unavoidableWaste)}%`) : '')]

  const c = p.change
  if (c?.reason === 'throttle') {
    out.push(yellow(`5h window runs out ~${clock(c.at)}`) +
      (c.to ? dim(' → switch to ') + bold(nameOf(c.to.account)) : red(' → nothing else to switch to')) +
      dim(` · ${nameOf(a.account)} is back ${clock(c.backAt)}`))
  } else if (c?.reason === 'dry') {
    out.push(c.to ? dim('then switch to ') + bold(nameOf(c.to.account)) + dim(` ~${clock(c.at)}`)
      : red(`nothing after ~${clock(c.at)}`) + (p.next ? dim(` until ${comeback(p.next)}`) : ''))
  } else if (a.throttled) {
    out.push(dim(`5h window is dry · back ${clock(a.sessionResetAt)}`))
  }

  // A hole in the chain: nothing usable between the last account running dry
  // and the first thing coming back. Only for a chain timed on measured pace.
  if (!p.speculative && p.gapHours != null && c?.reason !== 'dry') {
    if (p.gapHours === Infinity) out.push(red('after that: nothing until a reset'))
    else if (p.gapHours > GAP_NOTICE_H) {
      out.push(red(`after that: nothing for ${hrs(p.gapHours)}`) + dim(p.next ? ` until ${comeback(p.next)}` : '') +
        (p.bridgePace != null ? dim(` · staying under ${pace(p.bridgePace)} lasts until then`) : ''))
    }
  }
  return out
}

// The 5-hour window, only when it matters: nearly spent, or dry.
function sessionNote(usage, weekLeft, { all }) {
  const s = windowOf(usage, '5h')
  if (!s || s.startsOnUse) return ''
  const left = leftOf(s)
  const back = s.resetAt ? dim(` · back ${clock(s.resetAt)}`) : ''
  if (s.usedPercent >= LOCK_AT) return red('5h dry') + back
  if (all || (left <= SESSION_SHOW_AT && left <= weekLeft)) return (left <= SESSION_SHOW_AT ? yellow : dim)(`5h ${Math.round(left)}% left`) + back
  return ''
}

// What the row says beyond the numbers: only what needs attention.
function notes(usage, a, weekLeft, opts) {
  const state = readState(usage)
  const out = []
  const s = sessionNote(usage, weekLeft, opts)
  if (s) out.push(s)
  // The pick's verdict is already the line above the table.
  if (a && !opts.pick && !a.locked && (a.severity === 'warn' || a.verdict === 'overrun')) {
    out.push(colorOf(a)(a.verdict === 'overrun' ? `dry ~${clock(Date.now() + a.dryInHours * 3600_000)}`
      : a.verdict === 'wasting' ? `~${Math.round(a.waste)}% unused at reset` : `${Math.round(a.left)}% unused at reset`))
  }
  if (state.kind === 'replay' || state.kind === 'unreadable') out.push(dim(`as of ${plain(relative(state.at))}`))
  const banked = bankedNote(usage)
  if (banked) out.push(banked)
  const credits = creditsNote(usage)
  if (credits) out.push(credits)
  return out.join(dim(' · '))
}

// Model caps tighter than the week, as a bracket: "(fable 32%)".
function capsBracket(usage, weekLeft, { all, moot }) {
  const caps = (usage.windows ?? []).filter(w => w.kind.startsWith('weekly:'))
    .filter(w => all || leftOf(w) < weekLeft)
  if (!caps.length) return ''
  return caps.map(w => dim('(' + w.kind.slice(7).toLowerCase() + ' ') + (moot ? dim(`${Math.round(leftOf(w))}%`) : percent(leftOf(w))) + dim(')')).join(' ')
}

function row(account, usage, a, { pick, all }) {
  const state = readState(usage)
  const name = pick ? bold(nameOf(account)) : nameOf(account)
  if (state.kind === 'none') {
    return [dim('○'), dim(nameOf(account)), '', dim('·'.repeat(12)), dim('—'), '', '', yellow(usage.error ?? 'no reading')]
  }
  const week = windowOf(usage, 'weekly') ?? (a ? windowOf(usage, a.budgetKind) : null)
  const weekLeft = week ? leftOf(week) : 100
  const opts = { all, pick }
  if (!a || !week) return [dim('○'), name, dim(planName(usage, account)), '', '', '', '', notes(usage, a, weekLeft, opts)]
  const live = state.kind === 'live'
  const mark = a.locked ? red('○')
    : (a.doing > 0 || a.verdict === 'no-pace') && live ? colorOf(a)('●')
    : dim('○')
  return [
    mark, name, dim(planName(usage, account)),
    a.locked ? dim('·'.repeat(12)) : meter(weekLeft, 12),
    (a.locked ? dim(`${Math.round(weekLeft)}%`) : percent(weekLeft)) + dim(' left'),
    capsBracket(usage, weekLeft, { all, moot: a.locked }),
    week.startsOnUse ? dim('on first use') : week.resetAt ? relative(week.resetAt) : dim('—'),
    notes(usage, a, weekLeft, opts),
  ]
}

// Usable accounts in the order to use them, then locked ones by when they
// come back, then the ones with no reading at all.
function ordered(group, p) {
  const byKey = new Map((p?.analyses ?? []).map(a => [a.account.key, a]))
  const chain = new Map((p?.steps ?? []).map((s, i) => [s.a.account.key, i]))
  const rank = (r) => {
    const a = byKey.get(r.account.key)
    if (!a) return [3, 0]
    if (chain.has(r.account.key)) return [0, chain.get(r.account.key)]
    if (a.locked) return [1, a.unlockAt ?? a.resetAt ?? Infinity]
    return [2, a.resetAt ?? Infinity]
  }
  return [...group].sort((x, y) => {
    const [a1, b1] = rank(x), [a2, b2] = rank(y)
    return a1 - a2 || b1 - b2 || x.account.email.localeCompare(y.account.email)
  })
}

// Once per block: which accounts are showing old readings and how to fix it,
// and which sign-ins are about to stop renewing themselves.
function footer(group, provider) {
  const out = []
  const stale = group.filter(r => readState(r.usage).kind !== 'live')
  const signedOut = stale.filter(r => r.usage.inactive)
  const flaky = stale.filter(r => !r.usage.inactive)
  if (signedOut.length) {
    out.push(yellow(`${signedOut.map(r => nameOf(r.account)).join(', ')}: last readings shown`) + dim(' · ') +
      (signedOut.length > 1 ? 'portal setup' + dim(' signs each in once') : `portal login ${provider} ${handleOf(signedOut[0].account)}` + dim(' signs it in for good')))
  }
  if (flaky.length) {
    const why = [...new Set(flaky.map(r => r.usage.error).filter(Boolean))].join(', ')
    out.push(dim(`${flaky.map(r => nameOf(r.account)).join(', ')}: ${provider} didn't answer just now${why ? ` (${why})` : ''} · last readings shown`))
  }
  const lapsing = group.filter(r => r.usage.signInUntil && r.usage.signInUntil - Date.now() < LAPSE_WARN_MS)
  for (const r of lapsing) {
    out.push(yellow(`${nameOf(r.account)}'s sign-in stops renewing ${dateOnly(r.usage.signInUntil)}`) + dim(' unless used · ') + `portal login ${provider} ${handleOf(r.account)}`)
  }
  return out
}

export function home(snap, { showHidden = false, all = false } = {}) {
  const out = ['']
  for (const provider of PROVIDER_ORDER) {
    const group = snap.results.filter(r => r.account.provider === provider && (showHidden || !r.account.hidden))
    if (group.length === 0) continue
    const p = snap.plans[provider]
    const edge = mood(p)('▌')
    const tag = padRight(providerColor(provider)(bold(PROVIDERS[provider].title)), 7)
    const line = (s = '') => out.push(`  ${edge} ${s}`.replace(/\s+$/, ''))

    const lines = insight(p)
    line(`${tag} ${lines[0]}`)
    for (const l of lines.slice(1)) line(`${' '.repeat(7)} ${l}`)
    line()

    const pickKey = p?.steps[0]?.a.account.key
    const rows = ordered(group, p).map(r => row(r.account, r.usage, (p?.analyses ?? []).find(a => a.account.key === r.account.key), { pick: r.account.key === pickKey, all }))
    const headers = ['', 'account', 'plan', 'what is left', '', '', 'resets in', '']
    // No account with a cap tighter than its week: no bracket column.
    let align = 'llllrlll'
    if (rows.every(r => !r[5])) { rows.forEach(r => r.splice(5, 1)); headers.splice(5, 1); align = 'llllrll' }
    const body = table(rows, { headers, align, indent: 0, gap: 2, rule: false })
    for (const l of body.split('\n')) line(' ' + l)
    const foot = footer(group, provider)
    if (foot.length) {
      line()
      for (const f of foot) line(' ' + f)
    }
    out.push('')
  }
  return out.join('\n')
}

// One line per provider: the account to use right now.
export function nextLine(p, provider) {
  const tag = padRight(providerColor(provider)(bold(provider)), 7)
  if (!p || p.steps.length === 0) return `  ${tag} ${red('nothing usable')}` + dim(p?.next ? ` · ${comeback(p.next)}` : '')
  const a = p.steps[0].a
  return `  ${tag} ${bold(nameOf(a.account))}` + dim(` · ${Math.round(a.left)}% left · ${a.resetAt ? 'resets in ' + plain(relative(a.resetAt)) : 'week starts on first use'}`)
}

export { isTopLevel }
