#!/usr/bin/env bash
# Supports Bash 3.2 (macOS) and newer.
set +x
set -euo pipefail
umask 077

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  printf 'Usage: bash upgrade.sh --version vX.Y.Z [--directory PATH]\n       bash upgrade.sh --rollback [--directory PATH]\n'
}
install_dir="$HOME/.local/share/nimbot"
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  if [ -f "$script_dir/.nimbot-installation" ]; then install_dir="$script_dir"; fi
fi
version=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --directory) [ "$#" -ge 2 ] || fail '--directory requires a path'; install_dir="$2"; shift 2 ;;
    --version) [ "$#" -ge 2 ] && [ -z "$version" ] || fail 'Specify one target version'; version="$2"; shift 2 ;;
    --rollback) [ -z "$version" ] || fail 'Specify either a target version or --rollback'; version='--rollback'; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
version_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if [ "$version" != '--rollback' ] && [[ ! "$version" =~ $version_pattern ]]; then
  usage >&2; fail 'An explicit release tag such as v1.0.0 is required.'
fi
case "$(uname -s)" in Linux|Darwin) ;; *) fail 'Only Linux and macOS are supported.' ;; esac
for tool in curl tar docker mktemp; do command -v "$tool" >/dev/null || fail "Required command not found: $tool"; done
install_dir=$(cd "$install_dir" && pwd -P) || fail 'Installation directory was not found.'
case "$install_dir" in *:*|*$'\n'*) fail 'Unsupported characters in installation directory.' ;; esac
marker="$install_dir/.nimbot-installation"
[ -f "$marker" ] && [ -f "$install_dir/.env" ] || fail 'A managed installation with saved configuration is required.'
installation_id=$(sed -n '1p' "$marker")
socket=$(sed -n '2p' "$marker")
[[ "$installation_id" =~ ^[a-f0-9]{32}$ ]] || fail 'Invalid installation marker.'
case "$socket" in /*) ;; *) fail 'Invalid Docker socket in installation marker.' ;; esac
[ -S "$socket" ] || fail 'Saved Docker socket is unavailable. Start Docker and retry.'
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST="unix://$socket"
docker info >/dev/null || fail 'Cannot access the saved Docker Engine.'
docker compose version >/dev/null || fail 'The Docker Compose plugin is required.'
api=$(docker version --format '{{.Server.APIVersion}}')
[[ "$api" =~ ^1\.[0-9]+$ ]] && [ "${api#1.}" -ge 47 ] || fail 'Docker Engine API 1.47 or newer is required.'

lock="$install_dir/.nimbot-maintenance"
reclaim=''
work_dir=''
locked=false
cleanup() {
  if "$locked"; then rm -f -- "$lock"; fi
  [ -z "$reclaim" ] || rmdir -- "$reclaim"
  [ -z "$work_dir" ] || rm -rf -- "$work_dir"
}
trap cleanup EXIT
if ! ln -s "$$" "$lock" 2>/dev/null; then
  [ "$version" = '--rollback' ] || fail 'Installation maintenance is already in progress.'
  mkdir "$lock.reclaim" 2>/dev/null || fail 'Another recovery is already in progress.'
  reclaim="$lock.reclaim"
  owner=$(readlink "$lock")
  [[ "$owner" =~ ^[1-9][0-9]*$ ]] || fail 'Invalid maintenance lock.'
  if kill -0 "$owner" 2>/dev/null; then fail "Installation maintenance is still running (PID $owner)."; fi
  rm -f -- "$lock"
  ln -s "$$" "$lock" 2>/dev/null || fail 'Another maintenance command acquired the lock.'
fi
locked=true
journal="$install_dir/.nimbot-upgrade.json"
helper_record="$install_dir/.nimbot-upgrade-helper"
helper_name="nimbot-upgrade-$installation_id"
if [ "$version" = '--rollback' ]; then
  [ -f "$journal" ] || fail 'There is no interrupted upgrade to recover.'
  helper=$(cat "$helper_record")
  helper_prefix="nimbot-upgrade-$installation_id:"
  [[ "$helper" == "$helper_prefix"* && "${helper#"$helper_prefix"}" =~ $version_pattern ]] || fail 'Invalid saved upgrade image.'
  server_image=''
  host_image=''
else
  [ ! -f "$journal" ] || fail 'An upgrade is pending. Run upgrade.sh --rollback to recover it.'
  if [ -f "$install_dir/.nimbot-release" ] && [ "$(cat "$install_dir/.nimbot-release")" = "$version" ]; then
    printf 'Nimbot %s is already installed.\n' "$version"
    exit 0
  fi
  releases="$install_dir/.nimbot-releases"
  release="$releases/$version"
  mkdir -p "$releases"
  if [ ! -d "$release" ]; then
    work_dir=$(mktemp -d "$releases/.download.XXXXXX")
    printf 'Downloading Nimbot %s...\n' "$version"
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      "https://codeload.github.com/celeris-it/nimbot/tar.gz/refs/tags/$version" -o "$work_dir/source.tar.gz"
    mkdir "$work_dir/source"
    tar -xzf "$work_dir/source.tar.gz" --strip-components=1 -C "$work_dir/source"
    [ -f "$work_dir/source/release.json" ] && [ -f "$work_dir/source/upgrade.sh" ] || fail 'This release does not support upgrades.'
    mv "$work_dir/source" "$release"
  fi
  helper="nimbot-upgrade-$installation_id:$version"
  server_image="nimbot-server-$installation_id:$version"
  host_tag="nimbot-agent-host-$installation_id:$version"
  printf 'Building Nimbot %s images while the current release continues to run...\n' "$version"
  docker build --target upgrade -f "$release/infrastructure/docker/server.Dockerfile" -t "$helper" "$release"
  docker build -f "$release/infrastructure/docker/server.Dockerfile" -t "$server_image" "$release"
  docker build -f "$release/infrastructure/docker/agent-host.Dockerfile" -t "$host_tag" "$release"
  host_image=$(docker image inspect --format '{{.Id}}' "$host_tag")
  printf '%s\n' "$helper" > "$helper_record.tmp"
  mv "$helper_record.tmp" "$helper_record"
  # Use maintenance-aware launchers even if the data upgrade needs to roll back.
  for launcher in install.sh uninstall.sh upgrade.sh; do
    cp "$release/$launcher" "$install_dir/.$launcher.tmp"
    mv "$install_dir/.$launcher.tmp" "$install_dir/$launcher"
  done
fi

# Docker Desktop and other VM-backed engines can expose a different GID in containers.
socket_gid=$(docker run --rm --network none --read-only --cap-drop ALL \
  -v "$socket:/var/run/docker.sock:ro" "$helper" stat -c '%g' /var/run/docker.sock)
[[ "$socket_gid" =~ ^[0-9]+$ ]] || fail 'Cannot determine the Docker socket group inside Docker.'
docker run --rm --name "$helper_name" --network none \
  --user "$(id -u):$(id -g)" --group-add "$socket_gid" \
  -e DOCKER_HOST=unix:///var/run/docker.sock -e HOME=/tmp \
  -v "$socket:/var/run/docker.sock" -v "$install_dir:/installation" \
  "$helper" node /app/scripts/upgrade.mjs "$installation_id" "$version" "$helper" "$server_image" "$host_image"
