# portal

Every Claude and Codex account you have, in one terminal screen: what's left on
each one, when it comes back, which one to use now, and when to switch. Each
account's Chrome profile is one command away, and so are the logins you
repeat (gcloud, gh, anything), each landing in the right profile.

```
  ▌ claude  use hash — ~32% goes unused at reset · need 5.1%/h, doing 2.5%/h
  ▌         5h window runs out ~15:08 → switch to company.com · hash is back 15:38
  ▌
  ▌     account      plan     what is left                         resets in
  ▌  ●  hash         Max 20x  ███████▍····  61% left  (fable 40%)  11h 59m    5h 15% left · back 15:38
  ▌  ○  company.com  Max 20x  ▋···········   5% left               1d 22h
  ▌  ○  spare        Max 5x   █████████▋··  80% left               2d 11h

  ▌ codex   nothing usable · hash is back tmrw 15:38
  ▌         company.com can spend a banked reset now
  ▌
  ▌     account      plan  what is left           resets in
  ▌  ○  hash         Pro   ············  0% left  1d 1h
  ▌  ○  company.com  Pro   ············  0% left  3d 17h     1 banked reset
```

Node 22.13+ and nothing else: no dependencies. Built and tested on macOS with
Chrome; the Linux paths are in place but untested.

## Install

One line, the way Homebrew installs:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/thekoalaperson/portal/main/install.sh)"
```

It checks for Node 22.13+ and git, and offers to install Node with Homebrew if
it's missing. It clones portal into `~/.portal`, links `~/.local/bin/portal`,
adds `~/.local/bin` to your PATH if it isn't there, then offers to run
`portal setup`. Run it again any time to update, or use `portal update`.

Uninstall: `rm ~/.local/bin/portal && rm -rf ~/.portal`, plus `~/.config/portal`
and `~/.local/share/portal` if you also want your settings and history gone.

### From Claude Code or Codex

The `plugin/` folder is a plugin for both. It lets the agent answer "which
account should I use?", walk you through setup and add accounts, logins and
names, all through the CLI:

```
# Claude Code
/plugin marketplace add thekoalaperson/portal
/plugin install portal@portal

