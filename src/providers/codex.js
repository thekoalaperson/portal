// Codex usage. Verified live.
//
// /backend-api/codex/usage returns 403 for a CLI bearer token; /backend-api/wham/usage
// is the one that answers, with the same rate_limit shape the CLI writes into
// its rollout logs. It is a read -- polling it does not consume quota.
//
// Each Codex login is a CODEX_HOME with an auth.json; the same person can be
// signed in in several (orca's home, ~/.codex for the ChatGPT app and a bare
// `codex`), each refreshed only when something runs there. So every copy is
// tried, freshest first, and the account id must match.

import { readFile } from 'node:fs/promises'

export const urls = {
  chat: 'https://chatgpt.com/codex',
  usage: 'https://chatgpt.com/codex/settings/usage',
}

// PORTAL_CODEX_API points the reads at a stand-in server in tests.
const USAGE_URL = `${process.env.PORTAL_CODEX_API ?? 'https://chatgpt.com'}/backend-api/wham/usage`

async function readCred(cred) {
  const blob = await readFile(cred.path, 'utf8').then(JSON.parse).catch(() => null)
  const token = blob?.tokens?.access_token ?? blob?.access_token
  if (!token) return null
  return { ...cred, token, accountId: blob?.tokens?.account_id ?? null, refreshedAt: Date.parse(blob?.last_refresh ?? '') || 0 }
}

// Codex reports window length in seconds; name the ones we recognise.
function windowKind(seconds) {
  if (seconds <= 60 * 60 * 6) return '5h'
  if (seconds <= 60 * 60 * 24 * 8) return 'weekly'
  return 'monthly'
}

// ChatGPT starts a window's clock on first use. Until then it reports the reset
// as one full window from whenever it is asked (0s into the window, every
// time), so that time is not a deadline. A week started by a single message is
// still at 0% used, but seconds into its window, with a fixed reset -- so the
// slack is seconds, not minutes.
export const UNSTARTED_SLACK_S = 10

function normalizeWindow(w) {
  if (!w) return null
  const kind = windowKind(w.limit_window_seconds)
  if (w.used_percent === 0 && w.limit_window_seconds - w.reset_after_seconds < UNSTARTED_SLACK_S) {
    return { kind, usedPercent: 0, resetAt: null, startsOnUse: true }
  }
  return { kind, usedPercent: w.used_percent, resetAt: w.reset_at * 1000 }
}

// Paid usage credits: what keeps Codex going once the plan's limits are hit.
function normalizeCredits(c) {
  if (!c) return null
  const balance = Number(c.balance ?? 0)
  if (!c.unlimited && !(c.has_credits && balance > 0)) return null
  return {
    unlimited: c.unlimited === true,
    balance,
    localMessages: c.approx_local_messages ?? null,
    exhausted: c.overage_limit_reached === true,
  }
}

export function normalize(body) {
  const rl = body.rate_limit ?? {}
  return {
    plan: body.plan_type,
    blocked: rl.limit_reached === true || rl.allowed === false,
    windows: [normalizeWindow(rl.primary_window), normalizeWindow(rl.secondary_window)].filter(Boolean),
    // Banked resets: how many the account holds, and how many apply right now
    // (a reset only applies once a limit has actually been hit).
    resets: body.rate_limit_reset_credits
      ? { banked: body.rate_limit_reset_credits.available_count ?? 0,
          usableNow: body.rate_limit_reset_credits.applicable_available_count ?? 0 }
      : null,
    credits: normalizeCredits(body.credits),
  }
}

export async function fetchUsage(account, { signal } = {}) {
  const read = (await Promise.all(account.creds.map(readCred))).filter(Boolean)
    // The shared ~/.codex holds whoever signed in last; it counts only when it is this account.
    .filter(c => !account.providerAccountId || !c.accountId || c.accountId === account.providerAccountId)
    .sort((a, b) => b.refreshedAt - a.refreshedAt)
  if (read.length === 0) return { ok: false, inactive: true, error: 'not signed in', expiredCreds: [] }

  let res, found = null
  const expired = []
  for (const c of read) {
    try {
      res = await fetch(USAGE_URL, {
        signal,
        headers: {
          authorization: `Bearer ${c.token}`,
          accept: 'application/json',
          'chatgpt-account-id': account.providerAccountId ?? c.accountId ?? '',
          'user-agent': 'portal/1',
        },
      })
    } catch (err) {
      return { ok: false, error: `network: ${err.message}` }
    }
    if (res.status === 401) { expired.push(c); continue }
    found = c
    break
  }
  if (!found) return { ok: false, inactive: true, expired: true, error: 'sign-in expired', expiredCreds: expired }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }

  const body = await res.json()
  return { ok: true, email: body.email, ...normalize(body), source: found.source }
}
