#!/bin/zsh
set -eu

radar_dir=${0:A:h}
node_bin="$(/bin/bash "$radar_dir/scripts/bootstrap-node.sh")"
# Explicit one-shot scans remain foreground; normal launches survive closing
# this terminal and reuse the same installation's supervised background service.
if [[ " ${*} " == *" --once "* ]]; then
  "$node_bin" "$radar_dir/scripts/setup.mjs"
  exec "$node_bin" --use-env-proxy "$radar_dir/src/main.mjs" "$@"
fi
exec "$node_bin" "$radar_dir/scripts/open.mjs" "$@"
