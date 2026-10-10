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
[[ -f "$source_dir/package-lock.json" && -f "$source_dir/ecosystem.config.cjs" && -f "$source_dir/scripts/check-deploy.mjs" ]] || die 'Incomplete release source'
[[ -f "$script_dir/check-deploy.mjs" ]] || die 'Missing trusted health checker'
for command in node npm pm2 flock git timeout; do command -v "$command" >/dev/null || die "Missing $command in non-interactive PATH"; done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || die 'Node.js 22 or later is required'
node --input-type=module - "$base_url" <<'NODE'
const u = new URL(process.argv[2]);
if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) {
  throw new Error('The host-side health URL must be an explicit loopback HTTP application URL');
}
NODE

# OS lock is also needed for manual deploys and survives a disconnected client.
exec 9>"$root/.deploy.lock"
flock -w 300 9 || die 'Another deployment holds the host lock'
previous=$(readlink -f -- "$root/current")
[[ "$previous" == "$root/releases/"* && -d "$previous" && -f "$previous/ecosystem.config.cjs" ]] || die 'Current release must be inside this deployment root'
release="$root/releases/$release_id"
[[ ! -e "$release" ]] || die 'Release already exists; use a new run attempt'

# Refuse to change a similarly named process belonging to a different checkout.
# Do not print PM2's environment: it can contain unrelated private values.
pm_id=$(timeout --signal=TERM --kill-after=5s 30s pm2 jlist | timeout --signal=TERM --kill-after=5s 30s node -e '
  const fs = require("node:fs");
  const list = JSON.parse(fs.readFileSync(0, "utf8"));
  const matches = list.filter(p => p.name === "shutter-count");
  if (matches.length !== 1) throw new Error("Expected exactly one existing shutter-count process");
  const p = matches[0].pm2_env;
  if (p.status !== "online" || fs.realpathSync(p.pm_cwd) !== process.argv[1]) throw new Error("PM2 process does not match current release");
  if (p.pm_cwd !== process.argv[4] + "/current" || p.pm_exec_path !== process.argv[4] + "/current/bin/start.mjs") throw new Error("PM2 must already use the stable current cwd and entrypoint; migrate explicitly before automation");
  if (p.exec_interpreter !== process.execPath) throw new Error("PM2 interpreter differs from the fixed deployment runtime");
  if (!(Number(String(p.node_version).split(".")[0]) >= 22)) throw new Error("The existing PM2 process must already run Node 22 or later");
  if (!Number.isInteger(matches[0].pm_id) || matches[0].pm_id < 0) throw new Error("Invalid PM2 process ID");
  const config = require(process.argv[2]).apps;
  if (config.length !== 1 || config[0].name !== "shutter-count" || config[0].script !== "bin/start.mjs") throw new Error("Unexpected PM2 application config");
  for (const [key, value] of Object.entries(config[0].env)) {
    if (String(p[key] ?? p.env?.[key]) !== String(value)) throw new Error(`Live PM2 ${key} differs from repository config; reconcile explicitly before deploying`);
  }
  const base = new URL(process.argv[3]);
  const expectedPath = String(config[0].env.BASE_PATH).replace(/\/+$/, "");
  if (Number(base.port || 80) !== Number(config[0].env.PORT) || base.pathname.replace(/\/+$/, "") !== expectedPath) throw new Error("Health URL does not match the PM2 application config");
  console.log(matches[0].pm_id);
' "$previous" "$source_dir/ecosystem.config.cjs" "$base_url" "$root")

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
  timeout --signal=TERM --kill-after=10s 300s npm ci --omit=dev --no-audit --no-fund
  timeout --signal=TERM --kill-after=10s 300s npm test
)
# Recheck after dependency installation/tests, immediately before activation.
# The receiver also checks before fetching. Never activate an obsolete main.
# Bounded HTTP timeouts + retries: Hangzhou→GitHub spikes should not hang forever.
latest=
for attempt in 1 2 3; do
  if latest=$(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 \
      GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=60 \
      timeout --signal=TERM --kill-after=5s 90s \
      git -c http.connectTimeout=30 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
      -c credential.helper= -c core.hooksPath=/dev/null \
      -c protocol.allow=never -c protocol.https.allow=always \
      -c http.followRedirects=false \
      ls-remote --exit-code https://github.com/rendeyuwei/shutter-count.git refs/heads/main); then
    break
  fi
  latest=
  (( attempt < 3 )) && sleep $(( attempt * 2 ))
done
[[ "$latest" == "$revision"$'\trefs/heads/main' ]] || die 'main advanced or could not be verified; release not activated'
switched=1
switch_to "$release"
reload
node "$script_dir/check-deploy.mjs" "$base_url" "$revision"
node "$script_dir/check-deploy.mjs" "$public_url" "$revision"
switched=0
printf 'Deployed shutter-count revision %s. Previous release retained: %s\n' "$revision" "$previous"
# No nginx edits, PM2-wide save/restart/delete, credential changes or pruning.
