// Turning what he typed into accounts. `<who>` is a name he chose, or any part
// of an address, Chrome profile name or plan: "work", "acme", "team" all work.
// A provider's name means all of that provider's accounts.

import { findProfile, profileFor, profiles } from './chrome.js'
import { PROVIDERS } from './providers/index.js'
import { nameOf } from './ui/words.js'

// Every account a selector reaches; an empty list when it reaches none.
function matchAccounts(accounts, selector) {
  if (!selector || selector === 'all') return accounts
  const want = selector.toLowerCase()
  if (PROVIDERS[want]) return accounts.filter(a => a.provider === want)
  // An exact address or a name he chose wins outright -- "personal" must mean
  // the account he named that, never the ones on a Personal plan.
  const exact = accounts.filter(a => a.email === want || a.names.includes(want))
  if (exact.length) return exact
  return accounts.filter(a =>
    a.email.includes(want) ||
    a.names.some(n => n.includes(want)) ||
    (a.chrome?.label ?? '').toLowerCase().includes(want) ||
    (a.chrome?.dir ?? '').toLowerCase() === want ||
    String(a.plan ?? '').toLowerCase().includes(want))
}

const labels = (accounts) => [...new Set(accounts.map(nameOf))].join(', ')

export function notFound(accounts, selector) {
  const all = profiles()
  return new Error(`no account or Chrome profile matches "${selector}"` +
    (accounts.length ? `\n  accounts: ${labels(accounts)}` : '') +
    (all.length ? `\n  profiles: ${all.map(p => p.label).join(', ')}` : ''))
}

// One person, not a coin flip: "smith" matching two addresses is refused
// with the list, rather than opening whichever came first.
function onePerson(matches, selector) {
  const emails = [...new Set(matches.map(a => a.email))]
  if (emails.length > 1) throw new Error(`"${selector}" matches ${emails.length} people — be more specific:\n  ${emails.join('\n  ')}`)
  return matches
}

export function resolveAccounts(accounts, selector) {
  const hits = matchAccounts(accounts, selector)
  if (hits.length === 0) throw new Error(`no account matches "${selector}"\n  known: ${labels(accounts)}`)
  return hits
}

export function resolvePerson(accounts, selector) {
  if (!selector) throw new Error('say which account')
  return onePerson(resolveAccounts(accounts, selector), selector)
}

// Where a selector leads: a person's accounts and their Chrome profile, or a
// Chrome profile on its own -- a GitHub-only work profile has no Claude or
// Codex account and is still a place to open a page or sign in. Accounts
// first, then names given to profiles, then the profiles themselves by name,
// directory or address. null when it leads nowhere.
export function locate(accounts, cfg, selector) {
  const hits = matchAccounts(accounts, selector)
  if (hits.length) {
    const person = onePerson(hits, selector)
    return { email: person[0].email, profile: person[0].chrome, accounts: person }
  }
  const named = cfg.names[selector.toLowerCase()]
  let found
  if (named) found = [typeof named === 'string' ? profileFor(named, cfg) : findProfile(named.profile)].filter(Boolean)
  else {
    const exact = findProfile(selector)
    const want = selector.toLowerCase()
    found = exact ? [exact] : profiles().filter(p => p.label.toLowerCase().includes(want) || (p.email && p.email.includes(want)))
  }
  if (found.length > 1) throw new Error(`"${selector}" matches ${found.length} Chrome profiles — be more specific:\n  ${found.map(p => p.label).join('\n  ')}`)
  return found.length ? { email: found[0].email || null, profile: found[0], accounts: [] } : null
}

export function resolveProfile(accounts, cfg, selector) {
  if (!selector) throw new Error('say which account or Chrome profile')
  const found = locate(accounts, cfg, selector)
  if (!found) throw notFound(accounts, selector)
  return found
}
