---
name: portal
description: Use when the user asks which Claude or Codex account to use, how much usage or quota is left, when limits reset or plans renew, wants to open Claude/ChatGPT/Codex or any site in the right Chrome profile, or wants to sign in an account or run a login (gcloud, gh, their own) in the right profile — through the `portal` CLI.
---

# portal

`portal` is a CLI that knows every Claude and Codex account on this machine,
what's left on each, and which Chrome profile each one belongs to. Drive it;
never read or handle tokens yourself.

## Reading
- `portal --json` — every account: `state` (live / replay / unreadable / none),
  `usage.windows[]` with `leftPercent` and `resetAt` (ms), and `plan`
  (`left`, `resetAt`, `verdict`, `need`/`doing`/`peak` in %/h).
- `portal next` — one line per provider: the account to use now.
- `portal <who> --json` — one person's accounts in full.
- `portal check` — who gcloud, gh, the user's own recipes and the default CLIs are signed in as.

The rule portal plans by: use the account whose weekly budget resets soonest
(its tokens are lost first). The 5-hour window is a throttle, not a budget.

## Setting up (and adding accounts)
1. Run `portal setup`. From here it cannot ask questions, so it prints what it
   found (Chrome profiles, accounts, installed tools) and, for every account
   that can't be read live, the exact command to sign it in.
2. Tell the user which accounts those are, then run each `portal login …`
   command one at a time. Each opens the sign-in page in that account's Chrome
   profile and waits until the user approves it in the browser.
3. To add an account portal doesn't know yet:
   `portal login claude|codex <address or Chrome profile name>`.
4. Finish with `portal` and confirm every account reads live (no "last
   readings shown" line).

Names, logins and sites are like aliases:
- `portal alias <name> <who>` — "work" now means that account. `<who>` can
  also be a Chrome profile with no Claude/Codex account (e.g. a GitHub-only
  work profile); `portal profiles` lists every profile with its names.
- `portal recipe add <name> [--check="<cmd> whoami"] -- <command> {email}` —
  register a login (`{email}` is filled in per account); then
  `portal login <name> <who> [-- extra flags]`.
- `portal site add <name> <url>` — then `portal open <name> <who>`.
- `portal profile <who> <chrome profile>` — for an address no Chrome profile
  is signed into. `portal renews <who> <YYYY-MM-DD>` — a Claude plan's renewal.

## Acting (each opens a browser; tell the user before running)
- `portal open claude|codex|chatgpt [who]` — the usage page, in that person's
  Chrome profile (`--chat` for a new chat); with no `who`, the account to use now.
- `portal login claude|codex <who>` — give that account a sign-in of its own
  (the official `claude auth login` / `codex login` in a dedicated config dir).
- `portal login <recipe> <who> [-- flags]` — gcloud (`google`, `gcloud`, `adc`),
  `gh`, or a recipe the user added (`portal recipe` lists them).

Add `--dry-run` to `open`/`login` to show what would run without running it.
Never read, print or move tokens; portal only reads them where the official
CLIs keep them.
