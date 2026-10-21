// The screens beyond the home view: one account in detail, every account and
// where it comes from, the pace plan, the reset schedule, the history.

import { isTopLevel, isUsable, leftOf, readState } from '../plan.js'
import { PROVIDERS, PROVIDER_ORDER } from '../providers/index.js'
import * as store from '../store.js'
import {
  banner, bold, clock, dateOnly, dayLabel, dim, dot, green, meter, pace, percent, providerColor, red,
  relative, screen, screenWidth, section, sparkline, table, yellow,
} from './render.js'
import { bankedNote, creditsNote, nameOf, paceOrigin, planName, verdictDot, verdictLong, windowLabel } from './words.js'

const SOURCE = { portal: 'portal sign-in', orca: 'orca', default: 'default login', known: 'your config (not signed in here)' }

function providerSections(plans, rowFor) {
  const rows = []
  for (const provider of PROVIDER_ORDER) {
    const ordered = (plans[provider]?.ordered ?? []).filter(a => !a.account.hidden)
    if (ordered.length === 0) continue
    if (rows.length) rows.push(null)
    rows.push(section(PROVIDERS[provider].title, { indent: 0, width: screenWidth() - 2 }))
    for (const a of ordered) rows.push(rowFor(a))
  }
  return rows
}

// ---------------------------------------------------------------- detail

// Everything about one person's accounts: every window, the pace, the plan,
// when it renews, where the sign-in lives, and how to reach it.
export function detail(results, plans) {
  const out = ['']
  for (const { account, usage } of results) {
    const a = plans[account.provider]?.analyses.find(x => x.account.key === account.key)
    const state = readState(usage)
    out.push(`  ${providerColor(account.provider)('▌')} ${bold(nameOf(account))} ${dim('·')} ${account.provider} ${dim(planName(usage, account) || '')}` +
      dim(`  ${account.email}`))
    const rows = []
    for (const w of (usage.windows ?? []).filter(w => usage.ok)) {
      const left = leftOf(w)
      rows.push([dim(windowLabel(w.kind)), meter(left, 14), percent(left) + dim(' left'),
        w.startsOnUse ? dim('starts on first use') : w.resetAt ? `resets ${clock(w.resetAt)} ${dim('· in ' + relative(w.resetAt))}` : dim('—')])
    }
    if (state.kind === 'none') rows.push([dim('usage'), yellow(usage.error ?? 'no reading'), '', usage.hint ? dim(usage.hint) : ''])
    const facts = []
    if (a) {
      facts.push(['at reset', verdictLong(a)])
      facts.push(['pace', `need ${pace(a.need)} ${dim('·')} doing ${a.doing > 0 ? pace(a.doing) : dim('—')} ${dim('·')} peak ${pace(a.ceiling)}  ${a.doing > 0 ? paceOrigin(a) : ''}`])
    }
    const extras = [bankedNote(usage), creditsNote(usage, { long: true })].filter(Boolean)
    if (extras.length) facts.push(['extra', extras.join(dim(' · '))])
    if (account.renews) facts.push(['renews', `${dateOnly(account.renews.at)} ${dim(account.renews.estimated ? '· estimated' : '· in ' + relative(account.renews.at))}`])
    const until = usage.signInUntil ? dim(` · renews itself until ${dateOnly(usage.signInUntil)}`) : ''
    facts.push(['sign-in', state.kind === 'live' ? green('live') + dim(` · ${SOURCE[usage.source] ?? usage.source ?? ''}`) + until
      : yellow(usage.error ?? 'not readable') + dim(` · portal login ${account.provider} ${nameOf(account)}`) +
        (state.kind !== 'none' ? dim(` · numbers above are from ${relative(state.at).replace(/\x1b\[[0-9;]*m/g, '')}`) : '')])
    facts.push(['found in', account.sources.map(s => SOURCE[s] ?? s).join(dim(', '))])
    facts.push(['chrome', account.chrome ? `${account.chrome.label} ${dim(`(${account.chrome.dir})`)}` : yellow('no profile') + dim(` · portal profile ${nameOf(account)} <profile>`)])
    if (rows.length) out.push(table(rows, { indent: 4, align: 'llrl' }), '')
    out.push(table(facts.map(([k, v]) => [dim(k), v]), { indent: 4 }))
    out.push('')
  }
  return out.join('\n')
}

// -------------------------------------------------------------- accounts

