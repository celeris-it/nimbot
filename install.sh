#!/usr/bin/env bash
# Supports Bash 3.2 (macOS) and newer. Installation does not require a terminal.
set +x
set -euo pipefail
umask 077
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() { printf 'Usage: bash install.sh [--directory PATH] [--version vX.Y.Z] [--port PORT] [--url ORIGIN]\n'; }
install_dir="$HOME/.local/share/nimbot"
version='development'
port_option=''
url_option=''
panel_port=3000
configured_hash=${PANEL_PASSWORD_HASH:-}
configured_password=${PANEL_PASSWORD:-}
unset PANEL_PASSWORD PANEL_PASSWORD_HASH
version_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --directory) [ "$#" -ge 2 ] || fail '--directory requires a path'; install_dir="$2"; shift 2 ;;
    --version) [ "$#" -ge 2 ] && [[ "$2" =~ $version_pattern ]] || fail 'A release tag such as v1.0.0 is required.'; version="$2"; shift 2 ;;
    --port) [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--port requires a port'; port_option="$2"; shift 2 ;;
    --url) [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--url requires an origin'; url_option="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done
case "$(uname -s)" in Linux|Darwin) ;; *) fail 'Only Linux and macOS are supported.' ;; esac
for tool in curl tar docker mktemp; do command -v "$tool" >/dev/null || fail "Required command not found: $tool"; done
valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
valid_url() {
  [ "$1" = "http://localhost:$panel_port" ] && return 0
  if [[ "$1" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:([0-9]{1,5}))?$ ]]; then
    [ -z "${BASH_REMATCH[2]:-}" ] || valid_port "${BASH_REMATCH[2]}"
  else return 1; fi
}
if [ -n "$port_option" ]; then
  valid_port "$port_option" || fail 'Enter a port between 1 and 65535 using --port.'
  panel_port=$((10#$port_option))
fi
panel_url="${url_option:-http://localhost:$panel_port}"
valid_url "$panel_url" || fail 'Use --url with an HTTPS origin without a path, query or credentials, or the default localhost URL.'
if [ -n "$configured_hash" ]; then
  [[ "$configured_hash" =~ ^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$ ]] || fail 'PANEL_PASSWORD_HASH is invalid.'
elif [ -n "$configured_password" ]; then
  [ "${#configured_password}" -ge 8 ] && [ "${#configured_password}" -le 256 ] || fail 'PANEL_PASSWORD must be between 8 and 256 characters long.'
fi
if [ -n "${DOCKER_CONTEXT:-}" ]; then
  endpoint=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
elif [ -n "${DOCKER_HOST:-}" ]; then endpoint="$DOCKER_HOST"
else endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}'); fi
case "$endpoint" in unix:///*) ;; *) fail 'Select a local Docker context with a Unix socket; remote Docker is unsupported by this installer.' ;; esac
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST="$endpoint"
docker info >/dev/null || fail 'Cannot access Docker. Start Docker and check your user permissions.'
mkdir -p "$install_dir"
install_dir=$(cd "$install_dir" && pwd -P)
marker="$install_dir/.nimbot-installation"
work_dir=''
lock="$install_dir/.nimbot-maintenance"
ln -s "$$" "$lock" 2>/dev/null || fail 'Installation maintenance is already in progress.'
cleanup() { rm -f -- "$lock"; [ -z "$work_dir" ] || rm -rf -- "$work_dir"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'printf "Installation failed. Configuration and Docker resources were kept. Retry with the same --directory.\n" >&2' ERR
if [ -f "$marker" ]; then
  [ "$(sed -n '1p' "$marker")" = 'subprocess-v1' ] || fail 'A fresh subprocess installation is required. Choose a new directory; existing data was retained.'
  installation_id=$(sed -n '2p' "$marker")
  saved_endpoint=$(sed -n '3p' "$marker")
  saved_version=$(sed -n '4p' "$marker")
  [[ "$installation_id" =~ ^[a-f0-9]{32}$ ]] || fail 'Invalid installation marker.'
  [ "$endpoint" = "$saved_endpoint" ] || fail 'Select the Docker Engine used by this installation.'
  [ "$version" = development ] || [ "$version" = "$saved_version" ] || fail 'Use the documented manual update procedure to change revisions.'
  [ -f "$install_dir/infrastructure/docker/nimbot.Dockerfile" ] || fail 'Restore this installation source before retrying.'
  printf 'Reusing existing installation and configuration; no update will be downloaded.\n'
else
  [ "$(ls -A "$install_dir")" = '.nimbot-maintenance' ] || fail 'Destination is not empty. Choose a new directory for this fresh installation.'
  work_dir=$(mktemp -d)
  ref=refs/heads/main
  if [ "$version" != development ]; then ref="refs/tags/$version"; fi
  printf 'Downloading Nimbot source...\n'
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    "https://codeload.github.com/celeris-it/nimbot/tar.gz/$ref" -o "$work_dir/source.tar.gz"
  mkdir "$work_dir/source"
  tar -xzf "$work_dir/source.tar.gz" --strip-components=1 -C "$work_dir/source"
  [ -f "$work_dir/source/infrastructure/docker/nimbot.Dockerfile" ] && [ -f "$work_dir/source/uninstall.sh" ] || fail 'This revision does not support the single-container installation.'
  cp -R "$work_dir/source/." "$install_dir/"
  installation_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf 'subprocess-v1\n%s\n%s\n%s\n' "$installation_id" "$endpoint" "$version" > "$marker"
fi
container="nimbot-$installation_id"
volume="$container-data"
image="$container:local"
# Listing failures abort. Only exact names and both ownership labels are accepted.
lookup() {
  local kind="$1" name="$2" names candidate
  if [ "$kind" = container ]; then names=$(docker container ls -a --format '{{.Names}}') || fail 'Cannot list containers.'
  else names=$(docker volume ls --format '{{.Name}}') || fail 'Cannot list volumes.'; fi
  while IFS= read -r candidate; do
    if [ "$candidate" = "$name" ]; then printf '%s' "$name"; return; fi
  done <<< "$names"
}
owned() {
  local kind="$1" name="$2" label layout
  if [ "$kind" = container ]; then
    label=$(docker container inspect --format '{{index .Config.Labels "io.nimbot.installation"}}' "$name") || fail 'Cannot inspect resource ownership.'
    layout=$(docker container inspect --format '{{index .Config.Labels "io.nimbot.layout"}}' "$name") || fail 'Cannot inspect resource ownership.'
  else
    label=$(docker volume inspect --format '{{index .Labels "io.nimbot.installation"}}' "$name") || fail 'Cannot inspect resource ownership.'
    layout=$(docker volume inspect --format '{{index .Labels "io.nimbot.layout"}}' "$name") || fail 'Cannot inspect resource ownership.'
  fi
  [ "$label" = "$installation_id" ] && [ "$layout" = subprocess-v1 ] || fail "Refusing foreign $kind: $name"
}
saved_container=$(lookup container "$container")
saved_volume=$(lookup volume "$volume")
[ -z "$saved_container" ] || owned container "$container"
[ -z "$saved_volume" ] || owned volume "$volume"
if [ -z "$saved_volume" ] && { [ -n "$saved_container" ] || [ -f "$install_dir/.env" ]; }; then fail 'The saved data volume is missing. Restore it before starting this installation.'; fi
if [ -f "$install_dir/.env" ]; then
  saved_url=$(sed -n 's/^PANEL_URL=//p' "$install_dir/.env")
  saved_port=$(sed -n 's/^PANEL_PUBLISH_PORT=//p' "$install_dir/.env")
  valid_port "$saved_port" && [ -n "$saved_url" ] || fail 'Restore PANEL_URL and PANEL_PUBLISH_PORT in .env.'
  [ -z "$port_option" ] || [ "$panel_port" = "$saved_port" ] || fail 'To change the port, edit .env and recreate the container using the documented manual procedure.'
  [ -z "$url_option" ] || [ "$panel_url" = "$saved_url" ] || fail 'To change the URL, edit .env and recreate the container using the documented manual procedure.'
  panel_port="$saved_port"
  panel_url="$saved_url"
  valid_url "$panel_url" || fail 'Restore a valid PANEL_URL in .env.'
fi
if [ -z "$saved_container" ] && (exec 4<>"/dev/tcp/127.0.0.1/$panel_port") 2>/dev/null; then
  fail "Port $panel_port is already in use. Retry with --port PORT; for an existing installation, edit .env and recreate the container using the documented manual procedure."
fi
if [ -z "$saved_container" ]; then
  printf 'Building the application image (this can take several minutes)...\n'
  docker build -f "$install_dir/infrastructure/docker/nimbot.Dockerfile" -t "$image" "$install_dir"
fi
if [ -z "$saved_volume" ]; then
  docker volume create --label "io.nimbot.installation=$installation_id" --label io.nimbot.layout=subprocess-v1 "$volume" >/dev/null
  owned volume "$volume"
fi
if [ ! -f "$install_dir/.env" ]; then
  [ -z "$saved_container" ] || fail 'Saved configuration is missing. Restore .env before retrying.'
  password_hash="$configured_hash"
  if [ -z "$password_hash" ] && [ -n "$configured_password" ]; then
    password_hash=$(printf '%s' "$configured_password" | docker run --rm -i --entrypoint node "$image" apps/server/dist/password.js --stdin) || fail 'Could not hash PANEL_PASSWORD.'
    [[ "$password_hash" =~ ^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$ ]] || fail 'Password helper returned an invalid hash.'
  fi
  env_file=$(mktemp "$install_dir/.env.XXXXXX")
  if [ -n "$password_hash" ]; then printf 'PANEL_PASSWORD_HASH=%s\n' "$password_hash" > "$env_file"; fi
  printf 'PANEL_URL=%s\nPANEL_PUBLISH_PORT=%s\nTASK_TIMEOUT_SECONDS=600\n' "$panel_url" "$panel_port" >> "$env_file"
  chmod 600 "$env_file"
  mv "$env_file" "$install_dir/.env"
  unset password_hash
else
  panel_url=$(sed -n 's/^PANEL_URL=//p' "$install_dir/.env")
  panel_port=$(sed -n 's/^PANEL_PUBLISH_PORT=//p' "$install_dir/.env")
  [ -n "$panel_url" ] && valid_port "$panel_port" || fail 'Restore PANEL_URL and PANEL_PUBLISH_PORT in .env.'
  chmod 600 "$install_dir/.env"
fi
unset configured_password configured_hash
if [ -z "$saved_container" ]; then
  docker run -d --init --name "$container" --restart unless-stopped --stop-timeout 30 \
    --label "io.nimbot.installation=$installation_id" --label io.nimbot.layout=subprocess-v1 \
    --env-file "$install_dir/.env" --env NIMBOT_MODE=docker --env SERVER_STATE_DIR=/data --env PANEL_HOST=0.0.0.0 \
    --publish "127.0.0.1:$panel_port:3000" --mount "type=volume,source=$volume,target=/data" "$image" >/dev/null
else
  docker container start "$container" >/dev/null
fi
ready=false
for attempt in {1..60}; do
  owned container "$container"
  state=$(docker container inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
  case "$state" in
    'running healthy') ready=true; break ;;
    'running starting') sleep 2 ;;
    *) fail "Application is not healthy ($state). Inspect docker logs; configuration and data were kept." ;;
  esac
done
"$ready" || fail 'Application did not become healthy within 120 seconds. Configuration and data were kept.'
activation_url=$(docker exec "$container" node apps/server/dist/setup-link.js) || fail 'Could not read the activation link. Check application logs and retry.'
printf '\nNimbot is ready at %s\nInstallation: %s\n'  "$panel_url" "$install_dir"
printf 'Open this link to create your password or sign in:\n%s\n' "$activation_url"
if [ "$panel_url" = "http://localhost:$panel_port" ]; then
  printf 'For a remote host: ssh -L %s:127.0.0.1:%s YOUR_USER@YOUR_SERVER\n' "$panel_port" "$panel_port"
else
  printf 'Configure your existing HTTPS proxy to forward to 127.0.0.1:%s.\n' "$panel_port"
fi
printf 'Logs: docker --host %q logs -f %q\n' "$endpoint" "$container"
printf 'Uninstall (keeps data): bash %q --directory %q\n' "$install_dir/uninstall.sh" "$install_dir"
printf 'See %s/docs/INSTALL.md for agent setup and the shared installation trust model.\n' "$install_dir"
