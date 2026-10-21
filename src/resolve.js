// Turning what he typed into accounts. `<who>` is a name he chose, or any part
// of an address, Chrome profile name or plan: "work", "acme", "team" all work.
// A provider's name means all of that provider's accounts.

import { PROVIDERS } from './providers/index.js'
import { nameOf } from './ui/words.js'

export function resolveAccounts(accounts, selector) {
  if (!selector || selector === 'all') return accounts
  const want = selector.toLowerCase()
  if (PROVIDERS[want]) return accounts.filter(a => a.provider === want)

  // An exact address or a name he chose wins outright -- "personal" must mean
  // the account he named that, never the ones on a Personal plan.
  const exact = accounts.filter(a => a.email === want || a.names.includes(want))
  if (exact.length) return exact

  const hits = accounts.filter(a =>
    a.email.includes(want) ||
    a.names.some(n => n.includes(want)) ||
    (a.chrome?.label ?? '').toLowerCase().includes(want) ||
    (a.chrome?.dir ?? '').toLowerCase() === want ||
    String(a.plan ?? '').toLowerCase().includes(want))
  if (hits.length === 0) {
    throw new Error(`no account matches "${selector}"\n  known: ${people(accounts).map(p => p.label).join(', ')}`)
  }
  return hits
}

// One person, not a coin flip: "smith" matching two addresses is refused
// with the list, rather than opening whichever came first.
export function resolvePerson(accounts, selector) {
  if (!selector) throw new Error('say which account')
  const matches = resolveAccounts(accounts, selector)
  const emails = [...new Set(matches.map(a => a.email))]
  if (emails.length > 1) {
    throw new Error(`"${selector}" matches ${emails.length} people — be more specific:\n  ${emails.join('\n  ')}`)
  }
  return matches
}

// One entry per person: the address, the names that reach it, the providers
// it has accounts with, and its Chrome profile.
export function people(accounts) {
  const map = new Map()
  for (const a of accounts) {
    const p = map.get(a.email) ?? { email: a.email, names: a.names, chrome: a.chrome, accounts: [], label: nameOf(a) }
    p.accounts.push(a)
    map.set(a.email, p)
  }
  return [...map.values()]
}
