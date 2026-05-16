/**
 * Canvas API bridge — no local proxy. Fetches the user's Canvas domain with their token.
 */
const STORAGE_KEYS = ['canvasDomain', 'canvasToken', 'anthropicKey', 'courseColors', 'rememberMe'];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'CANVAS_FETCH') {
    handleCanvasFetch(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'GET_CREDENTIALS') {
    chrome.storage.sync.get(STORAGE_KEYS).then((data) => sendResponse({ ok: true, data }));
    return true;
  }
  if (msg.type === 'SAVE_CREDENTIALS') {
    chrome.storage.sync.set(msg.payload || {}).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'CLEAR_CREDENTIALS') {
    chrome.storage.sync.remove(STORAGE_KEYS).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'PING') {
    sendResponse({ ok: true, service: 'canvas-study-extension' });
    return true;
  }
  return false;
});

async function handleCanvasFetch(msg) {
  const stored = await chrome.storage.sync.get(['canvasDomain', 'canvasToken']);
  const domain = (msg.domain || stored.canvasDomain || '').trim().replace(/^https?:\/\//, '');
  const token = (msg.token || stored.canvasToken || '').trim();
  if (!domain || !token) {
    return { ok: false, error: 'Not connected — add Canvas domain and token in Canvas Study settings.' };
  }
  const path = msg.path.startsWith('/') ? msg.path : '/' + msg.path;
  const url = `https://${domain}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const errMsg = json?.errors?.[0]?.message || json?.message || res.statusText || `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: errMsg };
  }
  return {
    ok: true,
    status: res.status,
    json,
    link: res.headers.get('Link') || '',
  };
}
