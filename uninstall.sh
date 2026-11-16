#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
trap 'printf "Uninstall stopped after an error. Remaining resources and configuration were kept; fix the error and rerun this script.\n" >&2' ERR
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
install_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
purge=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --directory) [ "$#" -ge 2 ] || fail '--directory requires a path'; install_dir="$2"; shift 2 ;;
    --purge-data) purge=true; shift ;;
    --help|-h) printf 'Usage: bash uninstall.sh [--directory PATH] [--purge-data]\n'; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
command -v docker >/dev/null || fail 'Docker is required.'
install_dir=$(cd "$install_dir" && pwd -P)
marker="$install_dir/.nimbot-installation"
[ -f "$marker" ] || fail 'Not a managed Nimbot installation; no resources were changed.'
installation_id=$(sed -n '1p' "$marker")
socket=$(sed -n '2p' "$marker")
[[ "$installation_id" =~ ^[a-f0-9]{32}$ ]] || fail 'Invalid installation marker.'
case "$socket" in /*) ;; *) fail 'Invalid Docker socket in installation marker.' ;; esac
[ -S "$socket" ] || fail 'Saved Docker socket is unavailable. Start Docker and retry.'
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST="unix://$socket"
docker info >/dev/null || fail 'Cannot access the saved Docker Engine.'
exec 3<> /dev/tty || fail 'An interactive terminal is required.'
project="nimbot-$installation_id"
label="io.nimbot.installation=$installation_id"

# Inspect every candidate again before mutation. Do not rely only on list filters.
owned() {
  local kind="$1" ref="$2" actual
  if [ "$kind" = container ]; then
    actual=$(docker container inspect --format '{{index .Config.Labels "io.nimbot.installation"}}' "$ref")
  else
    actual=$(docker "$kind" inspect --format '{{index .Labels "io.nimbot.installation"}}' "$ref")
  fi
  [ "$actual" = "$installation_id" ] || fail "Refusing foreign $kind: $ref"
}
containers=$(docker container ls -aq --filter "label=$label")
networks=$(docker network ls -q --filter "label=$label")
volumes=$(docker volume ls -q --filter "label=$label")
server=$(docker ps -aq --filter name='^/nimbot-server$')
if [ -n "$server" ]; then
  owned container "$server"
  actual_project=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$server")
  [ "$actual_project" = "$project" ] || fail 'The server Compose project does not match this installation.'
fi
printf 'Uninstall Nimbot from %s.\nContainers and networks for this installation will be removed.\n' "$install_dir"
if "$purge"; then
  printf 'ALL agent files, conversations, credentials, server state and .env will also be deleted.\n'
else
  printf 'All volumes, credentials, .env, images and source files will be kept.\nRetained data does not automatically recreate removed agent containers.\n'
fi
printf 'Continue? [y/N]: ' >&3
IFS= read -r answer <&3 || fail 'Input cancelled.'
case "$answer" in y|Y|yes|YES) ;; *) printf 'Cancelled.\n'; exit 0 ;; esac
if "$purge"; then
  printf 'Type DELETE NIMBOT DATA to confirm permanent data deletion: ' >&3
  IFS= read -r answer <&3 || fail 'Input cancelled.'
  [ "$answer" = 'DELETE NIMBOT DATA' ] || fail 'Data deletion was not confirmed; no resources were changed.'
fi
# Stop server first, so it cannot create more resources while uninstalling.
if [ -n "$server" ]; then
  owned container "$server"
  docker container stop --time 15 "$server" >/dev/null
fi
# Refresh inventory after shutdown: an in-flight provisioning operation may have settled.
containers=$(docker container ls -aq --filter "label=$label")
for ref in $containers; do
  owned container "$ref"
  docker container stop --time 15 "$ref" >/dev/null
  docker container rm "$ref" >/dev/null
done
networks=$(docker network ls -q --filter "label=$label")
for ref in $networks; do
  owned network "$ref"
  docker network rm "$ref" >/dev/null
done
if "$purge"; then
  volumes=$(docker volume ls -q --filter "label=$label")
  for ref in $volumes; do
    owned volume "$ref"
    docker volume rm "$ref" >/dev/null
  done
  rm -f "$install_dir/.env"
fi
printf 'Nimbot was uninstalled. Images and source files remain at %s.\n' "$install_dir"
if ! "$purge"; then
  printf 'Data was retained. Run this script with --purge-data if you later decide to delete it.\n'
fi
