// Terminal rendering. Colour is suppressed when stdout is not a TTY or when
// NO_COLOR is set, so piping to a file or another tool stays clean.
//
// One look for every screen: a section is a bold title running into a faint
// rule, a table has a dim header row with numbers right-aligned, and a state
// is a dot (● live, ○ not) in the colour of what it means.

const useColor = (process.stdout.isTTY && !process.env.NO_COLOR) || !!process.env.FORCE_COLOR

const code = (n) => (s) => useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s)
export const dim = code(2)
export const bold = code(1)
export const red = code(31)
export const green = code(32)
export const yellow = code(33)
export const blue = code(34)
export const magenta = code(35)
export const cyan = code(36)

// Width to draw rules across: the terminal's, capped so a wide window does not
// turn into a line of dashes.
export const screenWidth = () => Math.min(process.stdout.columns ?? 92, 92)

// Everything is shown as what is LEFT, never what is used: a gauge that drains.
export function leftColor(left) {
  if (left <= 5) return red
  if (left <= 25) return yellow
  return green
}

// "3h 12m", "2d 4h", "12m"; past times come out dim with "ago".
export function relative(ms, now = Date.now()) {
  if (ms == null) return dim('—')
  const delta = ms - now
  const past = delta < 0
  let s = Math.abs(delta) / 1000
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60)
  const out = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  return past ? dim(`${out} ago`) : out
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString()

// A wall-clock time, with the weekday only when it is not today: "18:40", "Thu 09:15".
export function clock(ms, now = Date.now()) {
  if (ms == null) return dim('—')
  const t = new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (sameDay(ms, now)) return t
  const tomorrow = sameDay(ms, now + 86_400_000)
  const day = tomorrow ? 'tmrw' : new Date(ms).toLocaleDateString(undefined, { weekday: 'short' })
  return `${day} ${t}`
}

// "today", "tomorrow", then the weekday and date.
export function dayLabel(ms) {
  const day = (t) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / 86_400_000)
  const diff = day(ms) - day(Date.now())
  if (diff === 0) return 'today'
  if (diff === 1) return 'tomorrow'
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}

export const dateOnly = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

// Column widths are measured on the uncoloured text, since escape codes carry
// no display width.
export const visibleWidth = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length
export const padRight = (s, n) => String(s) + ' '.repeat(Math.max(0, n - visibleWidth(s)))
export const padLeft = (s, n) => ' '.repeat(Math.max(0, n - visibleWidth(s))) + String(s)

// rows: arrays of cells, a string for a free line, null for a blank line, or
// RULE for a faint divider. align: one letter per column, 'l' or 'r'.
export const RULE = Symbol('rule')

export function table(rows, { headers, align = '', gap = 2, indent = 2, rule = true } = {}) {
  const data = rows.filter(Array.isArray)
  if (data.length === 0) return ''
  const all = headers ? [headers, ...data] : data
  const cols = Math.max(...all.map(r => r.length))
  const widths = []
  for (let c = 0; c < cols; c++) widths[c] = Math.max(...all.map(r => visibleWidth(r[c] ?? '')))
  const pad = ' '.repeat(indent)
  const line = (r) => pad + r.map((cell, c) =>
    (align[c] === 'r' ? padLeft : padRight)(cell ?? '', widths[c])).join(' '.repeat(gap)).trimEnd()
  const width = screenWidth() - indent

  const out = []
  if (headers) {
    out.push(dim(line(headers)))
    if (rule) out.push(pad + dim('─'.repeat(width)))
  }
  for (const r of rows) {
    if (r == null) out.push('')
    else if (r === RULE) out.push(pad + dim('╌'.repeat(width)))
    else if (typeof r === 'string') out.push(pad + r)
    else out.push(line(r))
  }
  return out.join('\n')
}

// "claude ─────────────────" -- a title that runs into a rule.
export function section(title, { width = screenWidth(), indent = 2, note = '' } = {}) {
  const pad = ' '.repeat(indent)
  const head = bold(title) + (note ? ' ' + dim(note) : '')
  const rest = Math.max(4, width - indent - visibleWidth(head) - 1)
  return pad + head + ' ' + dim('─'.repeat(rest))
}

// A whole screen: a banner saying what this is and when, a table, footnotes.
export function screen({ what, note, rows, headers, align, footnotes = [], empty = 'nothing to show' }) {
  const out = ['', banner(what, note), '']
  const body = table(rows, { headers, align })
  out.push(body || dim('  ' + empty))
  if (footnotes.length) out.push('', ...footnotes.map(f => dim('  ' + f)))
  out.push('')
  return out.join('\n')
}

export const banner = (what, note) =>
  '  ' + bold('portal') + dim(` · ${what}`) + (note ? dim(` · ${note}`) : '')

// One format for every pace, duration and percentage, so no two screens round
// differently.
export const pace = (r) => r == null ? dim('—')
  : `${(r < 0.1 && r > 0 ? r.toFixed(2) : r.toFixed(1)).replace(/(\.\d)0$/, '$1')}%/h`
export const hrs = (h) => h >= 48 ? `${(h / 24).toFixed(1)}d` : h >= 1 ? `${h.toFixed(1)}h` : `${Math.max(1, Math.round(h * 60))}m`
export const spanLabel = (h) => h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : hrs(h)
export const percent = (n) => leftColor(n)(`${Math.round(n)}%`)

// A state, as a coloured dot and a word: ● on track, ○ locked.
export const dot = (color, text, { live = true } = {}) => color(live ? '●' : '○') + ' ' + text

// Shorter is better in a dense table: a gmail address is only its local part,
// anything else keeps the domain because that is what tells it apart.
export function shortEmail(email) {
  const [local, domain] = String(email).split('@')
  return domain === 'gmail.com' || domain === 'googlemail.com' ? local : domain ?? local
}

const TAG = { codex: cyan, claude: magenta }
export const providerColor = (p) => TAG[p] ?? dim

// A gauge of what is left: full when untouched, draining as it is used. Eighth-
// blocks give ~8x the resolution of whole cells, which matters when the gap
// between 39% and 37% left is the whole point.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
export function meter(left, width = 10, color = leftColor) {
  const clamped = Math.max(0, Math.min(100, left ?? 0))
  const exact = (clamped / 100) * width
  const full = Math.floor(exact)
  const rem = EIGHTHS[Math.round((exact - full) * 8)] ?? ''
  const filled = '█'.repeat(full) + rem
  const pad = Math.max(0, width - visibleWidth(filled))
  return color(clamped)(filled) + dim('·'.repeat(pad))
}

// A row of values as bars, 0..100 → ▁..█, thinned to fit the width.
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
export function sparkline(values, width = 16) {
  if (!values || values.length === 0) return dim('·'.repeat(width))
  const picked = values.length <= width ? values
    : Array.from({ length: width }, (_, i) => values[Math.round(i * (values.length - 1) / (width - 1))])
  return picked.map(v => {
    const clamped = Math.max(0, Math.min(100, v))
    return leftColor(clamped)(BARS[Math.min(7, Math.floor(clamped / 12.5))])
  }).join('')
}
