#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
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
install_dir=$(cd "$install_dir" && pwd -P)
marker="$install_dir/.nimbot-installation"
[ -f "$marker" ] && [ "$(sed -n '1p' "$marker")" = subprocess-v1 ] || fail 'Not a managed subprocess installation. Existing data was retained; use the original release tools for older installations.'
installation_id=$(sed -n '2p' "$marker")
endpoint=$(sed -n '3p' "$marker")
[[ "$installation_id" =~ ^[a-f0-9]{32}$ ]] || fail 'Invalid installation marker.'
case "$endpoint" in unix:///*) ;; *) fail 'Invalid saved Docker endpoint.' ;; esac
command -v docker >/dev/null || fail 'Docker is required.'
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST="$endpoint"
docker info >/dev/null || fail 'Cannot access the saved Docker Engine.'
lock="$install_dir/.nimbot-maintenance"
ln -s "$$" "$lock" 2>/dev/null || fail 'Installation maintenance is already in progress.'
trap 'rm -f -- "$lock"' EXIT
trap 'printf "Uninstall stopped after an error. Remaining data and configuration were kept; fix the error and retry.\n" >&2' ERR
container="nimbot-$installation_id"
volume="$container-data"
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
exec 3<> /dev/tty || fail 'An interactive terminal is required.'
printf 'Remove the Nimbot application container from %s.\n' "$install_dir"
if "$purge"; then printf 'The complete data volume and .env will be permanently deleted. Backups and source files remain.\n'
else printf 'All data, credentials, .env, images and source files will be kept.\n'; fi
printf 'Continue? [y/N]: ' >&3
IFS= read -r answer <&3 || fail 'Input cancelled.'
case "$answer" in y|Y|yes|YES) ;; *) printf 'Cancelled.\n'; exit 0 ;; esac
if "$purge"; then
  printf 'Type DELETE NIMBOT DATA to confirm permanent data deletion: ' >&3
  IFS= read -r answer <&3 || fail 'Input cancelled.'
  [ "$answer" = 'DELETE NIMBOT DATA' ] || fail 'Data deletion was not confirmed; no resources were changed.'
fi
if [ -n "$saved_container" ]; then
  owned container "$container"
  docker container stop --time 30 "$container" >/dev/null
  owned container "$container"
  docker container rm "$container" >/dev/null
fi
if "$purge"; then
  if [ -n "$saved_volume" ]; then owned volume "$volume"; docker volume rm "$volume" >/dev/null; fi
  rm -f -- "$install_dir/.env"
fi
printf 'Nimbot was uninstalled. Images, source files and backups remain at %s.\n' "$install_dir"
if ! "$purge"; then printf 'Data was retained. Rerun install.sh with the same directory to resume, or uninstall.sh --purge-data to erase it.\n'; fi
