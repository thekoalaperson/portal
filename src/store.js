// Snapshot history. The providers only ever report "right now", so the trend --
// how fast a window is burning, when it will run out -- has to be accumulated
// locally. node:sqlite is built in, so this stays dependency-free.
//
// Everything the engine wants from history comes out of one call, rates(),
// which loads an account's readings once and answers every question from them.

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DB, LEGACY } from './paths.js'

export const HOUR_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * HOUR_MS

// Tuning, with the reason beside each value.
const RECENT_MS = 6 * HOUR_MS        // a pace is "now" if measured over the last 6h
const COARSE_MS = 24 * HOUR_MS       // with no readings in 6h, average across the gap since the last one
const LOOKBACK_MS = 14 * 24 * HOUR_MS // peak pace and the 5h→weekly ratio look this far back
const KEEP_MS = 30 * 24 * HOUR_MS    // readings older than this are dropped
const MIN_SPAN_H = 0.25              // a pace needs at least 15 min between readings
const MAX_GAP_H = 3                  // a longer gap between readings hides what happened in it
const THIN_SPAN_H = 1                // under this span a weekly pace is a hint...
const THIN_POINTS = 5                // ...unless it moved this many points
const RESET_DROP = 2                 // a fall of this many points means the window reset
const STALE_LIMIT_MS = HOUR_MS       // beyond this, an old reading of a live account is noise

let db
function open() {
  if (db) return db
  mkdirSync(dirname(DB), { recursive: true })
  const fresh = !existsSync(DB)
  db = new DatabaseSync(DB)
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      ts           INTEGER NOT NULL,
      provider     TEXT    NOT NULL,
      account_id   TEXT    NOT NULL,
      email        TEXT    NOT NULL,
      kind         TEXT    NOT NULL,
      used_percent REAL    NOT NULL,
      reset_at     INTEGER,
      PRIMARY KEY (ts, account_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_samples_person
      ON samples (provider, email, kind, ts DESC);
  `)
  if (fresh && !process.env.PORTAL_HOME) importLegacy(db)
  return db
}

// basketstar kept the same readings under the same person key (provider +
// email). Carrying them over means pace, peak and replay work on day one
// instead of after a day of fresh readings.
function importLegacy(d) {
  if (!existsSync(LEGACY.db)) return
  try {
    d.exec(`ATTACH DATABASE '${LEGACY.db.replace(/'/g, "''")}' AS legacy`)
    d.exec(`INSERT OR IGNORE INTO samples (ts, provider, account_id, email, kind, used_percent, reset_at)
            SELECT ts, provider, provider || ':' || lower(email), lower(email), kind, used_percent, reset_at
              FROM legacy.samples`)
    d.exec('DETACH DATABASE legacy')
  } catch { /* history is a nicety; a broken old file is not worth an error */ }
}

