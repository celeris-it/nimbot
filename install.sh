#!/usr/bin/env bash
# Supports Bash 3.2 (macOS) and newer. Prompts use the terminal, not piped stdin.
set +x
set -euo pipefail
umask 077

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() { printf 'Usage: bash install.sh [--directory PATH] [--version vX.Y.Z]\n'; }
install_dir="$HOME/.local/share/nimbot"
version=''
version_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --directory) [ "$#" -ge 2 ] || fail '--directory requires a path'; install_dir="$2"; shift 2 ;;
    --version) [ "$#" -ge 2 ] && [[ "$2" =~ $version_pattern ]] || fail 'A release tag such as v1.0.0 is required.'; version="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done
case "$(uname -s)" in Linux|Darwin) ;; *) fail 'Only Linux and macOS are supported.' ;; esac
for tool in curl tar docker mktemp stty; do command -v "$tool" >/dev/null || fail "Required command not found: $tool"; done
exec 3<> /dev/tty || fail 'An interactive terminal is required.'
tty_settings=$(stty -g <&3)
ask() { printf '%s' "$1" >&3; IFS= read -r answer <&3 || fail 'Input cancelled.'; }
valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }

# Only local Unix sockets work with the server's bind mount.
if [ -n "${DOCKER_CONTEXT:-}" ]; then
  endpoint=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
elif [ -n "${DOCKER_HOST:-}" ]; then
  endpoint="$DOCKER_HOST"
else
  endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
