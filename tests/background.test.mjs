import test from 'node:test';
import assert from 'node:assert/strict';

const event = () => {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
};
const area = () => {
  const data = {};
  return {
    data,
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: structuredClone(data[keys]) };
      if (keys === null || keys === undefined) return structuredClone(data);
      return Object.fromEntries(keys.map(key => [key, structuredClone(data[key])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  };
};

function mockChrome() {
  const tabs = new Map([
    [1, { id: 1, url: 'https://example.com/page', active: true }],
    [2, { id: 2, url: 'https://example.org/page', active: false }]
  ]);
  const docs = new Map([[1, 'first-document'], [2, 'second-document']]);
  const applied = [];
  const menus = [];
  const chrome = {
    runtime: {
      id: 'test-extension', getURL: part => `chrome-extension://test-extension/${part}`,
      onMessage: event(), onInstalled: event(), onStartup: event(), async openOptionsPage() {}
    },
    storage: { local: area(), session: area() },
    extension: { async isAllowedFileSchemeAccess() { return true; } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('Tab closed'); return structuredClone(tabs.get(id)); },
      async query(query) { return [...tabs.values()].filter(tab => !query.active || tab.active).map(tab => structuredClone(tab)); },
      async sendMessage(id, message, target) { applied.push({ id, message, target }); return { ok: true }; },
      async create() {},
      onUpdated: event(), onActivated: event(), onRemoved: event(), onReplaced: event()
    },
    webNavigation: {
      async getFrame({ tabId }) { return { documentId: docs.get(tabId), frameId: 0 }; },
      async getAllFrames({ tabId }) {
        return [{ documentId: docs.get(tabId), frameId: 0 }, { documentId: `child-${docs.get(tabId)}`, frameId: 7 }];
      },
      onCommitted: event()
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {}, onClicked: event() },
    commands: { async getAll() { return []; }, onCommand: event() },
    contextMenus: { async removeAll() { menus.length = 0; }, create(item) { menus.push(item); }, onClicked: event() },
    scripting: { async executeScript() {} }
  };
  return { chrome, tabs, docs, applied, menus };
}

test('worker lifecycle, multi-tab changes, frame identity and message authorization', async () => {
  const mock = mockChrome();
  globalThis.chrome = mock.chrome;
  await import(`../background.js?test=${Date.now()}`);
  const ui = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html', tab: { id: 99 } };
  const content = { id: 'test-extension', url: 'https://example.com/page', tab: { id: 1 }, frameId: 0, documentId: 'first-document' };
  const send = (type, values = {}, sender = ui) => new Promise(resolve => {
    mock.chrome.runtime.onMessage.listeners.at(-1)({ type, ...values }, sender, resolve);
  });
  const ok = async (type, values = {}, sender = ui) => {
    const response = await send(type, values, sender);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response;
  };
  mock.chrome.runtime.onInstalled.emit({ reason: 'install' });
  assert.equal((await ok('GET_SETTINGS')).settings.defaultMode, 'media');
  assert.equal(mock.menus.length, 6, 'flat action menu must respect the Chromium six-item limit');
  assert.ok(mock.menus.every(item => !item.parentId));
  await ok('SET_HOST_MODE', { hostname: 'example.com', mode: 'page' });
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.baseMode, 'page');
  assert.equal((await ok('GET_STATE', { tabId: 2 })).tab.baseMode, 'media');

  mock.applied.length = 0;
  await ok('SET_ENABLED', { enabled: false });
  for (const id of [1, 2]) {
    const messages = mock.applied.filter(item => item.id === id);
    assert.equal(messages.length, 2);
    assert.ok(messages.every(item => item.message.state.enabled === false));
    assert.equal(messages.filter(item => item.message.state.topFrame).length, 1);
  }
  await ok('SET_ENABLED', { enabled: true });
  assert.equal((await ok('TOGGLE_TEMPORARY', { tabId: 1 })).tab.temporary, true);
  assert.equal((await ok('GET_FRAME_STATE', {}, content)).state.temporary, true);

  // Simulate a new worker instance while preserving Chrome storage and documents.
  const clearEvents = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.listeners)) value.listeners.length = 0;
    else for (const child of Object.values(value)) clearEvents(child);
  };
  clearEvents(mock.chrome);
  await import(`../background.js?restart=${Date.now()}`);
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.temporary, true);
  assert.equal((await ok('TOGGLE_TEMPORARY', { tabId: 1 })).tab.temporary, false);

  const savedBeforeDisable = (await ok('GET_SETTINGS')).settings;
  mock.applied.length = 0;
  const disabled = await ok('TOGGLE_TEMPORARY_DISABLED', { tabId: 1 });
  assert.equal(disabled.tab.temporarilyDisabled, true);
  assert.equal(disabled.tab.temporary, false);
  assert.ok(mock.applied.every(item => item.id === 1 && item.message.state.enabled === false));
  assert.equal((await ok('GET_STATE', { tabId: 2 })).tab.temporarilyDisabled, false);
  assert.equal((await ok('GET_FRAME_STATE', {}, content)).state.enabled, false);
  assert.deepEqual((await ok('GET_SETTINGS')).settings, savedBeforeDisable);
  clearEvents(mock.chrome);
  await import(`../background.js?disabled-restart=${Date.now()}`);
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.temporarilyDisabled, true, 'worker restart retains temporary disable');
  assert.equal((await ok('GET_FRAME_STATE', {}, content)).state.enabled, false);
  const inverted = await ok('TOGGLE_TEMPORARY', { tabId: 1 });
  assert.equal(inverted.tab.temporarilyDisabled, false);
  assert.equal(inverted.tab.temporary, true);
  assert.equal((await ok('TOGGLE_TEMPORARY_DISABLED', { tabId: 1 })).tab.temporary, false);
  assert.equal((await ok('RESET_TEMPORARY', { tabId: 1 })).tab.temporarilyDisabled, false);
  await ok('TOGGLE_TEMPORARY_DISABLED', { tabId: 1 });
  assert.equal((await ok('TOGGLE_TEMPORARY_DISABLED', { tabId: 1 })).tab.temporarilyDisabled, false, 'second click restores the base mode');

  const savedBeforeWhole = (await ok('GET_SETTINGS')).settings;
  assert.equal((await ok('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: 1 })).tab.temporaryWholePage, true);
  const forced = (await ok('GET_FRAME_STATE', {}, content)).state;
  assert.equal(forced.mode, 'page');
  assert.equal(forced.temporary, false);
  clearEvents(mock.chrome);
  await import(`../background.js?whole-page-restart=${Date.now()}`);
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.temporaryWholePage, true, 'worker restart retains temporary whole-page');
  assert.equal((await ok('TOGGLE_TEMPORARY_DISABLED', { tabId: 1 })).tab.temporaryWholePage, false);
  const wholeFromDisabled = (await ok('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: 1 })).tab;
  assert.equal(wholeFromDisabled.temporaryWholePage, true);
  assert.equal(wholeFromDisabled.temporarilyDisabled, false);
  assert.equal((await ok('TOGGLE_TEMPORARY', { tabId: 1 })).tab.temporaryWholePage, false);
  assert.equal((await ok('RESET_TEMPORARY', { tabId: 1 })).tab.temporaryWholePage, false);
  await ok('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: 1 });
  assert.equal((await ok('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: 1 })).tab.temporaryWholePage, false);
  assert.deepEqual((await ok('GET_SETTINGS')).settings, savedBeforeWhole);

  await ok('TOGGLE_TEMPORARY', { tabId: 1 });
  mock.docs.set(1, 'reloaded-document');
  content.documentId = 'reloaded-document';
  // Even if the navigation event has not arrived, a new document never inherits the old toggle.
  assert.equal((await ok('GET_FRAME_STATE', {}, content)).state.temporary, false);
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.baseMode, 'page');
  await ok('TOGGLE_TEMPORARY', { tabId: 1 });
  assert.equal((await send('GET_FRAME_STATE', {}, { ...content, documentId: 'first-document' })).ok, false);
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.temporary, true, 'outgoing document must not delete the current document toggle');
  await ok('RESET_TEMPORARY', { tabId: 1 });
  mock.chrome.contextMenus.onClicked.emit({ menuItemId: 'temporary' }, mock.tabs.get(1));
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.temporary, true, 'context menu toggles temporary inversion');
  mock.chrome.contextMenus.onClicked.emit({ menuItemId: 'temporary' }, mock.tabs.get(1));
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.temporary, false);

  // Missing content scripts can be recovered after an activeTab permission grant.
  const originalSend = mock.chrome.tabs.sendMessage;
  const originalInject = mock.chrome.scripting.executeScript;
  let missing = true;
  const injected = [];
  mock.chrome.tabs.sendMessage = async (...args) => {
    if (missing) throw new Error('Receiving end does not exist');
    return originalSend(...args);
  };
  mock.chrome.scripting.executeScript = async options => {
    injected.push(options.files[0]);
    if (options.files[0] === 'content.js') missing = false;
  };
  await ok('SET_SITE_MODE', { tabId: 1, mode: 'media' });
  assert.ok(injected.includes('content.js'));
  mock.chrome.tabs.sendMessage = async () => { throw new Error('Permission denied'); };
  mock.chrome.scripting.executeScript = async () => { throw new Error('Permission denied'); };
  assert.equal((await send('TOGGLE_TEMPORARY', { tabId: 1 })).ok, false);
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.temporary, false, 'failed toggle must roll back session state');
  assert.equal((await send('TOGGLE_TEMPORARY_DISABLED', { tabId: 1 })).ok, false);
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.temporarilyDisabled, false, 'failed disable must roll back session state');
  assert.equal((await send('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: 1 })).ok, false);
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.temporaryWholePage, false, 'failed whole-page must roll back session state');
  mock.chrome.tabs.sendMessage = originalSend;
  mock.chrome.scripting.executeScript = originalInject;

  await ok('SET_HOST_MODE', { hostname: 'example.org', mode: 'off' });
  await ok('SET_SITE_MODE', { tabId: 1, mode: 'default' });
  assert.equal((await ok('GET_STATE', { tabId: 1 })).tab.hasRule, false);
  assert.equal((await ok('GET_STATE', { tabId: 2 })).tab.baseMode, 'off');
  const before = (await ok('EXPORT_SETTINGS')).settings;
  const invalid = await send('IMPORT_SETTINGS', { settings: { ...before, version: 99 } });
  assert.equal(invalid.ok, false);
  assert.deepEqual((await ok('GET_SETTINGS')).settings, before);
  assert.equal((await send('SET_HOST_MODE', { hostname: '...', mode: 'page' })).ok, false);
  assert.deepEqual((await ok('GET_SETTINGS')).settings, before);

  const rejected = await send('SET_ENABLED', { enabled: false }, content);
  assert.equal(rejected.ok, false);
  assert.equal((await ok('GET_SETTINGS')).settings.enabled, true);
  assert.equal((await send('GET_FRAME_STATE', {}, { id: 'external-extension' })).ok, false);
});
