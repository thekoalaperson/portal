// Login recipes: a command that signs something in through a browser, run so
// the browser part lands in the right Chrome profile.
//
// Two ways to steer the browser, and a recipe says which it needs:
//   env    BROWSER / GH_BROWSER point at a tiny opener that puts the login page
//          in the chosen profile. gcloud and gh honour these (verified).
//   focus  bring the profile's window forward first, so a tool that just calls
//          `open <url>` lands in it. The fallback for tools that ignore BROWSER.
// The env route is always set too; it costs nothing when a tool ignores it.
//
// Placeholders in a recipe's argv: {email} the account's address, {profile}
// the Chrome profile directory.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './chrome.js'
import { run } from './platform.js'

const PROBE_TIMEOUT_MS = 4000
const OPENER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'portal-browser')

export const BUILTIN = {
  google: {
    about: 'gcloud login with Drive access, and Application Default Credentials',
    // --force: without it gcloud silently reuses stored credentials and skips
    // the browser, so a Drive scope you asked for may never be granted.
    run: ['gcloud', 'auth', 'login', '{email}', '--enable-gdrive-access', '--update-adc', '--force'],
    check: ['gcloud', 'config', 'get-value', 'account'],
    browser: 'env',
  },
  gcloud: {
    about: 'gcloud login',
    run: ['gcloud', 'auth', 'login', '{email}'],
    check: ['gcloud', 'config', 'get-value', 'account'],
    browser: 'env',
  },
  adc: {
    about: 'gcloud Application Default Credentials only',
    run: ['gcloud', 'auth', 'application-default', 'login'],
    browser: 'env',
  },
  gh: {
    about: 'GitHub CLI login',
    run: ['gh', 'auth', 'login', '--web', '--hostname', 'github.com'],
    check: ['gh', 'auth', 'status', '--active', '--hostname', 'github.com'],
    browser: 'env',
  },
}

export function allRecipes(cfg) {
  return { ...BUILTIN, ...cfg.recipes }
}

const fill = (argv, vars) => argv.map(a => a.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''))
  .filter((a, i, all) => !(a === '' && all[i] !== argv[i]))   // a placeholder with no value drops out

export const shellish = (argv) => argv.map(a => /[\s"']/.test(a) ? JSON.stringify(a) : a).join(' ')

// Everything a recipe run needs, without running it: for --dry-run and the run itself.
export function prepare(recipe, { email, profile, extra = [], env = {} }) {
  const argv = [...fill(recipe.run, { email, profile: profile?.dir }), ...extra]
  const childEnv = { ...process.env, ...env }
  if (profile) {
    childEnv.PORTAL_PROFILE = profile.dir
    childEnv.BROWSER = OPENER
    childEnv.GH_BROWSER = OPENER
  }
  return { argv, env: childEnv, focus: !!profile && (recipe.browser ?? 'focus') !== 'env' }
}

// Run a prepared recipe in the foreground: its prompts and output are his.
export async function runPrepared({ argv, env, focus }, profile) {
  if (focus && profile) {
    launch(profile, null)
    if (!process.env.PORTAL_NO_BROWSER) await new Promise(r => setTimeout(r, 1800))
  }
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env })
    p.on('error', (err) => resolve({ code: 127, error: err.message }))
    p.on('exit', (code) => resolve({ code: code ?? 1 }))
  })
}

// Who a recipe's tool is signed in as, from its check command's output. Quiet
// and bounded: a probe never prompts, and never takes long.
export async function probe(recipe) {
  if (!recipe.check) return null
  let out, ok
  try {
    const r = await run(recipe.check[0], recipe.check.slice(1), { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
    out = r.stdout + r.stderr
    ok = true
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, text: 'not installed' }
    if (err.killed) return { ok: false, text: 'timed out' }
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`   // gh auth status exits 1 with the useful text
    ok = false
  }
  const email = out.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0]
  const account = out.match(/account\s+(\S+)/)?.[1]
  const first = out.split('\n').map(s => s.trim()).find(Boolean) ?? ''
  return { ok, text: email ?? account ?? first.slice(0, 60) }
}