fi
case "$endpoint" in unix:///*) socket="${endpoint#unix://}" ;; *) fail 'Select a local Docker context with a Unix socket; remote Docker is unsupported.' ;; esac
[ -S "$socket" ] || fail "Docker socket not found: $socket. Start Docker first."
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST="$endpoint"
docker info >/dev/null || fail 'Cannot access Docker. Start Docker and check your user permissions.'
docker compose version >/dev/null || fail 'The Docker Compose plugin is required.'
api=$(docker version --format '{{.Server.APIVersion}}')
[[ "$api" =~ ^1\.[0-9]+$ ]] && [ "${api#1.}" -ge 47 ] || fail 'Docker Engine API 1.47 or newer is required.'
# Compose volume short syntax cannot represent these socket-path characters safely.
case "$socket" in *[\$\'\"\:\\]*|*$'\n'*) fail 'Unsupported characters in Docker socket path.' ;; esac
mkdir -p "$install_dir"
install_dir=$(cd "$install_dir" && pwd -P)
marker="$install_dir/.nimbot-installation"
work_dir=''
lock="$install_dir/.nimbot-maintenance"
ln -s "$$" "$lock" 2>/dev/null || fail 'Installation maintenance is already in progress.'
cleanup() { rm -f -- "$lock"; stty "$tty_settings" <&3 || true; [ -z "$work_dir" ] || rm -rf -- "$work_dir"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'printf "Installation failed. Configuration and Docker resources were kept. Fix the error and run the installer again with --directory %q.\n" "$install_dir" >&2' ERR

[ ! -f "$install_dir/.nimbot-upgrade.json" ] || fail 'An upgrade is pending. Run upgrade.sh --rollback.'

source_dir="$install_dir"
server_image=nimbot-server
host_image=nimbot-agent-host:latest
if [ -f "$marker" ]; then
  installation_id=$(sed -n '1p' "$marker")
  saved_socket=$(sed -n '2p' "$marker")
  [[ "$installation_id" =~ ^[a-f0-9]{32}$ ]] || fail 'Invalid installation marker.'
  [ "$socket" = "$saved_socket" ] || fail 'Select the Docker socket used by this installation.'
  [ -f "$install_dir/compose.yaml" ] && [ -f "$install_dir/uninstall.sh" ] || fail 'Incomplete source directory; restore the downloaded source before retrying.'
  saved_version=''
  if [ -f "$install_dir/.nimbot-release" ]; then
    saved_version=$(cat "$install_dir/.nimbot-release")
  elif [ -f "$install_dir/.nimbot-install-source" ]; then
    saved_version=$(cat "$install_dir/.nimbot-install-source")
  fi
  [ -z "$version" ] || [ "$version" = "$saved_version" ] || fail 'Use upgrade.sh to change the installed version.'
  if [[ "$saved_version" =~ $version_pattern ]] && [ -d "$install_dir/.nimbot-releases/$saved_version" ]; then
    source_dir="$install_dir/.nimbot-releases/$saved_version"
    server_image="nimbot-server-$installation_id:$saved_version"
    host_image="nimbot-agent-host-$installation_id:$saved_version"
  fi
  printf 'Reusing existing installation and configuration; no update will be downloaded.\n'
else
  [ "$(ls -A "$install_dir")" = ".nimbot-maintenance" ] || fail 'Destination is not empty or is not a managed installation. Choose another directory.'
  [ -z "$(docker ps -aq --filter name='^/nimbot-server$')" ] || fail 'A nimbot-server container already exists. Only one installation per Docker Engine is supported.'
  for kind in container network volume; do
    list_args=(-q)
    if [ "$kind" = container ]; then list_args=(-aq); fi
    [ -z "$(docker "$kind" ls "${list_args[@]}" --filter label=io.nimbot.installation)" ] || fail 'Another Nimbot installation has resources on this Docker Engine.'
    [ -z "$(docker "$kind" ls "${list_args[@]}" --filter label=io.nimbot.agent-id)" ] || fail 'Existing Nimbot agent resources found. Back up and remove the previous installation first.'
  done
  work_dir=$(mktemp -d)
  printf 'Downloading Nimbot source...\n'
  ref=refs/heads/main
  if [ -n "$version" ]; then ref="refs/tags/$version"; fi
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    "https://codeload.github.com/celeris-it/nimbot/tar.gz/$ref" -o "$work_dir/source.tar.gz"
  mkdir "$work_dir/source"
  tar -xzf "$work_dir/source.tar.gz" --strip-components=1 -C "$work_dir/source"
  [ -f "$work_dir/source/compose.yaml" ] && [ -f "$work_dir/source/uninstall.sh" ] || fail 'Downloaded source does not contain the installer release.'
  if [ -n "$version" ]; then
    [ -f "$work_dir/source/release.json" ] || fail 'This release predates versioned installation.'
  fi
  cp -R "$work_dir/source/." "$install_dir/"
  printf '%s\n' "${version:-development}" > "$install_dir/.nimbot-install-source"
  # /dev/urandom and od are available on both supported platforms.
  installation_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s\n%s\n' "$installation_id" "$socket" > "$marker"
fi
project="nimbot-$installation_id"
cd "$install_dir"

# Refuse an occupied server name before builds or configuration changes.
server=$(docker ps -aq --filter name='^/nimbot-server$')
if [ -n "$server" ]; then
  owner=$(docker inspect --format '{{index .Config.Labels "io.nimbot.installation"}}' "$server")
  [ "$owner" = "$installation_id" ] || fail 'The nimbot-server container belongs to another installation.'
fi
if [ "$source_dir" = "$install_dir" ] || [ -z "$server" ]; then
  printf 'Building the server and Agent Host images (this can take several minutes)...\n'
  docker build -f "$source_dir/infrastructure/docker/server.Dockerfile" -t "$server_image" "$source_dir"
  docker build -f "$source_dir/infrastructure/docker/agent-host.Dockerfile" -t "$host_image" "$source_dir"
fi

custom_port_supported=false
if grep -Fq '${PANEL_PUBLISH_PORT:-3000}' "$source_dir/compose.yaml"; then
  custom_port_supported=true
fi
if [ ! -f .env ]; then
  socket_gid=$(docker run --rm --network none --read-only --cap-drop ALL \
    -v "$socket:/var/run/docker.sock:ro" "$server_image" stat -c '%g' /var/run/docker.sock)
  [[ "$socket_gid" =~ ^[0-9]+$ ]] || fail 'Cannot determine the Docker socket group inside Docker.'
  panel_port=3000
  if [ "$custom_port_supported" = true ]; then
    while :; do
      ask 'Panel host port [default: 3000]: '
      if [ -z "$answer" ]; then break; fi
      if valid_port "$answer"; then panel_port=$((10#$answer)); break; fi
      printf 'Enter a port between 1 and 65535.\n' >&3
    done
  else
    printf 'This release publishes the panel on host port 3000.\n'
  fi
  local_panel_url="http://localhost:$panel_port"
  while :; do
    ask "Panel URL [default: $local_panel_url, or enter an HTTPS origin]: "
    panel_url="${answer:-$local_panel_url}"
    if [ "$panel_url" = "$local_panel_url" ]; then break; fi
    if [[ "$panel_url" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:([0-9]{1,5}))?$ ]]; then
      https_port="${BASH_REMATCH[2]:-}"
      if [ -z "$https_port" ] || valid_port "$https_port"; then break; fi
    fi
    printf 'Enter %s or an HTTPS origin with a valid port and no path, query, or credentials.\n' "$local_panel_url" >&3
  done
  while :; do
    stty -echo <&3
    printf 'Panel password (8–256 characters, hidden): ' >&3
    IFS= read -r -s password <&3 || fail 'Input cancelled.'; printf '\n' >&3
    printf 'Repeat password: ' >&3
    IFS= read -r -s confirmation <&3 || fail 'Input cancelled.'; printf '\n' >&3
    stty "$tty_settings" <&3
    if [ "$password" != "$confirmation" ]; then printf 'Passwords do not match. Try again.\n' >&3; continue; fi
    # Only stdin carries the password; it is never an argument or a file.
    if password_hash=$(printf '%s' "$password" | docker run --rm -i "$server_image" node apps/server/dist/password.js --stdin); then break; fi
    printf 'Password was rejected. Try again.\n' >&3
  done
  unset password confirmation
  [[ "$password_hash" =~ ^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$ ]] || fail 'Password helper returned an invalid hash.'
  env_file=$(mktemp "$install_dir/.env.XXXXXX")
  printf "PANEL_PASSWORD_HASH='%s'\nPANEL_URL='%s'\nPANEL_PUBLISH_PORT=%s\nDOCKER_SOCKET_PATH='%s'\nDOCKER_SOCKET_GID=%s\nAGENT_HOST_IMAGE=%s\nSERVER_CONTAINER_NAME=nimbot-server\nTASK_TIMEOUT_SECONDS=600\nNIMBOT_INSTALLATION_ID=%s\n" \
    "$password_hash" "$panel_url" "$panel_port" "$socket" "$socket_gid" "$host_image" "$installation_id" > "$env_file"
  chmod 600 "$env_file"
  mv "$env_file" .env
  unset password_hash
else
  grep -qx "NIMBOT_INSTALLATION_ID=$installation_id" .env || fail 'Configuration does not match the installation marker.'
  panel_url=$(sed -n "s/^PANEL_URL='\([^']*\)'$/\1/p" .env)
  [ -n "$panel_url" ] || fail 'Cannot read PANEL_URL from the saved configuration.'
  panel_port=$(sed -n 's/^PANEL_PUBLISH_PORT=//p' .env)
  panel_port="${panel_port:-3000}"
  valid_port "$panel_port" || fail 'Set PANEL_PUBLISH_PORT to a port between 1 and 65535 in the saved configuration.'
  panel_port=$((10#$panel_port))
  if [ "$custom_port_supported" = false ] && [ "$panel_port" != 3000 ]; then
    fail 'This release only supports PANEL_PUBLISH_PORT=3000.'
  fi
  chmod 600 .env
fi
if [[ "$panel_url" == https://* ]]; then
  printf 'Configure your existing HTTPS proxy to forward to 127.0.0.1:%s.\n' "$panel_port"
fi
# Prevent inherited deployment variables from overriding this installation's .env.
unset NIMBOT_SERVER_IMAGE NIMBOT_UPGRADE_TOKEN PANEL_PASSWORD_HASH PANEL_URL PANEL_PUBLISH_PORT DOCKER_SOCKET_PATH DOCKER_SOCKET_GID AGENT_HOST_IMAGE SERVER_CONTAINER_NAME TASK_TIMEOUT_SECONDS NIMBOT_INSTALLATION_ID COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
launch=(up -d)
if [ "$source_dir" != "$install_dir" ]; then
  export NIMBOT_SERVER_IMAGE="$server_image" AGENT_HOST_IMAGE="$host_image"
  # Keep the Server container's connections to private Agent Host networks.
  if [ -n "$server" ]; then launch=(start); fi
fi
compose() { docker compose --project-name "$project" --env-file "$install_dir/.env" -f "$source_dir/compose.yaml" "$@"; }
compose config --quiet
if ! compose "${launch[@]}" --wait --wait-timeout 120; then
  compose ps >&2 || true
  printf 'Inspect logs with: docker --host %q logs --tail 100 nimbot-server\n' "$endpoint" >&2
  fail 'Server did not become healthy within 120 seconds. Configuration and resources were kept; rerun this installer to retry.'
fi
if [ ! -f .nimbot-release ] && [ -f .nimbot-install-source ]; then
  cp .nimbot-install-source .nimbot-release.tmp
  mv .nimbot-release.tmp .nimbot-release
fi
printf '\nNimbot is ready at %s\nInstallation: %s\n' "$panel_url" "$install_dir"
if [ "$panel_url" = "http://localhost:$panel_port" ]; then
  printf 'For a remote server: ssh -L %s:127.0.0.1:%s YOUR_USER@YOUR_SERVER\nThen open %s on your computer.\n' "$panel_port" "$panel_port" "$panel_url"
fi
printf 'Logs: docker --host %q logs -f nimbot-server\n' "$endpoint"
printf 'Uninstall (keeps data): bash %q --directory %q\n' "$install_dir/uninstall.sh" "$install_dir"
printf 'Next: sign in, create an agent with a BotFather token and your Telegram user ID, then authenticate its AI provider.\nSee %s/docs/INSTALL.md for these steps.\n' "$source_dir"
