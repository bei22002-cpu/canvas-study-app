document.getElementById('openBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL' }).catch(() => {
    alert('Open a Canvas page first (your school Canvas site), then try again.');
  });
  window.close();
});
