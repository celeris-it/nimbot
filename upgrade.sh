#!/usr/bin/env bash
set +x
set -euo pipefail
if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then
  printf 'This fresh-install subprocess release has no automated upgrade or rollback command.\nSee docs/INSTALL.md and docs/OPERATIONS.md for Docker CLI updates and complete data-volume backups.\n'
  exit 0
fi
printf 'Error: This release requires a fresh installation and does not migrate or import previous per-agent Docker state.\nNo containers, volumes or files were changed.\nUse the original release tools for an older interrupted upgrade. For subprocess deployments, follow the Docker CLI update and backup procedure in docs/OPERATIONS.md.\n' >&2
exit 1
