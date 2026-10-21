// Every provider in one place. Key order is display order everywhere.
import * as claude from './claude.js'
import * as codex from './codex.js'

export const PROVIDERS = { claude, codex }
export const PROVIDER_ORDER = Object.keys(PROVIDERS)
