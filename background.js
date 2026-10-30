import {
  SETTINGS_KEY, MODES, MODE_LABELS, defaultSettings, validateSettings, patchSettings,
  withSiteMode, siteKey, isSupportedUrl, resolveMode, renderState
} from './model.js';

// Serialize read-modify-write operations. Storage, not the worker lifetime, owns state.
let pending = Promise.resolve();
function enqueue(task) {
  const result = pending.then(task);
  pending = result.catch(error => console.warn('Invert colors:', error.message));
  return result;
}
const temporaryKey = id => `temporary:${id}`;
const ownPage = sender => sender.id === chrome.runtime.id &&
  typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return stored[SETTINGS_KEY] ? validateSettings(stored[SETTINGS_KEY]) : defaultSettings();
}

async function nextRevision() {
  const { revision = 0 } = await chrome.storage.session.get('revision');
  const value = Math.max(Date.now(), revision + 1);
  await chrome.storage.session.set({ revision: value });
  return value;
}

async function getTab(tabId) {
  if (Number.isInteger(tabId) && tabId >= 0) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab was found.');
  return tab;
}

async function mainDocument(tabId) {
  try {
    return await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  } catch { return null; }
}

async function temporaryState(tabId, documentId) {
  const key = temporaryKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  const normal = { active: false, disabled: false, wholePage: false };
  if (!stored?.active && !stored?.disabled && !stored?.wholePage) return normal;
  // Document identity also protects against races between document_start and onCommitted.
  if (documentId && stored.documentId !== documentId) {
    await chrome.storage.session.remove(key);
    return normal;
  }
  const disabled = stored.disabled === true;
  const wholePage = !disabled && stored.wholePage === true;
  return { active: !disabled && !wholePage && stored.active === true, disabled, wholePage };
}

async function supportedTab(tab) {
  if (!isSupportedUrl(tab.url)) return false;
  if (tab.url.startsWith('file:')) return chrome.extension.isAllowedFileSchemeAccess();
  return true;
}

async function setBadge(tab, settings, temporary, supported = true, temporarilyDisabled = false, temporaryWholePage = false) {
  if (!Number.isInteger(tab.id)) return;
  const mode = resolveMode(settings, tab.url);
  const label = !supported ? '—' : !settings.enabled || temporarilyDisabled ? 'Ⅱ' : temporaryWholePage ? 'P*' : temporary ? '↔' : { media: 'M', page: 'P', off: '' }[mode];
  const title = !supported ? 'Invert colors — extensions cannot change this page' :
    `Invert colors — ${!settings.enabled ? 'Paused' : temporarilyDisabled ? 'Temporarily disabled in this tab' : temporaryWholePage ? 'Whole page temporarily' : MODE_LABELS[mode]}${temporary ? ' · temporary inversion' : ''}`;
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId: tab.id, text: label }),
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: temporary ? '#7c3f07' : '#2054a5' }),
    chrome.action.setTitle({ tabId: tab.id, title })
  ]);
}

async function applyTab(tab, settings, revision) {
  const supported = await supportedTab(tab);
  const main = supported ? await mainDocument(tab.id) : null;
  const temporary = await temporaryState(tab.id, main?.documentId);
  await setBadge(tab, settings, temporary.active, supported, temporary.disabled, temporary.wholePage);
  if (!supported) return { applied: false, supported: false };
  let frames;
  try { frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }); }
  catch { return { applied: false, supported: true }; }
  const results = await Promise.allSettled((frames || []).map(async frame => {
    const state = renderState(settings, tab.url, temporary.active, frame.frameId === 0, revision, temporary.disabled, temporary.wholePage);
    const target = frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId };
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'APPLY_STATE', state }, target);
    } catch {
      // activeTab can grant access after a document loaded without our scripts.
      const injectionTarget = frame.documentId ? { tabId: tab.id, documentIds: [frame.documentId] } : { tabId: tab.id, frameIds: [frame.frameId] };
      try {
        await chrome.scripting.executeScript({ target: injectionTarget, files: ['shadow-hook.js'], world: 'MAIN' });
      } catch { /* An open-shadow hook is optional; media still work without it. */ }
      await chrome.scripting.executeScript({ target: injectionTarget, files: ['content.js'] });
      response = await chrome.tabs.sendMessage(tab.id, { type: 'APPLY_STATE', state }, target);
    }
    return { topFrame: frame.frameId === 0, applied: response?.ok === true };
  }));
  return {
    supported: true,
    applied: results.some(result => result.status === 'fulfilled' && result.value.topFrame && result.value.applied)
  };
}

async function refreshAllTabs(settings = null) {
  settings ||= await loadSettings();
  const revision = await nextRevision();
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => applyTab(tab, settings, revision)));
}

