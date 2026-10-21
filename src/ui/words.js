// The words every screen shares: what an account is called, what its plan is
// called, and what its verdict says. One place, so no two screens disagree.

import { modelOf } from '../plan.js'
import { clock, cyan, dim, dot, green, hrs, magenta, pace, plain, red, relative, shortEmail, spanLabel, yellow } from './render.js'

// On screen an account is its address, shortened to what tells it apart
// (a gmail's local part, anything else's domain). Names he chose are for
// typing -- "portal open work" -- and show up in `portal accounts`.
export const nameOf = (account) => shortEmail(account.email)
// What to type to reach an account: a name he chose, else the short address.
const handleOf = (account) => account.names[0] ?? shortEmail(account.email)
// The one command that gives an account a working sign-in.
export const signInCommand = (account) => `portal login ${account.provider} ${handleOf(account)}`

// Providers name plans for their own billing systems; show what he'd call them.
export function planName(usage, account) {
  const multiplier = String(usage?.tier ?? account?.tier ?? '').match(/_(\d+x)$/)?.[1]
  const raw = String(usage?.plan ?? account?.plan ?? '').toLowerCase()
  const base =
    raw.includes('max') ? 'Max'
    : raw.includes('prolite') ? 'Pro Lite'
    : raw.includes('team') ? 'Team'
    : raw.includes('enterprise') ? 'Enterprise'
    : raw.includes('business') ? 'Business'
    : raw.includes('pro') ? 'Pro'
    : raw.includes('plus') ? 'Plus'
    : raw.includes('free') ? 'Free'
    : raw === 'personal' ? ''
    : raw
  return multiplier && base ? `${base} ${multiplier}` : base
}

export function windowLabel(kind) {
  if (kind === '5h') return '5 hours'
  if (kind === 'weekly') return 'this week'
  if (kind.startsWith('weekly:')) return `week · ${modelOf(kind)}`
  if (kind.startsWith('monthly')) return 'this month'
  return kind
}

// Where a pace came from. A pace from a short burst of readings is a hint,
// not a trend, so the span is always part of it.
export function paceOrigin(a) {
  if (!(a.doing > 0)) return dim('—')
  const span = spanLabel(a.paceSpanHours)
  return dim(a.doingSource === 'estimated' ? `5h window · ${span}` : a.doingSource === 'averaged' ? `avg over ${span}` : `measured · ${span}`)
}

// What happens to an account's week if nothing changes: a few words for a
// table cell, and a clause for the line under "use".
const VERDICTS = {
  unreadable: { live: false, short: () => 'not read live',
    long: (a) => `${Math.round(a.left)}% left` + (a.resetAt ? ` until ${clock(a.resetAt)}` : '') + dim(` · as of ${plain(relative(a.state.at))}`) },
  'not-started': { live: false, short: () => 'starts on first use', long: () => 'its week starts when you first use it' },
  empty: { live: false, short: () => 'empty', long: () => 'nothing left' },
  unknown: { live: false, short: () => 'no reset time', long: () => 'no reset time known' },
  'no-pace': { live: true, short: () => 'in use', long: () => 'in use · pace in ~15 min' },
  'no-readings': { live: true, short: () => 'measuring', long: () => 'measuring its pace' },
  unused: { live: false,
    short: (a) => a.severity === 'none' ? 'idle' : `${Math.round(a.left)}% unused at reset`,
    long: (a) => a.severity === 'none' ? `idle · ${Math.round(a.left)}% left, too little to chase`
      : `idle → all ${Math.round(a.left)}% goes unused at reset unless you use it` },
  wasting: { live: true,
    short: (a) => `~${Math.round(a.waste)}% unused at reset`,
    long: (a) => yellow(`~${Math.round(a.waste)}% goes unused at reset`) + dim(` · need ${pace(a.need)}, doing ${pace(a.doing)}`) },
  'on-track': { live: true,
    short: () => 'on track',
    long: (a) => green('on track to use it all') + dim(` by ${clock(a.resetAt)}`) },
  overrun: { live: true,
    short: (a) => `dry ~${clock(a.dryAt)}`,
    long: (a) => red(`runs dry ~${clock(a.dryAt)}`) + dim(`, ${hrs(a.hoursToReset - a.dryInHours)} before it resets`) },
}

export const colorOf = (a) => a.verdict === 'overrun' ? red : { good: green, warn: yellow, none: dim }[a.severity]

export function verdictLong(a) {
  if (a.locked) return red('locked') + dim(a.unlockAt ? ` until ${clock(a.unlockAt)}` : '')
  return VERDICTS[a.verdict].long(a)
}

// The verdict in a few words, coloured, for a table cell or a row note.
export const verdictShort = (a) => colorOf(a)(VERDICTS[a.verdict].short(a))

export function verdictDot(a) {
  if (a.locked) return dot(red, red('locked') + (a.unlockAt ? dim(` · back ${clock(a.unlockAt)}`) : ''), { live: false })
  return dot(colorOf(a), verdictShort(a), { live: VERDICTS[a.verdict].live })
}

// "1 banked reset" -- green when it can be used this minute, cyan when not yet.
export function bankedNote(usage) {
  const r = usage?.resets
  if (!r?.banked) return ''
  const text = `${r.banked} banked reset${r.banked === 1 ? '' : 's'}`
  return r.usableNow ? green(text) : cyan(text)
}

const creditsText = (c) => c.unlimited ? 'unlimited credits' : `${Math.round(c.balance).toLocaleString('en-US')} credits`
const compact = (n) => n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n)
export function creditsNote(usage, { long = false } = {}) {
  const c = usage?.credits
  if (!c) return ''
  if (c.exhausted) return yellow(`${creditsText(c)} · overage cap reached`)
  const reach = long && !c.unlimited && c.localMessages?.[1] > 0 ? dim(` · ~${compact(c.localMessages[0])}–${compact(c.localMessages[1])} messages`) : ''
  return magenta(creditsText(c)) + reach
}

