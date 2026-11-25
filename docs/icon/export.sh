#!/bin/sh
# Renders docs/icon/icon.svg to a 1024x1024 PNG with headless Chrome.
# Usage: sh docs/icon/export.sh <output file>
# The plugin's icon lives in .claude-plugin/, so pass that path to replace it.
set -e
if [ -z "$1" ]; then
  echo "usage: sh docs/icon/export.sh <output file>" >&2
  exit 2
fi
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cat > "$HERE/.render.html" <<HTML
<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden;background:#121820}svg{width:1024px;height:1024px;display:block}</style></head><body>$(cat "$HERE/icon.svg")</body></html>
HTML
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1024,1024 --screenshot="$OUT" "file://$HERE/.render.html" 2>/dev/null
rm -f "$HERE/.render.html"
echo "wrote $OUT"