async function stateForTab(tabId) {
  const tab = await getTab(tabId);
  const settings = await loadSettings();
  const main = await mainDocument(tab.id);
  const temporary = await temporaryState(tab.id, main?.documentId);
  const supported = await supportedTab(tab);
  return {
    ok: true,
    settings,
    tab: {
      id: tab.id, url: tab.url || '', hostname: siteKey(tab.url) || '', supported,
      mode: resolveMode(settings, tab.url), baseMode: resolveMode(settings, tab.url),
      hasRule: Object.hasOwn(settings.sites, siteKey(tab.url)), temporary: temporary.active,
      temporarilyDisabled: temporary.disabled, temporaryWholePage: temporary.wholePage, enabled: settings.enabled
    },
    commands: await chrome.commands.getAll()
  };
}

async function saveSettings(settings) {
  const valid = validateSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: valid });
  await refreshAllTabs(valid);
  return { ok: true, settings: valid };
}

async function requireSupportedTab(tabId) {
  const tab = await getTab(tabId);
  if (!await supportedTab(tab)) {
    throw new Error('This page does not allow extensions to change its colors. For local files, enable file URL access in the extension details.');
  }
  return tab;
}

async function changeTemporary(tabId, choice) {
  const tab = await requireSupportedTab(tabId);
  const settings = await loadSettings();
  if (!settings.enabled && choice !== 'reset') throw new Error('Enable Invert colors first.');
  const main = await mainDocument(tab.id);
  if (!main?.documentId && choice !== 'reset') throw new Error('The page is still loading. Try again in a moment.');
  const key = temporaryKey(tab.id);
  const current = await temporaryState(tab.id, main?.documentId);
  const previous = (await chrome.storage.session.get(key))[key];
  const active = choice === 'invert' && !current.active;
  const disabled = choice === 'disable' && !current.disabled;
  const wholePage = choice === 'whole-page' && !current.wholePage;
  if (active || disabled || wholePage) await chrome.storage.session.set({ [key]: { active, disabled, wholePage, documentId: main.documentId } });
  else await chrome.storage.session.remove(key);
  const result = await applyTab(tab, settings, await nextRevision());
  if (!result.applied) {
    if (previous) await chrome.storage.session.set({ [key]: previous });
    else await chrome.storage.session.remove(key);
    await setBadge(tab, settings, current.active, true, current.disabled, current.wholePage);
    throw new Error('Could not apply the mode. Check this extension\'s access to the site and reload the page.');
  }
  return stateForTab(tab.id);
}

async function toggleTemporary(tabId, reset = false) {
  return changeTemporary(tabId, reset ? 'reset' : 'invert');
}

async function setSiteMode(tabId, mode) {
  const tab = await requireSupportedTab(tabId);
  const current = await loadSettings();
  const result = await applyTab(tab, current, await nextRevision());
  if (!result.applied) throw new Error('Site access is unavailable. Allow this extension to access the site and reload the page.');
  const settings = withSiteMode(current, siteKey(tab.url), mode);
  await chrome.storage.session.remove(temporaryKey(tab.id));
  await saveSettings(settings);
  return stateForTab(tab.id);
}

