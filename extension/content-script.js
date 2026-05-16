(function () {
  if (window.__canvasStudyInjected) return;
  window.__canvasStudyInjected = true;

  const host = location.hostname;
  const path = location.pathname;
  const looksLikeCanvas =
    /\.instructure\.com$/i.test(host) ||
    /(^|\.)canvas\./i.test(host) ||
    /\/courses\/\d+/.test(path) ||
    !!document.querySelector('#application.ic-app, #wrapper.ic-Layout-wrapper');

  if (!looksLikeCanvas) return;

  const panelUrl =
    chrome.runtime.getURL('panel.html') + '?domain=' + encodeURIComponent(host);

  const backdrop = document.createElement('div');
  backdrop.id = 'canvas-study-backdrop';

  const iframe = document.createElement('iframe');
  iframe.id = 'canvas-study-panel';
  iframe.src = panelUrl;
  iframe.title = 'Canvas Study';
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');

  const fab = document.createElement('button');
  fab.id = 'canvas-study-fab';
  fab.type = 'button';
  fab.title = 'Canvas Study';
  fab.textContent = 'Study';

  function openPanel() {
    backdrop.classList.add('open');
    iframe.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
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

  document.documentElement.appendChild(backdrop);
  document.documentElement.appendChild(iframe);
  document.documentElement.appendChild(fab);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_PANEL') togglePanel();
    if (msg.type === 'OPEN_PANEL') openPanel();
  });
})();
