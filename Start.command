#!/bin/bash
# Double-click in Finder to launch. First time: right-click → Open (Gatekeeper).
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  osascript -e 'display dialog "Node.js 22+ is required. Install with: brew install node (or from nodejs.org)" buttons {"OK"}'
  exit 1
fi
(sleep 1; open "http://localhost:3000") &
node server.js
