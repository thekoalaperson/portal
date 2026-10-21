// Shared by the tests: where the repo is, a fake id_token, a clean
// environment, and one way to run portal.

import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const H = 3_600_000
export const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

// The machine's own logins must not leak in: orca's terminals set these.
const { CODEX_HOME, CLAUDE_CONFIG_DIR, ...clean } = process.env
export const cleanEnv = clean

// Run bin/portal. Resolves with its output, or with { failed, code, out } when
// it exits with a code not in allowExit.
export function runPortal(env, args, { allowExit = [] } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, 'bin/portal'), ...args], {
      env: { ...cleanEnv, ...env, NO_COLOR: '1', FORCE_COLOR: '', COLUMNS: '92' }, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (!err || allowExit.includes(err.code)) resolve(stdout)
      else resolve({ failed: true, code: err.code, out: stdout + stderr })
    })
  })
}