async function frameState(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id)) {
    throw new Error('Invalid request source.');
  }
  const tab = await chrome.tabs.get(sender.tab.id);
  const settings = await loadSettings();
  const main = await mainDocument(tab.id);
  if (sender.frameId === 0 && main?.documentId && sender.documentId && main.documentId !== sender.documentId) {
    return { ok: false, error: 'The request came from an outdated document.' };
  }
  const temporary = await temporaryState(tab.id, main?.documentId);
  const supported = await supportedTab(tab);
  const state = renderState(settings, tab.url, temporary.active, sender.frameId === 0, await nextRevision(), temporary.disabled, temporary.wholePage);
  state.enabled &&= supported;
  if (sender.frameId === 0) await setBadge(tab, settings, temporary.active, supported, temporary.disabled, temporary.wholePage);
  return { ok: true, state };
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('Invalid command.');
  if (message.type === 'GET_FRAME_STATE' || message.type === 'FRAME_READY') return frameState(sender);
  // A page's content script may request its state, never change global or saved settings.
  if (!ownPage(sender)) throw new Error('This command is only available from the extension interface.');
  switch (message.type) {
    case 'GET_STATE': return stateForTab(message.tabId);
    case 'GET_SETTINGS':
    case 'EXPORT_SETTINGS': return { ok: true, settings: await loadSettings() };
    case 'SET_SITE_MODE': return setSiteMode(message.tabId, message.mode);
    case 'TOGGLE_TEMPORARY': return toggleTemporary(message.tabId);
    case 'TOGGLE_TEMPORARY_DISABLED': return changeTemporary(message.tabId, 'disable');
    case 'TOGGLE_TEMPORARY_WHOLE_PAGE': return changeTemporary(message.tabId, 'whole-page');
    case 'RESET_TEMPORARY': return toggleTemporary(message.tabId, true);
    case 'SET_ENABLED': {
      if (typeof message.enabled !== 'boolean') throw new Error('Invalid extension enabled state.');
      return saveSettings({ ...await loadSettings(), enabled: message.enabled });
    }
    case 'UPDATE_SETTINGS': return saveSettings(patchSettings(await loadSettings(), message.patch));
    case 'SET_HOST_MODE': return saveSettings(withSiteMode(await loadSettings(), message.hostname, message.mode));
    case 'REMOVE_SITE_RULE': return saveSettings(withSiteMode(await loadSettings(), message.hostname, 'default'));
    case 'IMPORT_SETTINGS': return saveSettings(validateSettings(message.settings));
    case 'OPEN_SHORTCUTS': {
      // chrome:// aliases are also understood by Brave; no user-agent sniffing required.
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      return { ok: true };
    }
    default: throw new Error('Unknown command.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueue(() => handleMessage(message, sender)).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function createMenus() {
  await chrome.contextMenus.removeAll();
  // Chromium permits at most six top-level items in an action's context menu.
  chrome.contextMenus.create({ id: 'temporary', title: 'Temporarily invert tab colors', contexts: ['action'] });
  for (const mode of MODES) {
    chrome.contextMenus.create({ id: `mode:${mode}`, title: `Site mode: ${MODE_LABELS[mode]}`, contexts: ['action'] });
  }
  chrome.contextMenus.create({ id: 'enabled', title: 'Enable / pause in all tabs', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'options', title: 'Invert colors settings', contexts: ['action'] });
}

async function initialize(inject = false) {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) await chrome.storage.local.set({ [SETTINGS_KEY]: defaultSettings() });
  await createMenus();
  if (inject) {
    // Existing documents do not receive newly installed static content scripts automatically.
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.filter(tab => isSupportedUrl(tab.url)).map(async tab => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['shadow-hook.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
    }));
  }
  await refreshAllTabs();
}

chrome.runtime.onInstalled.addListener(() => { void enqueue(() => initialize(true)); });
chrome.runtime.onStartup.addListener(() => { void enqueue(() => initialize()); });

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  void enqueue(async () => {
    const main = await mainDocument(details.tabId);
    if (main?.documentId && main.documentId !== details.documentId) return;
    // Never clear a temporary choice already made for the newly committed document.
    const key = temporaryKey(details.tabId);
    const stored = (await chrome.storage.session.get(key))[key];
    if (stored && stored.documentId !== details.documentId) await chrome.storage.session.remove(key);
    try { await applyTab(await chrome.tabs.get(details.tabId), await loadSettings(), await nextRevision()); }
    catch { /* Tab may have closed during navigation. */ }
  });
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'complete' && !change.url) return;
  void enqueue(async () => { await applyTab(tab, await loadSettings(), await nextRevision()); });
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void enqueue(async () => {
    try {
      const state = await stateForTab(tabId);
      await setBadge(await chrome.tabs.get(tabId), state.settings, state.tab.temporary, state.tab.supported, state.tab.temporarilyDisabled, state.tab.temporaryWholePage);
    } catch { /* Tab may have closed. */ }
  });
});
chrome.tabs.onRemoved.addListener(tabId => { void enqueue(() => chrome.storage.session.remove(temporaryKey(tabId))); });
chrome.tabs.onReplaced.addListener((_added, removed) => { void enqueue(() => chrome.storage.session.remove(temporaryKey(removed))); });

async function runAction(action, tabId) {
  switch (action) {
    case 'toggle-temporary': return toggleTemporary(tabId);
    case 'cycle-site-mode': {
      const tab = await requireSupportedTab(tabId);
      const settings = await loadSettings();
      const mode = resolveMode(settings, tab.url);
      return setSiteMode(tab.id, MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    }
    case 'toggle-enabled': {
      const settings = await loadSettings();
      return saveSettings({ ...settings, enabled: !settings.enabled });
    }
    default: return null;
  }
}
chrome.commands.onCommand.addListener((command, tab) => { void enqueue(() => runAction(command, tab?.id)); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void enqueue(async () => {
    if (info.menuItemId === 'temporary') return toggleTemporary(tab?.id);
    if (info.menuItemId === 'enabled') return runAction('toggle-enabled');
    if (info.menuItemId === 'options') return chrome.runtime.openOptionsPage();
    if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('mode:')) {
      return setSiteMode(tab?.id, info.menuItemId.slice(5));
    }
  });
});