# Codex
codex plugin marketplace add thekoalaperson/portal
codex plugin add portal@portal
```

## Setting up

```sh
portal setup      # find what's there, sign in what can't be read, add more
portal add        # add one account: pick its Chrome profile, sign in once
```

Each account you add gets a config dir of its own (`CLAUDE_CONFIG_DIR` /
`CODEX_HOME`), signed in with the official CLI in the Chrome profile you pick.
This is the multi-account setup both vendors document. From then on the CLI
renews the sign-in itself, and portal only reads it.

Accounts portal finds on its own:

| Where | What |
|---|---|
| `~/.claude`, `~/.codex` | the default Claude and Codex logins |
| portal's own sign-ins | `~/.local/share/portal/homes/*` |
| [orca](https://github.com/stablyai/orca), when installed | every account orca manages (read-only) |
| Chrome's `Local State` | which profile is signed into which address |

## Every day

```sh
portal                     # what to use now, when to switch, every account
portal <who>               # one account in full: every window, pace, renewal, sign-in
portal open claude         # the account to use now: its usage page, in its Chrome profile
portal open codex work     # work's Codex usage page, in work's profile   (also: chatgpt, your own sites)
portal open claude --chat  # a new chat instead of the usage page
portal open codex --all    # every Codex account, one window each   (portal open all: every profile)
portal login google work   # gcloud + Drive + ADC as work, with the login page in work's profile
portal next | plan | schedule | history | watch | accounts | check
```

Rows show each account by its address, shortened to what tells it apart: a
Gmail's local part, or the domain of anything else. `<who>` is whatever you
type to reach one: a name you gave, or any part of an address, Chrome profile
name or plan.

```sh
portal alias work acme                # "work" now means that account (Claude and Codex alike)
portal alias gh-work "GitHub Work"    # a Chrome profile works too, even one with no Claude/Codex account
portal open gh-work                   # then open it, or: portal login gh gh-work
portal profiles                       # every Chrome profile: who it's signed in as, its names, its accounts
```

### What the home screen tells you

- **Everything is what's left**, never what's used. Bars drain.
- **The weekly budget is the number.** The 5-hour window is a throttle that
  refills on its own, so it only shows up once it's at 20% or below, or dry, and
  never when the week has less left than it does. A model cap tighter than the
  week rides along as a bracket, e.g. `(fable 40%)`. `portal --all` shows every
  window.
- **Use the account whose week resets soonest.** Its tokens are the first to
  go to waste. The accounts are listed in that order.
- **The coloured edge** is green when you're on course, yellow when something
  will go unused, and red when nothing is usable.
- **When to switch**: the time your current account's 5-hour window or week
  runs out at the pace you're going, and which account to move to.
- **The pace**: what each week needs (`left ÷ hours to reset`) against what it's
  getting, measured from portal's own readings with throttle pauses left out,
  and played forward through the 5-hour throttle. `portal plan` shows it all.

## Logins, as recipes

`portal login <recipe> <who>` runs a login so its browser step lands in that
person's Chrome profile. gcloud and gh are pointed there through `BROWSER` /
`GH_BROWSER`. Tools that ignore those get the profile brought to the front
first.

Built in: `google` (gcloud with Drive scope, plus ADC), `gcloud`, `adc`, `gh`,
plus `claude` and `codex` for their own sign-ins. Add your own the way you add
an alias:

```sh
portal recipe add vpn -- vpnctl login --user {email}
portal login vpn work -- --region eu        # extra flags pass through
portal recipe add mytool --check="mytool whoami" -- mytool login   # a tool that just calls `open`
portal check                                # who each tool is signed in as
```

## How it reads usage, and what it never does

- **Usage** comes from the same endpoints the official apps use:
  `api.anthropic.com/api/oauth/usage` and `chatgpt.com/backend-api/wham/usage`.
  Both are reads and use no quota. Neither is a documented public API, so a
  provider change can break a reading. When a read fails, portal shows the last
  reading, marked with its age.
- **Identity** is checked before any number is believed: the default login
  holds whoever signed in last.
- **Tokens are only read.** portal never refreshes, copies, stores or sends one
  anywhere but the provider that issued it. When a token has expired, the
  official CLI renews it: `claude` is asked for its usage over its control
  channel, `codex app-server` for its rate limits. Neither request generates
  anything. Refresh tokens rotate, so exactly one owner, the CLI, ever renews.
  portal asks for a renewal only where it's the sign-in's sole caretaker:
  - Claude: only sign-ins portal made itself. The default login and orca's are
    renewed by Claude Code and orca.
  - Codex: every home except `~/.codex`, which the ChatGPT app keeps fresh.
    orca never renews Codex tokens.

  The Codex renewal has been seen working against a real expired login. The
  Claude one is exercised by the tests with a stand-in CLI, and gets its first
  real check the first time one of portal's own Claude sign-ins expires.
- **A Claude sign-in lasts about four weeks past its last renewal.** An account
  nobody uses (no Claude Code, no portal run) for longer than that needs one
  more `portal login claude <who>`. `portal <who>` shows the date.
- **Every sign-in goes through the vendor's own login**: `claude auth login` or
  `codex login`.

## Files

| Path | Holds |
|---|---|
| `~/.config/portal/config.json` | names, extra accounts, recipes, sites. No secrets; safe to keep in dotfiles |
| `~/.local/share/portal/history.db` | readings, for pace and history (30 days) |
| `~/.local/share/portal/cache.json` | the last reading per account, and which token belongs to whom (by fingerprint, never the token) |
| `~/.local/share/portal/homes/` | config dirs of the accounts portal signed in |

`PORTAL_HOME=<dir>` puts all of it under one directory.

## Tests

```sh
npm test                       # every screen in 12 situations, fresh-machine runs, the live read path
SHOW=overrun npm test          # also print one situation's home screen
```

No test touches a real token, the Keychain or the internet. Each one builds a
throwaway home with fake sign-ins, plus recorded provider responses or a local
stand-in for the provider endpoints and CLIs, and seeded history.
