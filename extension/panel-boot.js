/** Extension bootstrap — must load before panel app script */
window.__CS_EXT__ = !!(typeof chrome !== 'undefined' && chrome.runtime?.id);

window.extSendMessage = function (msg) {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.id) {
      reject(
        new Error(
          'Extension context lost. Close the panel and click Study again (or reload the extension).'
        )
      );
      return;
    }
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
};

window.normalizeCanvasDomain = function (raw) {
  let d = (raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const slash = d.indexOf('/');
  if (slash > 0) d = d.slice(0, slash);
  return d.toLowerCase();
};

window.normalizeCanvasToken = function (raw) {
  let t = (raw || '').trim().replace(/^["']|["']$/g, '');
  if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, '').trim();
  return t;
};

/** All Canvas API traffic goes through the background proxy service worker */
window.extProxyRequest = async function (path, opts = {}) {
  const r = await extSendMessage({
    type: 'PROXY_GET',
    path,
    domain: opts.domain,
    token: opts.token,
  });
  if (r === undefined) {
    throw new Error(
      'Background proxy did not respond. Go to chrome://extensions and click Reload on Canvas Study, then refresh Canvas.'
    );
  }
  if (!r?.ok) {
    const detail = r?.error || '';
    let msg = detail || `Canvas ${r?.status || 'error'}`;
    if (r?.status === 401) {
      msg =
        'Canvas rejected your login (401). Create a new access token: Canvas → Account → Settings → New Access Token. Paste only the token (not "Bearer"). If auto-detected domain fails, try yourschool.instructure.com' +
        (detail ? '. Canvas: ' + detail : '');
    }
    if (r?.status === 0) {
      msg = detail || msg;
    }
    const err = new Error(msg);
    err.status = r?.status;
    throw err;
  }
  return { json: r.json, link: r.link || '', status: r.status };
};

window.extSaveLogin = async function (payload) {
  return extSendMessage({ type: 'SAVE_CREDENTIALS', payload });
};

window.extLoadLogin = async function () {
  const r = await extSendMessage({ type: 'GET_CREDENTIALS' });
  return r?.ok ? r.data || {} : {};
};

window.extClearLogin = async function () {
  return extSendMessage({ type: 'CLEAR_CREDENTIALS' });
};

window.csStorageGet = function (keys) {
  return chrome.storage.local.get(keys);
};
window.csStorageSet = function (data) {
  return chrome.storage.local.set(data);
};
window.csStorageRemove = function (keys) {
  return chrome.storage.local.remove(keys);
};
