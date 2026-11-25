#!/bin/sh
# Renders an SVG to a 1024x1024 PNG with headless Chrome.
# Usage: sh docs/icon/export.sh <source svg> <output png>
# The icon's source sits beside this script, and the plugin's icon lives in .claude-plugin/.
set -e
if [ -z "$1" ] || [ -z "$2" ]; then
  echo "usage: sh docs/icon/export.sh <source svg> <output png>" >&2
  exit 2
fi
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cat > "$HERE/.render.html" <<HTML
<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden;background:#121820}svg{width:1024px;height:1024px;display:block}</style></head><body>$(cat "$SRC")</body></html>
HTML
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1024,1024 --screenshot="$OUT" "file://$HERE/.render.html" 2>/dev/null
rm -f "$HERE/.render.html"
echo "wrote $OUT"
