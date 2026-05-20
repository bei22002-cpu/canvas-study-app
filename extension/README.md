# Canvas Study — Browser Extension

Runs **inside Canvas** with a **background proxy** in the extension service worker (same job as `canvas-proxy.py`, but no Python process). Login is **remembered** in `chrome.storage.local` when you connect with **Remember my credentials** checked (default).

## Install (developer / unpacked)

1. Open Chrome or Edge → **Extensions** → enable **Developer mode**.
2. Click **Load unpacked**.
3. Select this folder: `canvas-study-app/extension`
4. Open your school **Canvas** site in a tab.
5. Click the **Study** button (bottom-right) or the extension toolbar icon → **Open panel on this tab**.
6. Enter **Canvas token** + **Anthropic API key** (domain is auto-filled). Click **Connect**.

After updating files: **Reload** the extension, then **refresh** the Canvas tab.

## Background proxy

| Standalone app | Extension |
|----------------|-----------|
| `python canvas-proxy.py` on port 3001 | **Service worker** (`background.js`) handles `PROXY_GET` |
| Panel uses `fetch('http://127.0.0.1:3001/...')` | Panel uses `extProxyRequest()` → background worker → Canvas HTTPS |

Settings shows **Background proxy ready** when the worker is running. You do **not** need to start `canvas-proxy.py` for the extension.

## Remember login

- Checkbox **Remember my credentials on this device** (on by default).
- On successful **Connect**, domain, token, Anthropic key, and course colors are saved via the background proxy storage.
- Next time you open the panel on Canvas, fields are prefilled and it **auto-connects** if all three values were saved.

Use **Settings → Clear & log out** to remove saved credentials.

## Troubleshooting

- **Panel opens but clicks fail** — reload extension + refresh Canvas (see v1.0.2 click fix).
- **401 on Connect** — new Canvas access token; domain without `https://`; no `Bearer ` prefix.
- **Background proxy offline** — reload extension at `chrome://extensions`.
- **No Study button** — must be on your school Canvas site, not `canvas-app.html` locally.

## Permissions

- **storage** — remembered login + course colors
- **tabs** — open panel from toolbar popup
- **https://\*/\*** — background proxy calls your Canvas API

## Standalone app

The repo root still has `canvas-app.html` + `canvas-proxy.py` if you prefer the local Python proxy workflow.
