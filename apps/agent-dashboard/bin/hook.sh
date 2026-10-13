#!/bin/sh
# bin/hook.sh - POSIX wrapper that runs hook-logger.js with whatever Node.js is installed.
#
# Why: the Claude Code hook command used a fixed nvm path (.../vX.Y.Z/bin/node). After an nvm update that path is gone
# and the hooks stop SILENTLY. This wrapper finds node at run time instead.
#
# Node lookup, first hit wins:
#   1. `command -v node`                       (PATH of the hook process; relative entries such as "." are dropped,
#                                               an unset/empty PATH becomes a safe default; only an ABSOLUTE result is accepted)
#   2. the nvm default alias                   ($NVM_DIR/alias/default, e.g. "v22.22.2" or "22" -> newest matching install)
#   3. the newest nvm install                  ($NVM_DIR/versions/node/v*; used when the alias is a name such as "lts/*")
#   4. common fixed paths                      (Homebrew, /usr/local, /usr/bin, Volta; env DASHBOARD_NODE_FALLBACKS overrides the list;
#                                               relative entries are ignored)
#
# Contract (same as hook-logger.js):
#   - stdin (the hook payload) is passed through to node unchanged
#   - writes NOTHING to stdout or stderr (node's own output is discarded)
#   - ALWAYS exits 0, whatever happens (node missing, node crashed, hook-logger.js missing)
#   - if no node is found, one line is appended to data/hook-wrapper.log (override: DASHBOARD_WRAPPER_LOG) so the failure
#     is not completely invisible; that write is best effort too
#
# Usage in .claude/settings.local.json:  /bin/sh /ABSOLUTE/PATH/TO/apps/agent-dashboard/bin/hook.sh
# Only shell builtins are used where possible, so it also works with a minimal PATH.

# App folder = parent of bin/ (this script's folder). `cd` and `pwd` are builtins.
case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
app_dir=$(cd "$script_dir/.." 2>/dev/null && pwd)
logger="$app_dir/hook-logger.js"

NODE_BIN=""

# Pick the newest executable nvm install whose folder name matches the glob pattern $1 (e.g. "v22.*", "v*").
# "Newest" = highest major.minor.patch, compared with shell arithmetic. Sets NODE_BIN.
nvm_newest() {
  best_key=-1
  for cand in "$nvm_root"/versions/node/$1/bin/node; do
    [ -x "$cand" ] || continue
    ver=${cand#"$nvm_root"/versions/node/}   # vX.Y.Z/bin/node
    ver=${ver%%/*}                          # v22.22.2
    ver=${ver#v}                            # 22.22.2
    major=${ver%%.*}
    rest=${ver#*.}
    minor=${rest%%.*}
    patch=${rest#*.}
    patch=${patch%%[!0-9]*}                 # drop a "-rc.1" style suffix
    case "$major$minor$patch" in
      ''|*[!0-9]*) continue ;;              # not a plain number: skip this install
    esac
    key=$(( major * 1000000 + minor * 1000 + patch ))
    if [ "$key" -gt "$best_key" ]; then
      best_key=$key
      NODE_BIN=$cand
    fi
  done
}

# Safety: when PATH is unset or empty, bash 3.2 started as /bin/sh silently uses a built-in default PATH that CONTAINS "." (it
# is set but not exported, so it cannot be told apart from a real one), and `command -v node` could then resolve ./node in the
# current folder. So PATH is always rebuilt from its ABSOLUTE entries only: "." , empty and other relative entries are dropped.
# If nothing is left (empty PATH), a fixed default is used. The cleaned PATH is exported, so node and its children get it too.
safe_path=""
old_ifs=$IFS
IFS=:
set -f                                      # no glob expansion of PATH entries
for dir in ${PATH:-}; do
  case "$dir" in
    /*) safe_path=${safe_path:+$safe_path:}$dir ;;
  esac
done
set +f
IFS=$old_ifs
PATH=${safe_path:-/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin}
export PATH

# 1. node on PATH. Accepted only when the resolved path is ABSOLUTE (starts with "/"): a relative result comes from a "."
# or empty PATH entry and would run a file out of the current folder.
found=$(command -v node 2>/dev/null)
case "$found" in
  /*) [ -x "$found" ] && NODE_BIN=$found ;;
esac

# 2 and 3. nvm
if [ -z "$NODE_BIN" ]; then
  nvm_root=${NVM_DIR:-${HOME:-}/.nvm}
  if [ -d "$nvm_root/versions/node" ]; then
    alias_value=""
    if [ -r "$nvm_root/alias/default" ]; then
      read -r alias_value < "$nvm_root/alias/default" 2>/dev/null
    fi
    alias_value=${alias_value#v}
    case "$alias_value" in
      ''|*[!0-9.]*) ;;                      # empty, or a name such as "lts/*" or "node": use the newest install below
      *)
        nvm_newest "v$alias_value"          # exact: "22.22.2"
        [ -z "$NODE_BIN" ] && nvm_newest "v$alias_value.*"   # prefix: "22" or "22.22"
        ;;
    esac
    [ -z "$NODE_BIN" ] && nvm_newest "v*"
  fi
fi

# 4. common fixed paths (colon-separated list; DASHBOARD_NODE_FALLBACKS replaces it, used by the tests)
if [ -z "$NODE_BIN" ]; then
  fallbacks=${DASHBOARD_NODE_FALLBACKS:-/opt/homebrew/bin/node:/usr/local/bin/node:/usr/bin/node:${HOME:-}/.volta/bin/node}
  old_ifs=$IFS
  IFS=:
  set -f                                    # no glob expansion of the list items
  for cand in $fallbacks; do
    # absolute entries only; a relative entry (or an empty one) is ignored
    case "$cand" in
      /*) ;;
      *) continue ;;
    esac
    if [ -x "$cand" ]; then
      NODE_BIN=$cand
      break
    fi
  done
  set +f
  IFS=$old_ifs
fi

if [ -z "$NODE_BIN" ]; then
  # No node anywhere: leave a trace (best effort), still exit 0 and stay silent
  log_file=${DASHBOARD_WRAPPER_LOG:-$app_dir/data/hook-wrapper.log}
  {
    mkdir -p "${log_file%/*}" 2>/dev/null
    printf '%s node not found; hook skipped\n' "$(date '+%Y-%m-%dT%H:%M:%S' 2>/dev/null)" >> "$log_file"
  } >/dev/null 2>&1
  exit 0
fi

# Run the logger. stdin is inherited; stdout and stderr are discarded; the exit status is ignored.
"$NODE_BIN" "$logger" >/dev/null 2>&1
exit 0
