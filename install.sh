#!/usr/bin/env bash
# portal installer.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/thekoalaperson/portal/main/install.sh)"
#
# What it does, and nothing else:
#   1. checks for git and Node 22.13+ (on a Mac with Homebrew, offers to install Node)
#   2. clones portal into ~/.portal, or updates it if it is already there
#   3. links ~/.local/bin/portal to it
#   4. puts ~/.local/bin on your PATH if it is not (one marked line in your shell's rc file)
#   5. offers to run `portal setup`
# Run it again any time: it updates in place.
#
# Settings (environment variables):
#   PORTAL_DIR             where portal lives            (default ~/.portal)
#   PORTAL_BIN             where the `portal` link goes  (default ~/.local/bin)
#   PORTAL_REPO            what to clone                 (default the GitHub repo)
#   PORTAL_NO_MODIFY_PATH  1 = leave shell rc files alone
#   PORTAL_NO_SETUP        1 = don't offer to run `portal setup`

set -euo pipefail

REPO="${PORTAL_REPO:-https://github.com/thekoalaperson/portal.git}"
DIR="${PORTAL_DIR:-$HOME/.portal}"
BIN="${PORTAL_BIN:-$HOME/.local/bin}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m' D=$'\033[2m' G=$'\033[32m' R=$'\033[31m' Y=$'\033[33m' X=$'\033[0m'
else
  B='' D='' G='' R='' Y='' X=''
fi
say()  { printf '  %s\n' "$*"; }
tilde() { printf '%s' "${1/#$HOME/~}"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$*"; }
die()  { printf '  %s✗%s %s\n' "$R" "$X" "$*" >&2; exit 1; }

# Questions go to the terminal even when this script arrives on stdin. With no
# terminal at all (CI, an agent's shell), every question takes its default.
can_ask() { [ -z "${PORTAL_YES:-}" ] && { true </dev/tty; } 2>/dev/null; }
ask() {   # ask "question" default(y|n) -> 0 for yes
  local answer def="$2"
  if ! can_ask; then [ "$def" = y ]; return; fi
  printf '  %s %s ' "$1" "$D$([ "$def" = y ] && echo '[Y/n]' || echo '[y/N]')$X" >/dev/tty
  read -r answer </dev/tty || answer=''
  answer="${answer:-$def}"
  case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

printf '\n  %sportal%s %s· installing%s\n\n' "$B" "$X" "$D" "$X"

# ------------------------------------------------------------ 1. needs

command -v git >/dev/null 2>&1 || die "git is needed first.  macOS: xcode-select --install   Linux: your package manager"

# node:sqlite runs without a flag from Node 22.13 (and 23.4).
node_ok() {
  command -v node >/dev/null 2>&1 && node -e '
    const [a, b] = process.versions.node.split(".").map(Number)
    process.exit(a > 23 || (a === 23 && b >= 4) || (a === 22 && b >= 13) ? 0 : 1)' 2>/dev/null
}
if ! node_ok; then
  have="$(command -v node >/dev/null 2>&1 && node --version || echo 'not installed')"
  if command -v brew >/dev/null 2>&1 && ask "portal needs Node 22.13 or newer (you have: $have). Install it with Homebrew now?" y; then
    brew install node || die "brew install node failed"
    node_ok || die "Node is still older than 22.13 after installing; check which node is first on your PATH: $(command -v node)"
  else
    die "portal needs Node 22.13 or newer (you have: $have).  macOS: brew install node   others: https://nodejs.org"
  fi
fi
ok "node $(node --version) · git $(git --version | awk '{print $3}')"

# ---------------------------------------------------- 2. clone or update

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only --quiet || die "could not update $DIR (local changes there?). Fix it, or move it away and run this again"
  ok "updated $(tilde "$DIR") to $(git -C "$DIR" log -1 --format=%h)"
elif [ -e "$DIR" ]; then
  die "$DIR exists but isn't a portal checkout. Move it away, or set PORTAL_DIR to another place"
else
  if ! git clone --quiet "$REPO" "$DIR" 2>/dev/null; then
    die "could not clone $REPO. If the repository is private, sign in to GitHub first: gh auth login"
  fi
  ok "installed into $(tilde "$DIR")"
fi

# ------------------------------------------------------------ 3. link

mkdir -p "$BIN"
link="$BIN/portal"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  die "$link exists and isn't a link portal made. Move it away and run this again"
fi
if [ -L "$link" ] && [ "$(readlink "$link")" != "$DIR/bin/portal" ]; then
  warn "replacing $link (was → $(readlink "$link"))"
fi
ln -sf "$DIR/bin/portal" "$link"
ok "linked $(tilde "$link") → $(tilde "$DIR/bin/portal")"

# ------------------------------------------------------------ 4. PATH

case ":$PATH:" in
  *":$BIN:"*) on_path=1 ;;
  *) on_path=0 ;;
esac
if [ "$on_path" = 0 ]; then
  # Written as $HOME when it can be, so the line still works if the rc file is
  # carried to another machine.
  shown="$BIN"
  [ "${BIN#"$HOME"/}" != "$BIN" ] && shown="\$HOME/${BIN#"$HOME"/}"
  case "$(basename "${SHELL:-sh}")" in
    zsh)  rc="$HOME/.zshrc";  line="export PATH=\"$shown:\$PATH\"" ;;
    bash) if [ "$(uname)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
          line="export PATH=\"$shown:\$PATH\"" ;;
    fish) rc="$HOME/.config/fish/conf.d/portal.fish"; line="fish_add_path -g $shown" ;;
    *)    rc="$HOME/.profile"; line="export PATH=\"$shown:\$PATH\"" ;;
  esac
  if [ -n "${PORTAL_NO_MODIFY_PATH:-}" ]; then
    warn "$BIN isn't on your PATH. Add this to $rc: $line"
  elif grep -qs '# added by the portal installer' "$rc"; then
    ok "PATH line already in $(tilde "$rc")"
  else
    mkdir -p "$(dirname "$rc")"
    printf '\n# added by the portal installer\n%s\n' "$line" >>"$rc"
    ok "added $(tilde "$BIN") to your PATH in $(tilde "$rc")"
  fi
  export PATH="$BIN:$PATH"
  fresh_shell=1
fi

version="$("$link" --version 2>/dev/null)" || die "installed, but $link doesn't run. Try: node $DIR/bin/portal --version"
ok "$version"

# --------------------------------------------------- what else helps

missing=()
command -v claude >/dev/null 2>&1 || missing+=("claude: curl -fsSL https://claude.ai/install.sh | bash")
command -v codex  >/dev/null 2>&1 || missing+=("codex: brew install codex   (or: npm install -g @openai/codex)")
if [ "$(uname)" = Darwin ] && [ ! -d "/Applications/Google Chrome.app" ]; then
  missing+=("Google Chrome: https://www.google.com/chrome   (to open each account in its own profile)")
fi
if [ ${#missing[@]} -gt 0 ]; then
  say ""
  say "${D}worth installing for everything portal does:${X}"
  for m in "${missing[@]}"; do say "  ${D}·${X} $m"; done
fi

# ----------------------------------------------------------- 5. setup

say ""
if [ -z "${PORTAL_NO_SETUP:-}" ] && can_ask && ask "Set up your accounts now (portal setup)?" y; then
  say ""
  "$link" setup </dev/tty || true
else
  say "next: ${B}portal setup${X}   ${D}— finds your accounts and signs in the ones that need it${X}"
fi
if [ "${fresh_shell:-0}" = 1 ]; then
  say "${D}open a new terminal (or run: exec \$SHELL -l) so \`portal\` is found everywhere${X}"
fi
say ""
