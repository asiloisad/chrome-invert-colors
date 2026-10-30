import { clearError, describeMode, request, showError } from './ui-shared.js';

const enabled = document.querySelector('#enabled');
const hostname = document.querySelector('#hostname');
const siteControls = document.querySelector('#site-controls');
const pageNotice = document.querySelector('#page-notice');
const defaultDescription = document.querySelector('#default-description');
const temporaryDisableButton = document.querySelector('#temporary-disable');
const temporaryDisableIndicator = document.querySelector('#temporary-disable-indicator');
const temporaryButton = document.querySelector('#temporary');
const temporaryWholePageButton = document.querySelector('#temporary-whole-page');
const temporaryWholePageIndicator = document.querySelector('#temporary-whole-page-indicator');
const resetTemporary = document.querySelector('#reset-temporary');
const indicator = document.querySelector('#temporary-indicator');
const status = document.querySelector('#status');
const errorElement = document.querySelector('#error');
const requestedTabId = new URLSearchParams(location.search).get('tabId');
const parsedTabId = requestedTabId !== null && /^\d+$/u.test(requestedTabId) ? Number(requestedTabId) : undefined;
const invalidRequestedTab = requestedTabId !== null && (!Number.isSafeInteger(parsedTabId) || parsedTabId < 0);
let state = null;
let tabId = parsedTabId;
let busy = false;
let refreshTimer;

function render(nextState) {
  state = nextState;
  tabId = nextState.tab?.id ?? tabId;
  const { settings, tab } = nextState;
  const supported = Boolean(tab?.supported);
  const active = Boolean(settings.enabled);
  enabled.checked = active;
  enabled.disabled = busy;
  hostname.textContent = tab?.hostname || 'Current tab';
  hostname.title = tab?.url || '';
  defaultDescription.textContent = describeMode(settings.defaultMode);
  siteControls.disabled = !supported || busy;
  const selectedMode = tab?.hasRule ? tab.baseMode : 'default';
  for (const input of siteControls.querySelectorAll('input')) input.checked = input.value === selectedMode;

  temporaryDisableButton.disabled = !supported || !active || busy;
  temporaryDisableButton.setAttribute('aria-pressed', String(Boolean(tab?.temporarilyDisabled)));
  temporaryDisableIndicator.textContent = tab?.temporarilyDisabled ? 'On' : 'Ⅱ';
  temporaryButton.disabled = !supported || !active || busy;
  temporaryButton.setAttribute('aria-pressed', String(Boolean(tab?.temporary)));
  indicator.textContent = tab?.temporary ? 'On' : '↔';
  temporaryWholePageButton.disabled = !supported || !active || busy;
  temporaryWholePageButton.setAttribute('aria-pressed', String(Boolean(tab?.temporaryWholePage)));
  temporaryWholePageIndicator.textContent = tab?.temporaryWholePage ? 'On' : '◩';
  resetTemporary.hidden = !supported || (!tab?.temporary && !tab?.temporarilyDisabled && !tab?.temporaryWholePage);
  resetTemporary.disabled = busy;
  if (!supported) {
    pageNotice.textContent = 'The browser does not allow color changes in this tab. Open a regular web page.';
    pageNotice.hidden = false;
  } else if (!active) {
    pageNotice.textContent = 'The extension is paused. Saved rules are still available.';
    pageNotice.hidden = false;
  } else {
    pageNotice.hidden = true;
    pageNotice.textContent = '';
  }
  const temporaryCommand = nextState.commands?.find(command => command.name === 'toggle-temporary');
  temporaryButton.title = temporaryCommand?.shortcut ? `Shortcut: ${temporaryCommand.shortcut}` : '';
}

async function refresh() {
  if (busy) return;
  try {
    if (invalidRequestedTab) throw new Error('Invalid tab ID. Reopen the panel from the extension icon menu.');
    render(await request('GET_STATE', Number.isInteger(tabId) ? { tabId } : {}));
    clearError(errorElement);
  } catch (error) {
    showError(errorElement, error);
    if (!state) {
      hostname.textContent = 'Could not load the tab';
      status.textContent = '';
    }
  }
}

async function mutate(type, payload, message) {
  if (busy || !state) return;
  busy = true;
  status.textContent = '';
  clearError(errorElement);
  render(state);
  try {
    const result = await request(type, payload);
    state = result.tab ? result : await request('GET_STATE', { tabId });
    status.textContent = message;
  } catch (error) {
    showError(errorElement, error);
    try { state = await request('GET_STATE', { tabId }); } catch { /* Preserve the last known state. */ }
  } finally {
    busy = false;
    render(state);
  }
}

enabled.addEventListener('change', () => mutate('SET_ENABLED', { enabled: enabled.checked }, enabled.checked ? 'Extension enabled.' : 'Extension paused.'));
siteControls.addEventListener('change', event => {
  if (event.target.name === 'site-mode') mutate('SET_SITE_MODE', { tabId, mode: event.target.value }, 'Website mode saved.');
});
temporaryButton.addEventListener('click', () => mutate('TOGGLE_TEMPORARY', { tabId }, state.tab.temporary ? 'Saved mode restored.' : 'Temporary inversion enabled.'));
temporaryDisableButton.addEventListener('click', () => mutate('TOGGLE_TEMPORARY_DISABLED', { tabId }, state.tab.temporarilyDisabled ? 'Saved mode restored.' : 'Filters temporarily disabled in this tab.'));
temporaryWholePageButton.addEventListener('click', () => mutate('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId }, state.tab.temporaryWholePage ? 'Saved mode restored.' : 'Whole-page inversion temporarily enabled.'));
resetTemporary.addEventListener('click', () => mutate('RESET_TEMPORARY', { tabId }, 'Saved mode restored.'));
document.querySelector('#open-options').addEventListener('click', async () => {
  try { await chrome.runtime.openOptionsPage(); } catch (error) { showError(errorElement, error); }
});
document.querySelector('#open-shortcuts').addEventListener('click', async () => {
  try { await request('OPEN_SHORTCUTS'); } catch (error) { showError(errorElement, error); }
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local' && area !== 'session') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 100);
});
chrome.tabs.onUpdated.addListener((updatedId, change) => {
  if (updatedId === tabId && (change.url || change.status === 'complete')) refresh();
});
await refresh();