export function accountsScreen(results) {
  const rows = []
  for (const provider of PROVIDER_ORDER) {
    const group = results.filter(r => r.account.provider === provider)
    if (!group.length) continue
    if (rows.length) rows.push(null)
    rows.push(section(PROVIDERS[provider].title, { indent: 0, width: screenWidth() - 2 }))
    for (const { account, usage } of group) {
      const state = readState(usage)
      rows.push([
        account.hidden ? dim(nameOf(account)) : bold(nameOf(account)),
        account.names.length ? account.names.join(', ') : dim('—'),
        dim(planName(usage, account) || ''),
        state.kind === 'live' ? dot(green, green('live'))
          : state.kind === 'none' ? dot(yellow, yellow('no sign-in'), { live: false })
          : dot(yellow, yellow(`as of ${relative(state.at)}`), { live: false }),
        account.chrome ? account.chrome.label : yellow('no profile'),
        account.renews ? `${dateOnly(account.renews.at)}${account.renews.estimated ? dim('~') : ''}` : dim('—'),
        dim(account.sources.map(s => SOURCE[s] ?? s).join(', ')) + (account.hidden ? dim(' · hidden') : ''),
      ])
    }
  }
  return screen({
    what: 'accounts', rows,
    headers: ['account', 'names', 'plan', 'sign-in', 'chrome', 'renews', 'found in'],
    footnotes: [
      'name one: portal name <name> <who>   ·   sign one in: portal login claude|codex <who>   ·   add one: portal add',
    ],
  })
}

// ------------------------------------------------------------------ plan

export function planScreen(plans) {
  const rows = providerSections(plans, (a) => [
    nameOf(a.account), percent(a.left), relative(a.resetAt),
    isUsable(a) ? pace(a.need) : dim('—'),
    a.doing > 0 ? pace(a.doing) : dim('idle'),
    pace(a.ceiling), paceOrigin(a), verdictDot(a),
  ])
  return screen({
    what: 'plan', note: 'the pace each week needs vs the pace it is getting', rows,
    headers: ['account', 'left', 'resets in', 'need', 'doing', 'peak', 'pace from', 'at reset'], align: 'lrrrrrll',
    footnotes: [
      'need   the pace that uses the week up exactly at its reset',
      'doing  the pace over the last 6h, throttle pauses left out',
      'peak   the fastest it has ever gone; a need above it means some of it goes unused regardless',
    ],
  })
}

// -------------------------------------------------------------- schedule

export function scheduleScreen(results, { all = false } = {}) {
  const events = []
  for (const { account, usage } of results) {
    if (account.hidden || readState(usage).kind === 'none') continue
    for (const w of usage.windows ?? []) {
      if (!w.resetAt || w.usedPercent === 0) continue
      if (!all && (!isTopLevel(w) || w.kind === '5h')) continue
      events.push({ account, kind: w.kind, at: w.resetAt, left: leftOf(w) })
    }
    if (account.renews) events.push({ account, kind: 'renews', at: account.renews.at, renewal: account.renews })
  }
  events.sort((a, b) => a.at - b.at)
  const rows = []
  let day = null
  for (const e of events) {
    const label = dayLabel(e.at)
    if (label !== day) {
      if (day !== null) rows.push(null)
      rows.push(bold(label))
      day = label
    }
    rows.push([
      dim(clock(e.at).replace(/^\S+ /, '')), relative(e.at), providerColor(e.account.provider)(e.account.provider),
      nameOf(e.account), dim(e.kind === 'renews' ? 'plan renews' : windowLabel(e.kind)),
      e.kind === 'renews' ? dim(e.renewal.estimated ? 'estimated' : '') : percent(e.left) + dim(' left → ') + green('100%'),
    ])
  }
  return screen({
    what: 'schedule', note: 'when each week comes back, and when plans renew', rows,
    headers: ['at', 'in', '', 'account', 'what', ''], align: 'lrllll', empty: 'no reset times known',
  })
}

// --------------------------------------------------------------- history

export function historyScreen(plans) {
  const rows = providerSections(plans, (a) => [
    nameOf(a.account), sparkline(store.trail(a.account, a.budgetKind)), percent(a.left),
    a.doing > 0 ? pace(a.doing) : dim('idle'), pace(a.ceiling), verdictDot(a),
  ])
  return screen({
    what: 'history', note: `${store.stats().samples} readings on record`, rows,
    headers: ['account', 'last 24h', 'left', 'doing', 'peak', 'at reset'], align: 'llrrrl',
    footnotes: ['last 24h  what was left at each reading, oldest on the left'],
  })
}

export { banner, meter, red }
