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

## Acting (each opens a browser; tell the user before running)
- `portal open claude|codex|chatgpt [who]` — in that person's Chrome profile;
  with no `who`, the account to use now.
- `portal login claude|codex <who>` — give that account a sign-in of its own
  (the official `claude auth login` / `codex login` in a dedicated config dir).
  Use this when an account shows as not readable live.
- `portal login <recipe> <who> [-- flags]` — gcloud (`google`, `gcloud`, `adc`),
  `gh`, or a recipe the user added (`portal recipe` lists them).
- `portal recipe add <name> -- <command {email}>` — register a login.
- `portal name <name> <who>`, `portal profile <who> <chrome profile>`,
  `portal renews <who> <YYYY-MM-DD>` — config, no browser.

`portal setup` and `portal add` ask questions on a terminal; from here prefer
the non-interactive commands above. Add `--dry-run` to `open`/`login` to show
what would run without running it.
