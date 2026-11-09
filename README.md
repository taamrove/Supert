# Supert – Lower-third controller for vMix & OBS

Add people + titles, click **Take** to put a name on air, **Clear** (Space/Esc) to take it off.
Runs on your Mac as a tiny local web app (no dependencies).

## Run (Mac)
1. Install Node 22+ once: `brew install node` (or nodejs.org).
2. Double-click `Start.command` (first time: right-click → Open), or run `node server.js`.
3. Control panel: http://localhost:3000

## Three ways to get graphics out (toggle each in the header)

| Output | How it works | Use when |
|---|---|---|
| **vMix** | HTTP calls to vMix Web Controller: `SetText` ×2 then `OverlayInputNIn/Out` | Customer gave you a vMix GT title (.gtzip) |
| **OBS** | obs-websocket v5: set two text sources, show/hide a source or group | Customer graphics are built into an OBS scene |
| **Overlay** | `/overlay` page = transparent 1920×1080 PNG + positioned text | Customer gave you a plain PNG |

### vMix setup
- Settings → Web Controller → enable (default port 8088).
- Add the customer's GT title as an input; note its text layer names (Name.Text / Title.Text by default).
- vMix is Windows-only: if it runs in Parallels / another PC, put that machine's IP in Supert's Settings.

### OBS setup
- Tools → WebSocket Server Settings → enable (port 4455); set a password if you like.
- Create two Text sources + the graphic, group them (e.g. group `LowerThird`), enter the names in Settings.

### Overlay (works in both)
- Settings → upload the customer PNG, nudge text X/Y/size/colour with the live preview.
- OBS: add a **Browser Source** with URL `http://localhost:3000/overlay`, 1920×1080.
- vMix: add a **Web Browser** input with the same URL (use the Mac's LAN IP if vMix is elsewhere).

## Notes
- Data lives in `data/` (git-ignored; includes the OBS password in plain text).
- The server listens on all interfaces so a VM/other PC can reach `/overlay`; use `HOST=127.0.0.1` if everything is on one Mac. `PORT=` changes the port.
- Cross-origin POSTs are rejected so a random web page can't fire your graphics.
