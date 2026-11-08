#!/bin/sh
# Renders docs/icon/icon.svg to .claude-plugin/icon.png at 1024x1024 with headless Chrome.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cat > "$HERE/.render.html" <<HTML
<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden;background:#121820}svg{width:1024px;height:1024px;display:block}</style></head><body>$(cat "$HERE/icon.svg")</body></html>
HTML
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1024,1024 --screenshot="$HERE/../../.claude-plugin/icon.png" "file://$HERE/.render.html" 2>/dev/null
rm -f "$HERE/.render.html"
echo "wrote .claude-plugin/icon.png"
