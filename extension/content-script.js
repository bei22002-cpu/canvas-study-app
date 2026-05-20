(function () {
  if (window.__canvasStudyInjected) return;
  window.__canvasStudyInjected = true;

  const host = location.hostname;
  const path = location.pathname;

  const looksLikeCanvas =
    /\.instructure\.com$/i.test(host) ||
    /(^|\.)canvas\./i.test(host) ||
    /\/courses(\/|$)/i.test(path) ||
    !!document.querySelector(
      '#application.ic-app, #wrapper.ic-Layout-wrapper, .ic-Dashboard-header'
    );

  if (!looksLikeCanvas) return;

  const panelUrl =
    chrome.runtime.getURL('panel.html') + '?domain=' + encodeURIComponent(host);

  const root = document.createElement('div');
  root.id = 'canvas-study-root';

  const backdrop = document.createElement('div');
  backdrop.id = 'canvas-study-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');

  const iframe = document.createElement('iframe');
  iframe.id = 'canvas-study-panel';
  iframe.src = panelUrl;
  iframe.title = 'Canvas Study';
  iframe.tabIndex = 0;
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');

  const fab = document.createElement('button');
  fab.id = 'canvas-study-fab';
  fab.type = 'button';
  fab.title = 'Canvas Study';
  fab.textContent = 'Study';
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'canvas-study-panel');

  function focusPanel() {
    requestAnimationFrame(() => {
      try {
        iframe.focus();
        iframe.contentWindow?.focus?.();
      } catch (_) {
        /* cross-origin focus may fail until loaded */
      }
    });
  }

  function openPanel() {
    root.classList.add('panel-open');
    backdrop.classList.add('open');
    iframe.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
    focusPanel();
  }

  function closePanel() {
    root.classList.remove('panel-open');
    backdrop.classList.remove('open');
    iframe.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false');
  }

  function togglePanel() {
    if (iframe.classList.contains('open')) closePanel();
    else openPanel();
  }

  fab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePanel();
  });

  backdrop.addEventListener('click', closePanel);

  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'CANVAS_STUDY_CLOSE') closePanel();
  });

  iframe.addEventListener('load', () => {
    if (iframe.classList.contains('open')) focusPanel();
  });

  root.appendChild(backdrop);
  root.appendChild(iframe);
  root.appendChild(fab);
  document.documentElement.appendChild(root);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_PANEL') togglePanel();
    if (msg.type === 'OPEN_PANEL') openPanel();
  });
})();
