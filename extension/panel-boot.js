/** Extension mode flag — panel runs as chrome-extension:// page */
window.__CS_EXT__ = !!(typeof chrome !== 'undefined' && chrome.runtime?.id);
