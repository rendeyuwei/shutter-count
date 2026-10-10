#!/usr/bin/env bash
# Run as the existing application's PM2 owner, never via sudo.
# This updates an established deployment; it does not provision a server.
set -Eeuo pipefail
umask 022
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

die() { printf 'Deployment stopped: %s\n' "$*" >&2; exit 1; }
(( EUID != 0 )) || die 'Refusing to deploy as root'
[[ $# -eq 6 ]] || die 'Usage: deploy-release.sh <source-dir> <deploy-root> <commit-sha> <release-id> <local-base-url> <public-base-url>'
source_dir=$(realpath -e -- "$1")
root=$(realpath -e -- "$2")
revision=$3
release_id=$4
base_url=$5
public_url=$6
[[ "$root" != / && "$root" != "$HOME" ]] || die 'Unsafe deployment root'
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || die 'Expected a full commit SHA'
[[ "$release_id" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ && "$release_id" == "$revision"-* ]] || die 'Invalid unique release ID'
[[ -d "$root/releases" && ! -L "$root/releases" && -L "$root/current" ]] || die 'An existing releases directory and current symlink are required'
[[ -f "$source_dir/package-lock.json" && -f "$source_dir/ecosystem.config.cjs" && -f "$source_dir/scripts/check-deploy.ts" ]] || die 'Incomplete release source'
[[ -f "$script_dir/check-deploy.mjs" && -f "$script_dir/deploy-guard.mjs" ]] || die 'Missing trusted health checker'
for command in node npm pm2 flock git timeout; do command -v "$command" >/dev/null || die "Missing $command in non-interactive PATH"; done
node "$script_dir/deploy-guard.mjs" runtime || die 'Node.js 22 or later is required'
node "$script_dir/deploy-guard.mjs" url "$base_url"

# OS lock is also needed for manual deploys and survives a disconnected client.
exec 9>"$root/.deploy.lock"
flock -w 300 9 || die 'Another deployment holds the host lock'
previous=$(readlink -f -- "$root/current")
[[ "$previous" == "$root/releases/"* && -d "$previous" && -f "$previous/ecosystem.config.cjs" ]] || die 'Current release must be inside this deployment root'
release="$root/releases/$release_id"
[[ ! -e "$release" ]] || die 'Release already exists; use a new run attempt'

# Refuse to change a similarly named process belonging to a different checkout.
# Do not print PM2's environment: it can contain unrelated private values.
pm_id=$(timeout --signal=TERM --kill-after=5s 30s pm2 jlist | timeout --signal=TERM --kill-after=5s 30s node "$script_dir/deploy-guard.mjs" pm2 "$previous" "$source_dir/ecosystem.config.cjs" "$base_url" "$root")

switched=0
link="$root/.current-$release_id"
switch_to() {
  ln -s -- "$1" "$link" && mv -Tf -- "$link" "$root/current"
}
reload() {
  # Existing-process startOrReload does not reliably repoint pm_exec_path.
  # Restart the verified ID with its already stable paths and preserved env.
  timeout --signal=TERM --kill-after=5s 60s pm2 restart "$pm_id"
}
cleanup() {
  rc=$?
  trap - EXIT
  trap '' INT TERM HUP
  # Losing the SSH output pipe must not kill rollback with SIGPIPE. Keep a
  # host-side recovery log, then best-effort replay it if SSH is still alive.
  trap '' PIPE
  rm -f -- "$link" || true
  if (( rc != 0 && switched == 1 )); then
    exec 4>&2
    rollback_log="$root/rollback-$release_id.log"
    exec >>"$rollback_log" 2>&1 || exec >/dev/null 2>&1
    printf 'Deployment failed; restoring previous release.\n' >&2 || true
    rollback_revision=-
    if [[ -f "$previous/REVISION" ]]; then rollback_revision=$(cat "$previous/REVISION"); fi
    if switch_to "$previous" && reload && node "$script_dir/check-deploy.mjs" "$base_url" "$rollback_revision"; then
      printf 'Previous release restored and healthy.\n' >&2 || true
    else
      printf 'CRITICAL: rollback was not verified; inspect shutter-count immediately.\n' >&2 || true
    fi
    cat "$rollback_log" >&4 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 141' PIPE

mkdir -- "$release"
cp -a -- "$source_dir/." "$release/"
printf '%s\n' "$revision" > "$release/REVISION"
(
  cd "$release"
  timeout --signal=TERM --kill-after=10s 300s npm ci --no-audit --no-fund
  timeout --signal=TERM --kill-after=10s 300s npm run typecheck
  timeout --signal=TERM --kill-after=10s 300s npm run build
  timeout --signal=TERM --kill-after=10s 300s npm run test:built
  timeout --signal=TERM --kill-after=10s 300s npm prune --omit=dev --no-audit --no-fund
)
# Recheck after dependency installation/tests, immediately before activation.
# The receiver also checks before fetching. Never activate an obsolete main.
latest=$(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 timeout --signal=TERM --kill-after=5s 60s git ls-remote --exit-code https://github.com/rendeyuwei/shutter-count.git refs/heads/main)
[[ "$latest" == "$revision"$'\trefs/heads/main' ]] || die 'main advanced or could not be verified; release not activated'
switched=1
switch_to "$release"
reload
node "$script_dir/check-deploy.mjs" "$base_url" "$revision"
node "$script_dir/check-deploy.mjs" "$public_url" "$revision"
switched=0
printf 'Deployed shutter-count revision %s. Previous release retained: %s\n' "$revision" "$previous"
# No nginx edits, PM2-wide save/restart/delete, credential changes or pruning.
