// The few questions portal ever asks, and only on a terminal. Every question
// has a default that Enter accepts, so the common path is Enter, Enter, done.

import { createInterface } from 'node:readline/promises'
import { bold, dim } from './render.js'

export const interactive = () => process.stdin.isTTY && process.stdout.isTTY && !process.env.PORTAL_NO_PROMPT

let rl = null
function line() {
  rl ??= createInterface({ input: process.stdin, output: process.stdout })
  return rl
}
export function close() {
  rl?.close()
  rl = null
}

// Ctrl+D or Ctrl+C at a question ends the whole conversation, quietly.
export class Stopped extends Error {}

export async function ask(question, fallback = '') {
  const hint = fallback ? dim(` [${fallback}]`) : ''
  let answer
  try {
    answer = (await line().question(`  ${question}${hint} `)).trim()
  } catch {
    close()
    throw new Stopped('stopped')
  }
  return answer || fallback
}

export async function yes(question, fallback = true) {
  const answer = (await ask(question + dim(fallback ? ' (Y/n)' : ' (y/N)'))).toLowerCase()
  if (!answer) return fallback
  return answer.startsWith('y')
}

// Pick one of a list by number; Enter takes the default.
export async function choose(question, items, { label = (x) => String(x), fallback = 0 } = {}) {
  console.log(`  ${question}`)
  items.forEach((x, i) => console.log(`    ${bold(String(i + 1))}  ${label(x)}${i === fallback ? dim('  ← default') : ''}`))
  for (;;) {
    const answer = await ask(dim('number'), String(fallback + 1))
    const n = Number(answer)
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]
  }
}
