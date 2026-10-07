#!/bin/bash
# A color screenshot of the GraphOS Inspector pane in a tmux window: the capture
# (with its escapes) to HTML, then headless Chrome to PNG.
#
#   scripts/pane-shot.sh <tmux-target> [out.png]     e.g. scripts/pane-shot.sh tester
#
# Writes shots/<time>.png by default (git-ignored); prints the path.

set -euo pipefail
target=${1:?usage: pane-shot.sh <tmux-target> [out.png]}
here=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$here/shots"
out=${2:-$here/shots/$(date +%H%M%S).png}
page=$(mktemp -t pane-shot).html
chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

tmux capture-pane -p -e -t "$target" | python3 "$here/scripts/ansi2html.py" --pane > "$page"
# Tall enough for a full pane; Chrome pads the rest with the page background.
rows=$(grep -c '' "$page")
"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1000,$((rows * 19 + 40)) --screenshot="$out" "file://$page" >/dev/null 2>&1
rm -f "$page"
echo "$out"
