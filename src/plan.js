// The engine behind "nothing gets wasted".
//
// Each account's weekly budget resets on a known clock, and whatever is left at
// that moment is lost. So the target is not to keep accounts alive -- it is the
// opposite: every weekly budget should reach ~0% right as it resets. The 5-hour
// window is a throttle that refills by itself, not a budget, so it only tells us
// whether an account is usable this minute.
//
// From that, three numbers per account do all the work:
//   need    = left / hours-to-reset      the pace that finishes exactly at reset
//   doing   = measured pace right now    from recorded readings, throttle pauses excluded
//   ceiling = fastest pace ever seen     if need > ceiling, some waste is a given
//
// And one rule for which account to use: the one whose budget expires soonest.
// Its tokens are the ones lost first; everything else can still be used later.
// (Earliest deadline first. Most-room-first happily drains an account that
// resets in two days while one that resets tonight goes to waste.)
//
// Percentages are not comparable across accounts -- 1%/h of a Max 20x is far
// more work than 1%/h of a Pro -- so every rate here is per account, and plans
// are chained per provider. There is deliberately no "total pace".

import * as store from './store.js'

// Tuning, with the reason beside each value.
export const LOCK_AT = 100          // % used at which a window is dry -- the providers serve right up to the limit
const WASTE_NOTICE = 10      // % of budget; below this, waste is a fact, not a warning
export const GAP_NOTICE_H = 0.25    // a hole shorter than this is not a hole
const OVERRUN_MARGIN_H = 0.5        // landing this close to reset counts as on track
const THROTTLE_NOTICE_H = 0.25      // a throttle lock this close to its own reset is not worth a line
const SESSION_H = 5

// Windows are keyed '5h' | 'weekly' | 'weekly:<model>' | 'monthly:overage'.
// The ones without a scope are the account-wide limits.
const kindBase = (kind) => kind.split(':')[0]
// The model a 'weekly:<model>' cap is for, as he'd write it: "fable".
export const modelOf = (kind) => kind.split(':')[1]?.toLowerCase() ?? ''
export const isTopLevel = (w) => !w.kind.includes(':')
export const leftOf = (w) => Math.max(0, 100 - w.usedPercent)
export const windowOf = (usage, kind) => (usage.windows ?? []).find(w => w.kind === kind) ?? null

// The weekly budget that binds: the most-spent of the weekly limits. A model
// cap (e.g. Fable only, 68% used) runs out before the all-models week (43%)
// when that model is the one being used, so planning on the all-models number
// promises budget that is not there.
function budgetWindow(usage) {
  const weekly = (usage.windows ?? []).filter(w => kindBase(w.kind) === 'weekly')
  if (weekly.length === 0) return null
  return weekly.reduce((a, b) => b.usedPercent > a.usedPercent ? b : a)
}

// How much to trust a reading, decided once:
//   live        read from the provider just now
//   replay      the provider failed a moment ago; the last reading stands in, for an hour
//   unreadable  no working token; the last reading is replayed indefinitely
//   none        nothing to show at all
export function readState(usage) {
  if (!usage.ok) return { kind: 'none' }
  if (!usage.stale) return { kind: 'live' }
  return { kind: usage.expired || usage.inactive ? 'unreadable' : 'replay', at: usage.staleAt }
}

// Whether a read failed for want of a working sign-in -- something only a
// login fixes -- rather than a provider not answering for a moment. Providers
// mark the first as `inactive`; this is the one place that reads it.
export const needsSignIn = (usage) => usage.inactive === true

const isLocked = (usage) =>
  !!usage.blocked || (usage.windows ?? []).some(w => isTopLevel(w) && w.usedPercent >= LOCK_AT)

// When a locked account comes back: the earliest reset among its dry windows.
function unlockAt(usage) {
  const dry = (usage.windows ?? [])
    .filter(w => isTopLevel(w) && w.usedPercent >= LOCK_AT && w.resetAt)
    .map(w => w.resetAt)
  return dry.length ? Math.min(...dry) : null
}

export const isUsable = (a) => !a.locked && a.left > 0

// Play one weekly budget forward at the active pace, sitting out the 5-hour
// throttle whenever it would be dry (modelled as 5h cycles past the first known
// reset), until the budget runs out or the week resets.
function simulate({ left, doing, hoursToReset, sessionRate, sessionLeft, sessionResetInHours }) {
  const canThrottle = sessionRate > 0 && sessionLeft != null && sessionResetInHours != null
  let t = 0, wl = left
  let sl = sessionLeft ?? Infinity
  let sReset = sessionResetInHours ?? Infinity

  for (let guard = 0; guard < 400 && t < hoursToReset && wl > 0; guard++) {
    if (canThrottle && sl <= 0) {
      const wait = Math.min(sReset, hoursToReset) - t
      if (wait > 0) t += wait
      sl = 100; sReset = Math.max(sReset, t) + SESSION_H
      continue
    }
    const dtW = wl / doing
    const dtS = canThrottle ? sl / sessionRate : Infinity
    const dtR = canThrottle ? sReset - t : Infinity
    const dt = Math.max(0, Math.min(dtW, dtS, dtR, hoursToReset - t))
    wl -= doing * dt
    if (canThrottle) sl -= sessionRate * dt
    t += dt
    if (canThrottle && dt === dtR) { sl = 100; sReset += SESSION_H }
    if (dt === 0) break
  }
  return {
    dryAtHours: wl <= 0.01 ? t : null,
    leftAtReset: wl <= 0.01 ? 0 : Math.max(0, wl),
  }
}

