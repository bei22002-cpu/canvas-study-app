/**
 * Background Canvas proxy — same role as canvas-proxy.py, runs in the MV3 service worker.
 * Panel calls PROXY_GET / PROXY_HEALTH; credentials live in chrome.storage.local.
 */
const STORAGE_KEYS = [
  'canvasDomain',
  'canvasToken',
  'anthropicKey',
  'courseColors',
  'rememberMe',
  'lastConnectedAt',
];

const PROXY_SERVICE = 'canvas-study-background-proxy';

function normalizeDomain(raw) {
  let d = (raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const slash = d.indexOf('/');
  if (slash > 0) d = d.slice(0, slash);
  return d.toLowerCase();
}

function normalizeToken(raw) {
  let t = (raw || '').trim().replace(/^["']|["']$/g, '');
  if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, '').trim();
  return t;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log(`[${PROXY_SERVICE}] ready`);
});

chrome.runtime.onStartup.addListener(() => {
  console.log(`[${PROXY_SERVICE}] started`);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (
        msg.type === 'CANVAS_FETCH' ||
        msg.type === 'PROXY_GET'
      ) {
        sendResponse(await proxyGet(msg));
        return;
      }
      if (msg.type === 'PING' || msg.type === 'PROXY_HEALTH') {
        sendResponse({
          ok: true,
          service: PROXY_SERVICE,
          port: null,
          note: 'Runs inside the extension (no python canvas-proxy.py needed)',
        });
        return;
      }
      if (msg.type === 'GET_CREDENTIALS') {
        const data = await chrome.storage.local.get(STORAGE_KEYS);
        sendResponse({ ok: true, data });
        return;
      }
      if (msg.type === 'SAVE_CREDENTIALS') {
        const payload = { ...(msg.payload || {}), rememberMe: msg.payload?.rememberMe !== false };
        await chrome.storage.local.set(payload);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'CLEAR_CREDENTIALS') {
        await chrome.storage.local.remove(STORAGE_KEYS);
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});

async function proxyGet(msg) {
  const stored = await chrome.storage.local.get(['canvasDomain', 'canvasToken']);
  const domain = normalizeDomain(msg.domain || stored.canvasDomain || '');
  const token = normalizeToken(msg.token || stored.canvasToken || '');

  if (!domain || !token) {
    return {
      ok: false,
      status: 400,
      error:
        'Missing Canvas domain or token. Fill both fields and click Connect.',
    };
  }

  // Keep storage in sync when panel sends fresh credentials
  if (msg.domain && msg.token) {
    await chrome.storage.local.set({ canvasDomain: domain, canvasToken: token });
  }

  const path = (msg.path || '').startsWith('/') ? msg.path : '/' + (msg.path || '');
  const url = `https://${domain}${path}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: `Network error reaching https://${domain} — ${e.message || e}. Check domain spelling or try your school's instructure.com hostname.`,
    };
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const errMsg =
      json?.errors?.[0]?.message || json?.message || res.statusText || `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: errMsg };
  }

  return {
    ok: true,
    status: res.status,
    json,
    link: res.headers.get('Link') || '',
  };
}
