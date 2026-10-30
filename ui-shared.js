export const MODE_LABELS = Object.freeze({
  media: 'Media only',
  page: 'Whole page',
  off: 'No changes',
});

export async function request(type, payload = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    throw new Error(error?.message || 'Could not connect to the extension.');
  }
  if (!response || response.ok !== true) {
    throw new Error(response?.error || 'The extension did not respond. Please try again.');
  }
  return response;
}

export function showError(element, error) {
  element.textContent = error instanceof Error ? error.message : String(error);
  element.hidden = false;
}

export function clearError(element) {
  element.textContent = '';
  element.hidden = true;
}

export function describeMode(mode) {
  return MODE_LABELS[mode] || MODE_LABELS.off;
}
