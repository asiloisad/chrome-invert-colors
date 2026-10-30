import { clearError, MODE_LABELS, request, showError } from './ui-shared.js';

const enabled = document.querySelector('#enabled');
const defaultMode = document.querySelector('#default-mode');
const mediaControls = [...document.querySelectorAll('[data-media]')];
const status = document.querySelector('#status');
const errorElement = document.querySelector('#error');
const siteList = document.querySelector('#site-list');
const siteSearch = document.querySelector('#site-search');
const siteCount = document.querySelector('#site-count');
const emptySites = document.querySelector('#empty-sites');
const addSite = document.querySelector('#add-site');
const newHostname = document.querySelector('#new-hostname');
const newMode = document.querySelector('#new-mode');
const importFile = document.querySelector('#import-file');
let settings = null;
let pending = 0;
let queue = Promise.resolve();
let refreshTimer;

function buildSiteList() {
  const focused = siteList.contains(document.activeElement) ? {
    hostname: document.activeElement.dataset.hostname,
    tagName: document.activeElement.tagName,
  } : null;
  const search = siteSearch.value.trim().toLocaleLowerCase('en');
  const entries = Object.entries(settings.sites).sort(([a], [b]) => a.localeCompare(b, 'en')).filter(([hostname]) => hostname.toLocaleLowerCase('en').includes(search));
  siteCount.textContent = String(Object.keys(settings.sites).length);
  const fragment = document.createDocumentFragment();
  for (const [hostname, mode] of entries) {
    const item = document.createElement('li');
    item.className = 'site-row';
    const name = document.createElement('span');
    name.className = 'site-hostname';
    name.textContent = hostname;
    name.title = hostname;
    const select = document.createElement('select');
    select.dataset.hostname = hostname;
    select.setAttribute('aria-label', `Mode for ${hostname}`);
    for (const [value, label] of Object.entries(MODE_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = mode === value;
      select.append(option);
    }
    const remove = document.createElement('button');
    remove.className = 'text-button remove-site';
    remove.type = 'button';
    remove.dataset.hostname = hostname;
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove rule for ${hostname}`);
    item.append(name, select, remove);
    fragment.append(item);
  }
  siteList.replaceChildren(fragment);
  if (focused) {
    const replacement = [...siteList.querySelectorAll('[data-hostname]')].find(element => element.dataset.hostname === focused.hostname && element.tagName === focused.tagName);
    if (replacement) replacement.focus({ preventScroll: true });
    else siteSearch.focus({ preventScroll: true });
  }
  emptySites.hidden = entries.length > 0;
  emptySites.textContent = search ? 'No rules match your search.' : 'No saved rules. New websites use the default mode.';
}

function render() {
  if (!settings) return;
  enabled.checked = settings.enabled;
  defaultMode.value = settings.defaultMode;
  for (const input of mediaControls) input.checked = settings.media[input.dataset.media];
  for (const input of document.querySelectorAll('input, select, #add-site-button, #export, #import')) input.disabled = false;
  buildSiteList();
}

async function refresh() {
  if (pending) return;
  try {
    const response = await request('GET_SETTINGS');
    if (pending) return;
    settings = response.settings;
    render();
    if (status.textContent === 'Loading settings…') status.textContent = 'All changes are saved automatically.';
  } catch (error) {
    status.textContent = '';
    showError(errorElement, error);
  }
}

function mutate(type, payload, success = 'Settings saved.', afterSuccess) {
  pending += 1;
  status.textContent = 'Saving…';
  clearError(errorElement);
  const operation = queue.then(async () => {
    try {
      const response = await request(type, payload);
      settings = response.settings;
      if (!settings) settings = (await request('GET_SETTINGS')).settings;
      if (afterSuccess) afterSuccess();
      if (pending === 1) status.textContent = success;
    } catch (error) {
      status.textContent = '';
      showError(errorElement, error);
      try { settings = (await request('GET_SETTINGS')).settings; } catch { /* The error above remains visible. */ }
    } finally {
      pending -= 1;
      if (!pending) render();
    }
  });
  queue = operation.catch(() => {});
  return operation;
}

enabled.addEventListener('change', () => mutate('SET_ENABLED', { enabled: enabled.checked }));
defaultMode.addEventListener('change', () => mutate('UPDATE_SETTINGS', { patch: { defaultMode: defaultMode.value } }));
for (const input of mediaControls) input.addEventListener('change', () => mutate('UPDATE_SETTINGS', { patch: { media: { [input.dataset.media]: input.checked } } }));
siteSearch.addEventListener('input', () => { if (settings) buildSiteList(); });
siteList.addEventListener('change', event => {
  if (event.target.matches('select[data-hostname]')) mutate('SET_HOST_MODE', { hostname: event.target.dataset.hostname, mode: event.target.value }, 'Website rule saved.');
});
siteList.addEventListener('click', event => {
  const button = event.target.closest('button[data-hostname]');
  if (button) mutate('REMOVE_SITE_RULE', { hostname: button.dataset.hostname }, 'Rule removed. The website now uses the default mode.');
});
addSite.addEventListener('submit', event => {
  event.preventDefault();
  const hostname = newHostname.value.trim();
  if (!hostname) { newHostname.focus(); return; }
  mutate('SET_HOST_MODE', { hostname, mode: newMode.value }, 'Website rule saved.', () => {
    if (newHostname.value.trim() === hostname) newHostname.value = '';
  });
});
document.querySelector('#open-shortcuts').addEventListener('click', async () => {
  try { await request('OPEN_SHORTCUTS'); } catch (error) { showError(errorElement, error); }
});
document.querySelector('#export').addEventListener('click', async () => {
  clearError(errorElement);
  try {
    await queue;
    const response = await request('EXPORT_SETTINGS');
    const blob = new Blob([`${JSON.stringify(response.settings, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date();
    const dateLabel = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    link.href = url;
    link.download = `invert-colors-${dateLabel}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status.textContent = 'Settings exported.';
  } catch (error) { showError(errorElement, error); }
});
document.querySelector('#import').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  importFile.value = '';
  if (!file) return;
  clearError(errorElement);
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('The file is too large. The maximum size is 2 MB.');
    let imported;
    try { imported = JSON.parse(await file.text()); } catch { throw new Error('The file does not contain valid JSON.'); }
    await mutate('IMPORT_SETTINGS', { settings: imported }, 'Settings imported.');
  } catch (error) { showError(errorElement, error); }
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 100);
});
await refresh();