// Verdict ids and how serious each is for the card's edge colour:
// good = on course, warn = tokens will go to waste, bad = nothing to use, none = neutral.
const SEVERITY = {
  'on-track': 'good', wasting: 'warn', overrun: 'warn', unused: 'warn',
  'no-pace': 'none', 'no-readings': 'none', 'not-started': 'none', unreadable: 'none', empty: 'none', unknown: 'none',
}

function analyze(account, usage) {
  const w = budgetWindow(usage)
  if (!w) return null

  const now = Date.now()
  const state = readState(usage)
  const left = leftOf(w)
  // A reset time already behind us is a stale claim, not a deadline.
  const resetAt = w.resetAt > now ? w.resetAt : null
  const hoursToReset = resetAt ? (resetAt - now) / store.HOUR_MS : null
  const need = hoursToReset ? left / hoursToReset : null

  const r = store.rates(account, { lockAt: LOCK_AT, kind: w.kind })
  const doing = r.pace?.perHour ?? 0
  const session = windowOf(usage, '5h')
  const sessionLeft = session ? leftOf(session) : null
  const sessionResetInHours = session?.resetAt ? Math.max(0, (session.resetAt - now) / store.HOUR_MS) : null
  const locked = isLocked(usage)
  const throttled = !!session && session.usedPercent >= LOCK_AT && w.usedPercent < LOCK_AT
  // In use: the 5-hour window is moving, or has moved and is too young to measure.
  const inUse = r.sessionRate > 0 || (!!session && session.usedPercent > 0 && !r.sessionMeasured)

  // Will the throttle bite before the weekly budget does?
  let sessionDryInHours = null
  if (session && !throttled && sessionResetInHours != null && r.sessionRate > 0) {
    const dryIn = sessionLeft / r.sessionRate
    if (dryIn < sessionResetInHours - THROTTLE_NOTICE_H) sessionDryInHours = dryIn
  }

  // What happens at reset if nothing changes. Finishing right at reset is the
  // target, so "dry" only counts if it lands clearly before the reset.
  let verdict, waste = 0, dryInHours = null
  if (w.startsOnUse) verdict = 'not-started'   // no clock, so nothing to pace or waste
  else if (state.kind === 'unreadable') {
    // No current pace to judge by, so no verdict. But for planning the chain,
    // the last known pace is a better guess of how long it lasts than "all
    // week" -- 32% at 9%/h is hours, not days.
    verdict = 'unreadable'
    if (doing > 0 && hoursToReset != null && left > 0) {
      const sim = simulate({ left, doing, hoursToReset, sessionRate: r.sessionRate, sessionLeft: null, sessionResetInHours: null })
      if (sim.dryAtHours != null) dryInHours = sim.dryAtHours
    }
  }
  else if (left === 0) verdict = 'empty'
  else if (hoursToReset == null) verdict = 'unknown'
  else if (doing === 0 && inUse) verdict = 'no-pace'         // being used, but nothing measurable yet
  else if (doing === 0 && !r.idle) verdict = 'no-readings'   // nothing to measure against
  else if (doing === 0) { verdict = 'unused'; waste = left }
  else {
    const sim = simulate({ left, doing, hoursToReset, sessionRate: r.sessionRate, sessionLeft, sessionResetInHours })
    if (sim.dryAtHours != null && sim.dryAtHours < hoursToReset - OVERRUN_MARGIN_H) {
      verdict = 'overrun'; dryInHours = sim.dryAtHours
    } else {
      waste = sim.leftAtReset
      verdict = waste >= WASTE_NOTICE ? 'wasting' : 'on-track'
    }
  }
  const severity = verdict === 'unused' && left < WASTE_NOTICE ? 'none' : SEVERITY[verdict]

  const ceiling = r.peak
  const impossible = need != null && ceiling != null && need > ceiling * 1.1
  const unavoidableWaste = impossible ? Math.max(0, left - ceiling * hoursToReset) : 0

  return {
    account, usage, state, budgetKind: w.kind, left, resetAt, hoursToReset, need,
    doing, doingSource: r.pace?.source ?? null, paceSpanHours: r.pace?.spanHours ?? 0, ceiling,
    locked, throttled, unlockAt: locked ? unlockAt(usage) : null,
    sessionDryInHours, sessionResetAt: session?.resetAt ?? null,
    verdict, severity, waste, dryInHours, dryAt: dryInHours != null ? now + dryInHours * store.HOUR_MS : null,
    impossible, unavoidableWaste,
  }
}

