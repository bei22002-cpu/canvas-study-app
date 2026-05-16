# Canvas Study — Browser Extension

Runs **inside Canvas** (Instructure and most school Canvas hosts). No `canvas-proxy.py` required — the extension background worker calls the Canvas API with your token.

## Install (developer / unpacked)

1. Open Chrome or Edge → **Extensions** → enable **Developer mode**.
2. Click **Load unpacked**.
3. Select this folder: `canvas-study-app/extension`
4. Open your school **Canvas** site in a tab.
5. Click the gold **Study** button (bottom-right) or the extension toolbar icon → **Open panel on this tab**.
6. On first use: paste your **Canvas access token** and **Anthropic API key** (domain is auto-filled). Check **Remember me**.

## Permissions

- **storage** — save token/key locally in `chrome.storage.sync`
- **https://\*/\*** — call your Canvas domain’s API and run on Canvas pages

## Files

| File | Role |
|------|------|
| `manifest.json` | Extension config (MV3) |
| `background.js` | Canvas API fetch (replaces local proxy) |
| `content-script.js` | Injects Study FAB + side panel iframe |
| `panel.html` | Full app UI (same as `canvas-app.html`) |
| `popup.html` | Toolbar popup to open the panel |

## Standalone app

The repo root still includes `canvas-app.html` + `canvas-proxy.py` if you prefer the file-based workflow.
