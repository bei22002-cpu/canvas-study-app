# Canvas Study App

A single-page Canvas companion: **AI Assistant**, **Materials** viewer, **My Library** (IndexedDB), **Study Tutor**, calendar, and weekly planner. Uses the Canvas REST API and Anthropic Claude (`/v1/messages`).

## Quick start (standalone HTML)

1. **Canvas API token** — Canvas → Account → Settings → New Access Token  
2. **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)  
3. Start the CORS proxy (required for the browser app):

   ```bash
   python canvas-proxy.py
   ```

4. Open `canvas-app.html` in your browser (or serve the folder):

   ```bash
   python -m http.server 8080 --bind 127.0.0.1
   # http://127.0.0.1:8080/canvas-app.html
   ```

5. Enter your Canvas domain (e.g. `school.instructure.com`), token, and Anthropic key → **Connect**.

Health check: `http://127.0.0.1:3001/proxy-health`

## Files

| File | Purpose |
|------|---------|
| `canvas-app.html` | Full app (UI + logic) |
| `canvas-proxy.py` | Local GET proxy for Canvas API (CORS) |

## Security

- Tokens and keys are stored in **browser localStorage** only when you choose “Remember me”.
- Do **not** commit API keys or Canvas tokens to this repository.

## Browser extension

A Chrome/Edge extension (in-app panel on Canvas) is in progress on the `extension` branch / `extension/` folder when available.

## License

MIT — use at your own risk; respect your institution’s academic integrity and Canvas terms of use.