// Earliest deadline first among what is usable now. Tie: more left first, since
// the bigger budget is the harder one to finish in time.
const order = (analyses) => analyses
  .filter(isUsable)
  .sort((x, y) => (x.resetAt ?? Infinity) - (y.resetAt ?? Infinity) || y.left - x.left)

// One provider's plan: the chain of accounts to use in order, how long each
// lasts (simulated outcome when the pace is measured, a what-if at the best
// pace ever seen otherwise), and what brings capacity back after the chain.
function providerPlan(analyses) {
  const now = Date.now()
  const steps = []
  let end = now   // when the chain runs out; null once a step's length is unknowable
  for (const a of order(analyses)) {
    let hours = null
    if (a.doing > 0) hours = a.dryInHours ?? a.hoursToReset
    else if (a.ceiling) hours = Math.min(a.left / a.ceiling, a.hoursToReset ?? Infinity)
    steps.push({ a, hours })
    if (hours == null) { end = null; break }
    end += hours * store.HOUR_MS
  }

  // What brings capacity back: a locked account unlocking, OR an account in the
  // chain refilling at its own reset. Forgetting the second says "nothing for
  // 35h" about an account that comes back in 12. One timeline, earliest first:
  // whatever lands before the chain ends means no gap; otherwise the first
  // thing after it sets the gap.
  const comebacks = analyses
    .map(a => a.locked
      ? (a.unlockAt > now ? { a, at: a.unlockAt, how: 'unlocks' } : null)
      : (a.resetAt > now ? { a, at: a.resetAt, how: 'refills' } : null))
    .filter(Boolean)
    .sort((x, y) => x.at - y.at)
  const before = end == null ? [] : comebacks.filter(c => c.at <= end + 60_000)
  const after = end == null ? comebacks : comebacks.filter(c => c.at > end + 60_000)
  const next = before[0] ?? after[0] ?? null
  let gapHours = null   // unknown while the chain's end is
  if (end != null) {
    gapHours = before.length ? 0 : after.length ? (after[0].at - end) / store.HOUR_MS : steps.length ? Infinity : 0
  }
  // The pace that would stretch what is left across the whole wait instead --
  // only meaningful for a single account, since percentages do not add up
  // across accounts.
  const bridgePace = gapHours > GAP_NOTICE_H && gapHours !== Infinity && steps.length === 1 && steps[0].a.doing > 0
    ? steps[0].a.left / ((next.at - now) / store.HOUR_MS)
    : null

  // When to move off the account in use, and why: its 5-hour throttle biting
  // first, or its week running dry well before the reset. Either way the
  // move is to the next account in the chain, and the first one comes back
  // at backAt.
  let change = null
  const first = steps[0]?.a
  if (first?.sessionDryInHours != null) {
    change = { at: now + first.sessionDryInHours * store.HOUR_MS, reason: 'throttle', backAt: first.sessionResetAt }
  } else if (first?.verdict === 'overrun' && first.dryInHours != null) {
    change = { at: now + first.dryInHours * store.HOUR_MS, reason: 'dry', backAt: first.resetAt }
  }
  if (change) change.to = steps[1]?.a ?? null

  // The one order every screen lists accounts in: what to use, in order; then
  // locked ones by when they come back; then whatever is left, soonest reset first.
  const inChain = new Set(steps.map(s => s.a))
  const rest = analyses.filter(a => !inChain.has(a))
  const ordered = [
    ...steps.map(s => s.a),
    ...rest.filter(a => a.locked).sort((x, y) => (x.unlockAt ?? x.resetAt ?? Infinity) - (y.unlockAt ?? y.resetAt ?? Infinity)),
    ...rest.filter(a => !a.locked).sort((x, y) => (x.resetAt ?? Infinity) - (y.resetAt ?? Infinity)),
  ]

  return {
    analyses, ordered, steps, next, gapHours, bridgePace, change,
    // A chain timed on peak pace rather than measured pace is a what-if.
    speculative: steps.some(s => !(s.a.doing > 0) && s.a.ceiling),
  }
}

// One plan per provider that has any account, readable or not, so a provider
// whose every token has expired still gets a card saying so.
export function planAll(results) {
  const byProvider = {}
  for (const { account, usage } of results) {
    const list = (byProvider[account.provider] ??= [])
    const a = analyze(account, usage)
    if (a) list.push(a)
  }
  const out = {}
  for (const [provider, analyses] of Object.entries(byProvider)) out[provider] = providerPlan(analyses)
  return out
}