// One transaction for a whole poll. Replayed readings are skipped -- writing
// them back as if fresh would flatten the burn-rate curve with points that
// never happened. Old rows go at the same time, so the table has a ceiling.
export function recordMany(results, at = Date.now()) {
  const d = open()
  const insert = d.prepare(
    `INSERT OR REPLACE INTO samples
       (ts, provider, account_id, email, kind, used_percent, reset_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  d.exec('BEGIN')
  let n = 0
  try {
    for (const { account, usage } of results) {
      if (!usage.ok || usage.stale) continue
      for (const w of usage.windows) {
        insert.run(at, account.provider, account.key, account.email.toLowerCase(), w.kind, w.usedPercent, w.resetAt ?? null)
        n++
      }
    }
    d.prepare(`DELETE FROM samples WHERE ts < ?`).run(at - KEEP_MS)
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  return n
}

// History belongs to a person at a provider, not to any tool's account id:
// orca hands out fresh ids when an account is signed in again, and the same
// person can be reachable through orca, a default login and a portal home.
const who = (account) => [account.provider, account.email.toLowerCase()]

function series(account, kind, sinceMs) {
  return open().prepare(
    `SELECT ts, used_percent AS used, reset_at AS resetAt FROM samples
      WHERE provider = ? AND email = ? AND kind = ? AND ts >= ?
      ORDER BY ts ASC`
  ).all(...who(account), kind, sinceMs)
}

const since = (rows, ms) => rows.filter(r => r.ts >= Date.now() - ms)
const hoursBetween = (a, b) => (b.ts - a.ts) / HOUR_MS

// A reset sits between two readings when the window fell clearly, fell to
// nothing, or its reset time moved on by hours. Neither a one-point wobble in
// the percentage nor the provider's reset time jittering between 17:59 and
// 18:00 is a reset.
function resetBetween(a, b) {
  const drop = a.used - b.used
  return drop >= RESET_DROP || (drop > 0 && b.used < 1) ||
    (a.resetAt != null && b.resetAt != null && b.resetAt - a.resetAt > HOUR_MS)
}

// Percent-per-hour over the current window only: from the last reset onwards.
function burnRate(rows) {
  let start = 0
  for (let i = 1; i < rows.length; i++) if (resetBetween(rows[i - 1], rows[i])) start = i
  const use = rows.slice(start)
  if (use.length < 2) return null
  const first = use[0], last = use[use.length - 1]
  const hours = hoursBetween(first, last)
  if (hours < MIN_SPAN_H) return null
  return { perHour: (last.used - first.used) / hours, spanHours: hours }
}

// Consecutive weekly readings with the 5-hour reading taken at the same
// moment, skipping gaps too long to know what happened in them and pairs with
// a reset between them.
function* pairs(weekly, session) {
  const at = new Map(session.map(r => [r.ts, r.used]))
  for (let i = 1; i < weekly.length; i++) {
    const a = weekly[i - 1], b = weekly[i]
    const hours = hoursBetween(a, b)
    if (hours > MAX_GAP_H || resetBetween(a, b)) continue
    yield { hours, dWeekly: b.used - a.used, sa: at.get(a.ts), sb: at.get(b.ts) }
  }
}

// Weekly pace measured only across stretches when the 5-hour window was NOT
// dry. A plain average over the last few hours quietly includes throttle
// pauses, and then simulating those pauses on top would count them twice.
function activeRate(weekly, session, lockAt) {
  let dUsed = 0, dHours = 0
  for (const p of pairs(weekly, session)) {
    if ((p.sa != null && p.sa >= lockAt) || (p.sb != null && p.sb >= lockAt)) continue
    dUsed += p.dWeekly
    dHours += p.hours
  }
  return dHours >= MIN_SPAN_H ? { perHour: dUsed / dHours, spanHours: dHours } : null
}

// How many weekly points one 5-hour-window point costs on this account -- the
// median over intervals where both moved. Right after a weekly reset there is
// no weekly pace to measure yet, but the 5-hour window keeps moving, and this
// ratio turns its pace into a weekly one immediately.
function sessionToWeeklyRatio(weekly, session) {
  const ratios = []
  for (const p of pairs(weekly, session)) {
    if (p.sa == null || p.sb == null) continue
    const dS = p.sb - p.sa
    if (dS <= 0.5) continue          // the session window did not move (or reset)
    ratios.push(p.dWeekly / dS)
  }
  if (ratios.length < 3) return null
  ratios.sort((x, y) => x - y)
  return ratios[Math.floor(ratios.length / 2)]
}

// The fastest this account has ever been burned, in %/h, from any pair of
// readings half an hour to six hours apart with no reset between them. Runs of
// identical readings collapse to their ends first: the ends are the only pair
// in a run that can set a maximum, and five-minute polling makes runs long.
function peakRate(rows) {
  const ends = []
  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1], next = rows[i + 1]
    if (prev && next && prev.used === rows[i].used && next.used === rows[i].used) continue
    ends.push(rows[i])
  }
  let peak = null
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const hours = hoursBetween(ends[i], ends[j])
      if (hours > 6) break
      if (resetBetween(ends[i], ends[j])) break   // later pairs from i span the same reset
      if (hours < 0.5) continue
      const delta = ends[j].used - ends[i].used
      if (delta <= 0) continue                    // idle says nothing about how fast it CAN go
      const rate = delta / hours
      if (peak == null || rate > peak) peak = rate
    }
  }
  return peak
}

// Everything the engine wants to know about how an account burns, from one
// load of its readings:
//   pace         weekly %/h with where it came from, or null when unknowable
//   sessionRate  5-hour %/h, measured or scaled back from the weekly pace
//   peak         the fastest weekly pace ever seen
//   idle         readings exist over a usable span and the budget did not move
export function rates(account, { lockAt, kind = 'weekly' }) {
  const weekly = series(account, kind, Date.now() - LOOKBACK_MS)
  const session = series(account, '5h', Date.now() - LOOKBACK_MS)
  const recentW = since(weekly, RECENT_MS), recentS = since(session, RECENT_MS)

  let pace = null
  const active = activeRate(recentW, recentS, lockAt) ?? burnRate(recentW)
  if (active) pace = { ...active, source: 'measured' }
  else {
    // Readings only land when the portal runs. With none in the last few
    // hours, the average across the gap since the previous reading is still a
    // pace -- a coarse one, and labelled so.
    const coarse = burnRate(since(weekly, COARSE_MS))
    if (coarse) pace = { ...coarse, source: 'averaged' }
  }

  const sessionBurn = burnRate(recentS)
  let sessionRate = sessionBurn?.perHour ?? null
  const ratio = sessionToWeeklyRatio(weekly, session)

  // The 5-hour window moves faster and is read at the same whole-percent
  // resolution, so over a short span it is the finer instrument. Use it, scaled
  // by the ratio history knows between the two, when the weekly pace is missing
  // (right after a reset) or rests on under an hour and only a few points.
  if (sessionRate > 0 && ratio) {
    const thin = !pace || pace.perHour <= 0 ||
      (pace.spanHours < THIN_SPAN_H && pace.perHour * pace.spanHours < THIN_POINTS)
    if (thin) pace = { perHour: sessionRate * ratio, spanHours: sessionBurn.spanHours, source: 'estimated' }
  }
  // And the other way round: a weekly pace with no 5-hour pace yet still
  // throttles, at the rate the ratio implies.
  if (sessionRate == null && pace?.perHour > 0 && ratio > 0) sessionRate = pace.perHour / ratio

  return {
    pace: pace?.perHour > 0 ? pace : null,
    idle: !!pace && !(pace.perHour > 0),
    sessionMeasured: sessionBurn != null,
    sessionRate: sessionRate ?? 0,
    peak: peakRate(weekly),
  }
}

function lastReading(account) {
  const row = open().prepare(`SELECT MAX(ts) AS ts FROM samples WHERE provider = ? AND email = ?`).get(...who(account))
  if (!row?.ts) return null
  const windows = open().prepare(
    `SELECT kind, used_percent, reset_at FROM samples WHERE provider = ? AND email = ? AND ts = ?`
  ).all(...who(account), row.ts)
  if (windows.length === 0) return null
  return {
    at: row.ts,
    windows: windows.map(w => startsOnUse(account, w.kind, w.used_percent, w.reset_at, row.ts)
      ? { kind: w.kind, usedPercent: 0, resetAt: null, startsOnUse: true }
      : { kind: w.kind, usedPercent: w.used_percent, resetAt: w.reset_at }),
  }
}

// A Codex week nobody has touched has no clock yet (see providers/codex.js).
// Older readings stored the reset ChatGPT reported for it, a full week after
// the reading; those are recognised the same way.
function startsOnUse(account, kind, used, resetAt, at) {
  return account.provider === 'codex' && kind === 'weekly' && used === 0 &&
    (resetAt == null || Math.abs(resetAt - at - WEEK_MS) < 2 * 60 * 1000)
}

// A window whose reset time has passed since the reading was taken is empty
// now. The weekly window keeps ticking on its schedule; the 5-hour one only
// starts when the account is next used, so it has no next reset to show.
function rollOver(w, provider) {
  if (!w.resetAt || w.resetAt > Date.now()) return w
  // A Codex week, like every 5-hour window, starts again only on first use.
  if (provider === 'codex' && w.kind === 'weekly') {
    return { ...w, usedPercent: 0, resetAt: null, startsOnUse: true, rolled: true, rolledAt: w.resetAt }
  }
  const weekly = w.kind.split(':')[0] === 'weekly'
  let next = w.resetAt
  if (weekly) while (next <= Date.now()) next += WEEK_MS
  return { ...w, usedPercent: 0, resetAt: weekly ? next : null, rolled: true, rolledAt: w.resetAt }
}

// What an account's last reading means now, for when a live read is not
// possible. An account nobody is signed into right now is not spending
// anything, so its last reading stays true until a window resets -- and the
// reset times are known. A live account that merely failed transiently also
// replays, but only for an hour before it is treated as unknown.
export function replay(account, { inactive }) {
  const last = lastReading(account)
  if (!last) return null
  if (!inactive && Date.now() - last.at >= STALE_LIMIT_MS) return null
  return { ok: true, stale: true, staleAt: last.at, windows: last.windows.map(w => rollOver(w, account.provider)) }
}

// What was left on one window over recent readings, oldest first, for a sparkline.
export function trail(account, kind, sinceMs = 24 * HOUR_MS) {
  return series(account, kind, Date.now() - sinceMs).map(r => Math.max(0, 100 - r.used))
}

export function stats() {
  return { samples: open().prepare(`SELECT COUNT(*) AS n FROM samples`).get().n }
}
