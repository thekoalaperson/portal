// The one-line installer, run the way a new computer would: an empty HOME,
// nothing of portal's on the PATH, macOS's own /bin/bash (3.2), no terminal to
// ask questions on. It clones this repository from disk instead of GitHub.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nodeDir = dirname(process.execPath)

function install(home, extra = {}) {
  return spawnSync('/bin/bash', [join(root, 'install.sh')], {
    env: {
      HOME: home, SHELL: '/bin/zsh', PATH: `${nodeDir}:/usr/bin:/bin`,
      PORTAL_REPO: root, PORTAL_NO_SETUP: '1', NO_COLOR: '1', ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  })
}

test('installs on a fresh machine, puts portal on the PATH, and updates in place', () => {
  const home = mkdtempSync(join(tmpdir(), 'portal-install-'))
  const r = install(home)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /installed into .*\.portal/)
  assert.match(r.stdout, /portal \d+\.\d+\.\d+/)
  const link = join(home, '.local/bin/portal')
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readlinkSync(link), join(home, '.portal/bin/portal'))
  const rc = readFileSync(join(home, '.zshrc'), 'utf8')
  assert.match(rc, /# added by the portal installer\nexport PATH="\$HOME\/\.local\/bin:\$PATH"/)

  // Again: an update, and the PATH line is not added twice.
  const again = install(home)
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.match(again.stdout, /updated .*\.portal/)
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8').match(/added by the portal installer/g).length, 1)
})

test('leaves the PATH alone when it already has ~/.local/bin, or when told to', () => {
  const home = mkdtempSync(join(tmpdir(), 'portal-install-'))
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  const r = install(home, { PATH: `${home}/.local/bin:${nodeDir}:/usr/bin:/bin` })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!existsSync(join(home, '.zshrc')))
  const home2 = mkdtempSync(join(tmpdir(), 'portal-install-'))
  const r2 = install(home2, { PORTAL_NO_MODIFY_PATH: '1' })
  assert.equal(r2.status, 0, r2.stdout + r2.stderr)
  assert.ok(!existsSync(join(home2, '.zshrc')))
  assert.match(r2.stdout, /isn't on your PATH. Add this to .*\.zshrc/)
})

test('says what to install when Node is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'portal-install-'))
  const r = install(home, { PATH: '/usr/bin:/bin' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /needs Node 22\.13 or newer \(you have: not installed\)/)
  assert.ok(!existsSync(join(home, '.portal')), 'nothing installed without Node')
})
