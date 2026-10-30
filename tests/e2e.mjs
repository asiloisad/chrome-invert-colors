/** Real Chromium integration tests. A fresh temporary profile never uses your browsing profile.
 * Run: node tests/e2e.mjs
 * Uses Playwright's full bundled Chromium by default (npx playwright install chromium).
 * Optional: BROWSER_PATH, PLAYWRIGHT_MODULE, SHARP_MODULE, KEEP_TEST_PROFILE=1.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function dependency(name, override) {
  return require(override || name);
}
const { chromium } = dependency('playwright', process.env.PLAYWRIGHT_MODULE);
const sharp = dependency('sharp', process.env.SHARP_MODULE);
const executable = process.env.BROWSER_PATH;
if (executable) {
  try { await stat(executable); }
  catch { throw new Error(`Browser not found: ${executable}. Set BROWSER_PATH to an installed Brave or Chromium executable, or unset it to use Playwright's bundled Chromium.`); }
}

const fixtureFiles = new Map([
  ['/page.html', ['page.html', 'text/html; charset=utf-8']],
  ['/frame.html', ['frame.html', 'text/html; charset=utf-8']],
  ['/swatch.svg', ['swatch.svg', 'image/svg+xml']],
]);
const server = http.createServer(async (request, response) => {
  const match = fixtureFiles.get(new URL(request.url, 'http://localhost').pathname);
  if (!match) { response.writeHead(404).end(); return; }
  try {
    response.writeHead(200, { 'Content-Type': match[1], 'Cache-Control': 'no-store' });
    response.end(await readFile(path.join(root, 'tests/fixtures', match[0])));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const profile = await mkdtemp(path.join(os.tmpdir(), 'invert-colors-e2e-'));
let context;
let control;
let passed = 0;
const failures = [];

async function test(name, body) {
  try { await body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error }); console.error(`FAIL ${name}\n${error.stack || error}`); }
}
async function command(type, payload = {}) {
  const result = await control.evaluate(async message => chrome.runtime.sendMessage(message), { type, ...payload });
  assert.equal(result?.ok, true, `${type}: ${JSON.stringify(result)}`);
  return result;
}
async function tabId(page) {
  const tabs = await control.evaluate(async () => chrome.tabs.query({}));
  const tab = tabs.find(item => item.url === page.url());
  assert.ok(tab, `No tab for ${page.url()}`);
  return tab.id;
}
async function state(page, mode) { return command('SET_SITE_MODE', { tabId: await tabId(page), mode }); }
async function waitFilter(frame, selector, wanted) {
  await frame.waitForFunction(({ selector, wanted }) => {
    const node = document.querySelector(selector);
    if (!node) return false;
    const value = getComputedStyle(node).filter;
    const inverted = /invert\((?:1(?:\.0*)?|100%)\)/.test(value);
    return wanted ? inverted : !inverted;
  }, { selector, wanted }, { timeout: 10000 });
}
async function waitShadowFilter(page, host, selector, wanted) {
  await page.waitForFunction(({ host, selector, wanted }) => {
    const node = document.querySelector(host)?.shadowRoot?.querySelector(selector);
    if (!node) return false;
    const inverted = /invert\((?:1(?:\.0*)?|100%)\)/.test(getComputedStyle(node).filter);
    return inverted === wanted;
  }, { host, selector, wanted }, { timeout: 10000 });
}
async function frameFor(page, selector) {
  const frame = await (await page.waitForSelector(selector)).contentFrame();
  assert.ok(frame, `Missing frame ${selector}`);
  await frame.waitForSelector('img');
  return frame;
}
async function pixel(page, selector, expected) {
  const buffer = await page.locator(selector).screenshot({ animations: 'disabled' });
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const index = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  const actual = [...data.subarray(index, index + 3)];
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= 2), `${selector} pixel ${actual}, expected ${expected}`);
}

try {
  context = await chromium.launchPersistentContext(profile, {
    // Full Chromium supports extensions in headless mode; the headless shell does not.
    ...(executable ? { executablePath: executable } : { channel: 'chromium' }),
    headless: true,
    viewport: { width: 1100, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run', '--no-default-browser-check'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/popup.html`);
  await command('UPDATE_SETTINGS', { patch: { defaultMode: 'media', media: { images: true, video: true, canvas: true, svg: true, backgrounds: true } } });
  await command('SET_ENABLED', { enabled: true });
  const page = await context.newPage();
  await page.goto(`${origin}/page.html?primary`, { waitUntil: 'load' });
  const same = await frameFor(page, '#same-frame');
  const cross = await frameFor(page, '#cross-frame');

  await test('toolbar action opens the panel on a left click', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.action.default_popup, 'popup.html');
    assert.ok(Number(manifest.minimum_chrome_version) >= 120);
    assert.ok(Object.values(manifest.commands || {}).every(command => !Object.hasOwn(command, 'suggested_key')), 'Commands must not assign default shortcuts');
    const commands = await control.evaluate(async () => chrome.commands.getAll());
    assert.ok(commands.every(command => !command.shortcut), 'A fresh profile must have no assigned shortcuts');
    assert.equal(await control.evaluate(async tabId => chrome.action.getPopup({ tabId }), await tabId(page)), `chrome-extension://${extensionId}/popup.html`);
    assert.equal(await control.evaluate(() => chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT), 6);
  });

  await test('media mode inverts media once, preserves surrounding page and author filters', async () => {
    for (const selector of ['#image', '#video', '#canvas', '#svg', '#nested', '#background', '#background-inner']) await waitFilter(page, selector, true);
    await waitFilter(page, 'html', false);
    await waitFilter(page, '.logo', false);
    await pixel(page, '#image', [235, 155, 35]);
    await pixel(page, '#nested', [235, 155, 35]);
    await pixel(page, '#text-swatch', [20, 100, 220]);
    const author = await page.locator('#author').evaluate(node => getComputedStyle(node).filter);
    assert.match(author, /opacity\(0\.8\)/);
    assert.match(author, /invert\(1\)/);
    assert.match(await page.locator('#author-important').evaluate(node => getComputedStyle(node).filter), /sepia\(0\.3\).*invert\(1\)/);
  });

  await test('background compensation skips text, generated content and parent containers', async () => {
    for (const selector of ['#background-text', '#background-pseudo', '#background-parent']) await waitFilter(page, selector, false);
    await waitFilter(page, '#background-inner', true);
    await pixel(page, '#background-inner', [235, 155, 35]);
  });

  await test('same-origin and cross-origin iframe images receive media compensation', async () => {
    await waitFilter(same, '#frame-image', true);
    await waitFilter(cross, '#frame-image', true);
    await waitFilter(same, 'html', false);
    await waitFilter(cross, 'html', false);
  });

  await test('open shadow DOM, dynamic media, dynamic frames and srcdoc receive the current mode', async () => {
    await waitShadowFilter(page, '#shadow-host', '#shadow-image', true);
    await page.evaluate(() => {
      document.querySelector('#late-shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<img id="late-image" src="/swatch.svg" width="64" height="64">';
    });
    await waitShadowFilter(page, '#late-shadow-host', '#late-image', true);
    await page.evaluate(() => window.addFixtures());
    await waitFilter(page, '#dynamic-image', true);
    await waitShadowFilter(page, '#dynamic-shadow', '#dynamic-shadow-image', true);
    await waitFilter(await frameFor(page, '#dynamic-frame'), '#frame-image', true);
    await waitFilter(await frameFor(page, '#srcdoc-frame'), '#srcdoc-image', true);
  });

  await test('author inline filter changes remain composed and are retained for restoration', async () => {
    await page.locator('#author-live').evaluate(node => node.style.setProperty('filter', 'contrast(.7)', 'important'));
    await page.waitForFunction(() => /contrast\(0\.7\).*invert\(1\)/.test(getComputedStyle(document.querySelector('#author-live')).filter));
    await page.locator('#author-class').evaluate(node => node.classList.add('desaturated'));
    await page.waitForFunction(() => /grayscale\(0\.4\).*invert\(1\)/.test(getComputedStyle(document.querySelector('#author-class')).filter));
    await page.locator('#author-class').evaluate(node => node.classList.remove('desaturated'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#author-class')).filter === 'invert(1)');
  });

  await test('page mode clears media filters throughout frames and shadows to avoid two inversions', async () => {
    await state(page, 'page');
    await waitFilter(page, 'html', true);
    for (const selector of ['#image', '#nested', '#video', '#canvas', '#svg', '#background']) await waitFilter(page, selector, false);
    await waitFilter(same, '#frame-image', false);
    await waitFilter(cross, '#frame-image', false);
    await waitFilter(same, 'html', false);
    await waitShadowFilter(page, '#shadow-host', '#shadow-image', false);
    await pixel(page, '#image', [235, 155, 35]);
    await pixel(page, '#nested', [235, 155, 35]);
    await pixel(page, '#text-swatch', [235, 155, 35]);
  });

  await test('temporary page inversion toggles independently and leaves saved media mode intact', async () => {
    await state(page, 'media');
    await command('TOGGLE_TEMPORARY', { tabId: await tabId(page) });
    await waitFilter(page, 'html', true);
    await waitFilter(page, '#image', true);
    await pixel(page, '#image', [20, 100, 220]);
    await pixel(page, '#text-swatch', [235, 155, 35]);
    await command('TOGGLE_TEMPORARY', { tabId: await tabId(page) });
    await waitFilter(page, 'html', false);
    await pixel(page, '#image', [235, 155, 35]);
    await state(page, 'page');
    await command('TOGGLE_TEMPORARY', { tabId: await tabId(page) });
    await waitFilter(page, 'html', false);
    await waitFilter(page, '#image', false);
    await pixel(page, '#image', [20, 100, 220]);
    await command('RESET_TEMPORARY', { tabId: await tabId(page) });
    await waitFilter(page, 'html', true);
  });

  await test('off restores original page filters, including author important declarations', async () => {
    await state(page, 'off');
    await waitFilter(page, 'html', false);
    await waitFilter(page, '#image', false);
    await waitFilter(cross, '#frame-image', false);
    await waitShadowFilter(page, '#shadow-host', '#shadow-image', false);
    assert.equal(await page.locator('#author').evaluate(node => getComputedStyle(node).filter), 'opacity(0.8)');
    assert.equal(await page.locator('#author-important').evaluate(node => getComputedStyle(node).filter), 'sepia(0.3)');
    assert.equal(await page.locator('#author-parent').evaluate(node => getComputedStyle(node).filter), 'opacity(0.9)');
    assert.equal(await page.locator('#author-live').evaluate(node => getComputedStyle(node).filter), 'contrast(0.7)');
    assert.equal(await page.locator('#author-live').evaluate(node => node.style.getPropertyPriority('filter')), 'important');
    await pixel(page, '#image', [20, 100, 220]);
  });

  await test('temporary inversion clears on reload, while the saved host rule remains', async () => {
    await state(page, 'media');
    await command('TOGGLE_TEMPORARY', { tabId: await tabId(page) });
    await waitFilter(page, 'html', true);
    await page.reload({ waitUntil: 'load' });
    await waitFilter(page, 'html', false);
    await waitFilter(page, '#image', true);
  });

  await test('temporary disable restores only this tab, its frames and shadows without changing settings', async () => {
    await state(page, 'media');
    const id = await tabId(page);
    const saved = (await command('GET_SETTINGS')).settings;
    const second = await context.newPage();
    try {
      await second.goto(`${origin}/page.html?temporary-disable-peer`, { waitUntil: 'load' });
      await waitFilter(second, '#image', true);
      await command('TOGGLE_TEMPORARY_DISABLED', { tabId: id });
      await waitFilter(page, 'html', false);
      await waitFilter(page, '#image', false);
      await waitFilter(await frameFor(page, '#same-frame'), '#frame-image', false);
      await waitFilter(await frameFor(page, '#cross-frame'), '#frame-image', false);
      await waitShadowFilter(page, '#shadow-host', '#shadow-image', false);
      assert.equal(await page.locator('#author').evaluate(node => getComputedStyle(node).filter), 'opacity(0.8)');
      assert.equal(await page.locator('#author-important').evaluate(node => getComputedStyle(node).filter), 'sepia(0.3)');
      await pixel(page, '#image', [20, 100, 220]);
      await waitFilter(second, '#image', true);
      const disabled = await command('GET_STATE', { tabId: id });
      assert.equal(disabled.tab.temporarilyDisabled, true);
      assert.equal(disabled.tab.temporary, false);
      assert.deepEqual(disabled.settings, saved);

      await command('TOGGLE_TEMPORARY_DISABLED', { tabId: id });
      await waitFilter(page, '#image', true);
      await waitFilter(await frameFor(page, '#cross-frame'), '#frame-image', true);
      await waitShadowFilter(page, '#shadow-host', '#shadow-image', true);
      assert.equal((await command('GET_STATE', { tabId: id })).tab.temporarilyDisabled, false);

      await command('TOGGLE_TEMPORARY_DISABLED', { tabId: id });
      await command('TOGGLE_TEMPORARY', { tabId: id });
      await waitFilter(page, 'html', true);
      await waitFilter(page, '#image', true);
      const inverted = await command('GET_STATE', { tabId: id });
      assert.equal(inverted.tab.temporarilyDisabled, false);
      assert.equal(inverted.tab.temporary, true);
      assert.deepEqual(inverted.settings, saved);

      // Disabling replaces an active inversion, and either reset or a saved mode clears it.
      await command('TOGGLE_TEMPORARY_DISABLED', { tabId: id });
      await waitFilter(page, 'html', false);
      await waitFilter(page, '#image', false);
      assert.equal((await command('GET_STATE', { tabId: id })).tab.temporary, false);
      await command('RESET_TEMPORARY', { tabId: id });
      await waitFilter(page, '#image', true);
      await command('TOGGLE_TEMPORARY_DISABLED', { tabId: id });
      await state(page, 'media');
      await waitFilter(page, '#image', true);
      assert.equal((await command('GET_STATE', { tabId: id })).tab.temporarilyDisabled, false);
    } finally {
      await command('RESET_TEMPORARY', { tabId: id });
      await second.close();
    }
  });

  await test('temporary disable survives global pause and clears when its document reloads', async () => {
    const id = await tabId(page);
    try {
      await command('TOGGLE_TEMPORARY_DISABLED', { tabId: id });
      await waitFilter(page, '#image', false);
      await command('SET_ENABLED', { enabled: false });
      assert.equal((await command('GET_STATE', { tabId: id })).tab.temporarilyDisabled, true);
      await command('SET_ENABLED', { enabled: true });
      await waitFilter(page, '#image', false);
      assert.equal((await command('GET_STATE', { tabId: id })).tab.temporarilyDisabled, true);
      await page.reload({ waitUntil: 'load' });
      await waitFilter(page, '#image', true);
      await waitFilter(await frameFor(page, '#cross-frame'), '#frame-image', true);
      const restored = await command('GET_STATE', { tabId: id });
      assert.equal(restored.tab.temporarilyDisabled, false);
      assert.equal(restored.tab.temporary, false);
      assert.equal(restored.tab.baseMode, 'media');
    } finally {
      await command('SET_ENABLED', { enabled: true });
      await command('RESET_TEMPORARY', { tabId: id });
    }
  });

  await test('temporary whole-page mode overrides saved modes and clears media filters without saving', async () => {
    await state(page, 'media');
    const id = await tabId(page);
    const saved = (await command('GET_SETTINGS')).settings;
    try {
      await command('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: id });
      await waitFilter(page, 'html', true);
      await waitFilter(page, '#image', false);
      await waitFilter(await frameFor(page, '#same-frame'), '#frame-image', false);
      await waitFilter(await frameFor(page, '#cross-frame'), '#frame-image', false);
      await waitShadowFilter(page, '#shadow-host', '#shadow-image', false);
      await pixel(page, '#image', [235, 155, 35]);
      await pixel(page, '#text-swatch', [235, 155, 35]);
      const whole = (await command('GET_STATE', { tabId: id })).tab;
      assert.equal(whole.temporaryWholePage, true);
      assert.equal(whole.temporarilyDisabled, false);
      assert.equal(whole.temporary, false);
      assert.deepEqual((await command('GET_SETTINGS')).settings, saved);
      await command('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: id });
      await waitFilter(page, 'html', false);
      await waitFilter(page, '#image', true);
      await waitShadowFilter(page, '#shadow-host', '#shadow-image', true);

      await command('TOGGLE_TEMPORARY_DISABLED', { tabId: id });
      await waitFilter(page, '#image', false);
      await command('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: id });
      await waitFilter(page, 'html', true);
      assert.equal((await command('GET_STATE', { tabId: id })).tab.temporarilyDisabled, false);
      await command('TOGGLE_TEMPORARY', { tabId: id });
      await waitFilter(page, '#image', true);
      await pixel(page, '#image', [20, 100, 220]);
      const inverted = (await command('GET_STATE', { tabId: id })).tab;
      assert.equal(inverted.temporaryWholePage, false);
      assert.equal(inverted.temporary, true);
      await command('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: id });
      await command('TOGGLE_TEMPORARY_DISABLED', { tabId: id });
      await waitFilter(page, 'html', false);
      await waitFilter(page, '#image', false);
      const disabled = (await command('GET_STATE', { tabId: id })).tab;
      assert.equal(disabled.temporaryWholePage, false);
      assert.equal(disabled.temporarilyDisabled, true);
      await command('RESET_TEMPORARY', { tabId: id });
      await waitFilter(page, '#image', true);
      assert.deepEqual((await command('GET_SETTINGS')).settings, saved);

      for (const mode of ['off', 'page']) {
        await state(page, mode);
        await command('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: id });
        await waitFilter(page, 'html', true);
        await waitFilter(page, '#image', false);
        assert.equal((await command('GET_STATE', { tabId: id })).tab.temporaryWholePage, true);
        await command('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: id });
        await waitFilter(page, 'html', mode === 'page');
        assert.equal((await command('GET_STATE', { tabId: id })).tab.temporaryWholePage, false);
      }

      await state(page, 'media');
      await command('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: id });
      await state(page, 'media');
      await waitFilter(page, 'html', false);
      await waitFilter(page, '#image', true);
      assert.equal((await command('GET_STATE', { tabId: id })).tab.temporaryWholePage, false);
      await command('TOGGLE_TEMPORARY_WHOLE_PAGE', { tabId: id });
      await waitFilter(page, 'html', true);
      await page.reload({ waitUntil: 'load' });
      await waitFilter(page, 'html', false);
      await waitFilter(page, '#image', true);
      const reloaded = (await command('GET_STATE', { tabId: id })).tab;
      assert.equal(reloaded.temporaryWholePage, false);
      assert.equal(reloaded.temporary, false);
      assert.equal(reloaded.temporarilyDisabled, false);
    } finally {
      await command('RESET_TEMPORARY', { tabId: id });
      await state(page, 'media');
    }
  });

  await test('temporary inversion survives service worker termination until navigation', async () => {
    await command('TOGGLE_TEMPORARY', { tabId: await tabId(page) });
    await waitFilter(page, 'html', true);
    const cdp = await context.newCDPSession(control);
    try {
      let version;
      let stopped = false;
      cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
        for (const item of versions) {
          if (item.scriptURL.startsWith(`chrome-extension://${extensionId}/`)) {
            version = item;
            if (item.runningStatus === 'stopped') stopped = true;
          }
        }
      });
      await cdp.send('ServiceWorker.enable');
      for (let attempt = 0; attempt < 50 && !version; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(version?.versionId, 'Extension worker must have a registered version');
      // Brave does not emit Playwright Worker.close when its extension worker stops.
      // The protocol runningStatus confirms the actual stop before the next message.
      await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      for (let attempt = 0; attempt < 100 && !stopped; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(stopped, true, 'ServiceWorker.stopWorker must actually stop the extension worker');
      await cdp.detach();
      // A fresh message starts a worker; session-backed state must still toggle off.
      await command('TOGGLE_TEMPORARY', { tabId: await tabId(page) });
      await waitFilter(page, 'html', false);
      await waitFilter(page, '#image', true);
    } finally {
      await cdp.detach().catch(() => {});
      await command('RESET_TEMPORARY', { tabId: await tabId(page) });
    }
  });

  await test('global pause and resume update all existing tabs and their frames', async () => {
    const second = await context.newPage();
    await second.goto(`${origin}/page.html?secondary`, { waitUntil: 'load' });
    await waitFilter(second, '#image', true);
    await command('SET_ENABLED', { enabled: false });
    await waitFilter(page, '#image', false);
    await waitFilter(second, '#image', false);
    await waitFilter(await frameFor(second, '#cross-frame'), '#frame-image', false);
    await command('SET_ENABLED', { enabled: true });
    await waitFilter(page, '#image', true);
    await waitFilter(second, '#image', true);
    await second.close();
  });

  await test('media settings update existing pages and preserve other selected media types', async () => {
    await command('UPDATE_SETTINGS', { patch: { media: { images: false } } });
    await waitFilter(page, '#image', false);
    await waitFilter(page, '#video', true);
    await waitFilter(page, '#canvas', true);
    await command('UPDATE_SETTINGS', { patch: { media: { images: true } } });
    await waitFilter(page, '#image', true);
  });

  await test('localhost and numeric host rules remain independent', async () => {
    await command('SET_HOST_MODE', { hostname: 'localhost', mode: 'off' });
    const local = await context.newPage();
    await local.goto(`http://localhost:${port}/page.html?localhost`, { waitUntil: 'load' });
    await waitFilter(local, '#image', false);
    await waitFilter(page, '#image', true);
    await command('SET_HOST_MODE', { hostname: 'localhost', mode: 'page' });
    await waitFilter(local, 'html', true);
    await waitFilter(page, 'html', false);
    await local.close();
  });

  await test('default mode updates pages without explicit host rules', async () => {
    await state(page, 'default');
    await command('UPDATE_SETTINGS', { patch: { defaultMode: 'off' } });
    await waitFilter(page, '#image', false);
    await command('UPDATE_SETTINGS', { patch: { defaultMode: 'media' } });
    await waitFilter(page, '#image', true);
  });

  await test('host suffixes are retained and exported settings round-trip through strict validation', async () => {
    await command('SET_HOST_MODE', { hostname: 'example.com', mode: 'page' });
    await command('SET_HOST_MODE', { hostname: 'example.org', mode: 'off' });
    const { settings } = await command('GET_SETTINGS');
    assert.equal(settings.sites['example.com'], 'page');
    assert.equal(settings.sites['example.org'], 'off');
    assert.equal(Object.hasOwn(settings.sites, 'example'), false);
    const invalid = { ...settings, defaultMode: 'invalid' };
    const rejected = await control.evaluate(async settings => chrome.runtime.sendMessage({ type: 'IMPORT_SETTINGS', settings }), invalid);
    assert.equal(rejected.ok, false);
    assert.deepEqual((await command('GET_SETTINGS')).settings, settings);
    await command('IMPORT_SETTINGS', { settings });
    assert.deepEqual((await command('GET_SETTINGS')).settings, settings);
  });

  await test('popup controls save the displayed host mode and toggle temporary inversion', async () => {
    await page.bringToFront();
    await control.setViewportSize({ width: 380, height: 600 });
    await control.reload();
    await control.waitForFunction(() => document.querySelector('#hostname').textContent === '127.0.0.1');
    assert.equal(await control.locator('html').getAttribute('lang'), 'en');
    assert.deepEqual(await control.locator('.mode-card strong').allTextContents(), ['Default', 'Media only', 'Whole page', 'No changes']);
    assert.equal(await control.locator('#temporary-heading').textContent(), 'Temporarily');
    assert.equal(await control.locator('#reset-temporary').textContent(), 'Restore saved mode');
    const assertPopupFits = async () => {
      const layout = await control.evaluate(() => ({
        height: document.body.getBoundingClientRect().height,
        contentHeight: document.body.scrollHeight,
        clientHeight: document.body.clientHeight,
        width: document.body.clientWidth,
        contentWidth: document.body.scrollWidth,
        overflowY: getComputedStyle(document.body).overflowY,
      }));
      assert.ok(layout.height <= 600, `Popup viewport must fit within the browser's 600px height: ${JSON.stringify(layout)}`);
      assert.ok(layout.contentWidth <= layout.width, `Popup content must not overflow horizontally: ${JSON.stringify(layout)}`);
      if (layout.contentHeight > layout.clientHeight) {
        assert.ok(['auto', 'scroll'].includes(layout.overflowY), `Popup must allow scrolling to all controls: ${JSON.stringify(layout)}`);
      }
      await control.locator('.popup-footer').scrollIntoViewIfNeeded();
      assert.ok(await control.locator('.popup-footer').evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= window.innerHeight + 1;
      }), 'Popup footer must remain reachable within the browser popup viewport');
    };
    await assertPopupFits();
    // The popup restores the previous selection while its asynchronous save is pending.
    await control.locator('input[name="site-mode"][value="page"]').click();
    await waitFilter(page, 'html', true);
    await control.locator('#temporary').click();
    await waitFilter(page, 'html', false);
    await control.waitForFunction(() => document.querySelector('#temporary').getAttribute('aria-pressed') === 'true');
    assert.equal(await control.locator('#temporary-indicator').textContent(), 'On');
    await assertPopupFits();
    await control.locator('#reset-temporary').click();
    await waitFilter(page, 'html', true);
    const transientButtons = await control.locator('#temporary-disable, #temporary, #temporary-whole-page').allTextContents();
    assert.match(transientButtons[0], /Disable temporarily/);
    assert.match(transientButtons[1], /Invert temporarily/);
    assert.match(transientButtons[2], /Whole page/);
    await control.locator('#temporary-disable').click();
    await waitFilter(page, 'html', false);
    await control.waitForFunction(() => document.querySelector('#temporary-disable').getAttribute('aria-pressed') === 'true');
    assert.equal(await control.locator('#temporary-disable-indicator').textContent(), 'On');
    assert.equal(await control.locator('#temporary').getAttribute('aria-pressed'), 'false');
    assert.equal(await control.locator('#reset-temporary').isVisible(), true);
    await assertPopupFits();
    await control.locator('#temporary-disable').click();
    await waitFilter(page, 'html', true);
    await control.waitForFunction(() => document.querySelector('#temporary-disable').getAttribute('aria-pressed') === 'false');
    await control.locator('#temporary-disable').click();
    await waitFilter(page, 'html', false);
    await control.locator('#temporary').click();
    await control.waitForFunction(() => document.querySelector('#temporary').getAttribute('aria-pressed') === 'true' && document.querySelector('#temporary-disable').getAttribute('aria-pressed') === 'false');
    await control.locator('#reset-temporary').click();
    await waitFilter(page, 'html', true);
    await state(page, 'media');
    await control.locator('#temporary-whole-page').click();
    await waitFilter(page, 'html', true);
    await waitFilter(page, '#image', false);
    await control.waitForFunction(() => document.querySelector('#temporary-whole-page').getAttribute('aria-pressed') === 'true');
    assert.equal(await control.locator('#temporary-whole-page-indicator').textContent(), 'On');
    assert.equal(await control.locator('#temporary').getAttribute('aria-pressed'), 'false');
    assert.equal(await control.locator('#temporary-disable').getAttribute('aria-pressed'), 'false');
    await assertPopupFits();
    await control.locator('#temporary-whole-page').click();
    await waitFilter(page, 'html', false);
    await waitFilter(page, '#image', true);
    assert.equal(await control.locator('#error').isVisible(), false);
    await state(page, 'default');
  });

  await test('panel tabId targets the intended page while the panel itself is the active tab', async () => {
    const id = await tabId(page);
    const panel = await context.newPage();
    try {
      await panel.goto(`chrome-extension://${extensionId}/popup.html?tabId=${id}`);
      await panel.bringToFront();
      const [active] = await panel.evaluate(async () => chrome.tabs.query({ active: true, currentWindow: true }));
      assert.notEqual(active.id, id);
      assert.equal(active.url, panel.url());
      await panel.waitForFunction(() => document.querySelector('#hostname').textContent === '127.0.0.1');
      await panel.locator('input[name="site-mode"][value="page"]').click();
      await waitFilter(page, 'html', true);
      await panel.locator('#temporary').click();
      await waitFilter(page, 'html', false);
      await panel.waitForFunction(() => document.querySelector('#temporary').getAttribute('aria-pressed') === 'true');
      assert.equal(await panel.locator('#error').isVisible(), false);
    } finally {
      await command('RESET_TEMPORARY', { tabId: id });
      await state(page, 'default');
      await panel.close();
    }
  });

  await test('options controls update media and retain separate rules for two suffixes', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    assert.equal(await options.locator('html').getAttribute('lang'), 'en');
    assert.equal(await options.title(), 'Invert colors — Settings');
    assert.deepEqual(await options.locator('#default-mode option').allTextContents(), ['Media only', 'Whole page', 'No changes']);
    assert.deepEqual(await options.locator('#new-mode option').allTextContents(), ['Media only', 'Whole page', 'No changes']);
    assert.equal(await options.locator('#open-shortcuts').textContent(), 'Keyboard shortcuts');
    assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'Settings must not overflow horizontally');
    await options.locator('#default-mode').selectOption('page');
    await waitFilter(page, 'html', true);
    await options.locator('#default-mode').selectOption('media');
    await waitFilter(page, 'html', false);
    await options.locator('[data-media="images"]').uncheck();
    await waitFilter(page, '#image', false);
    await options.locator('[data-media="images"]').check();
    await waitFilter(page, '#image', true);
    const rules = await options.locator('#site-list').innerText();
    assert.match(rules, /example\.com/);
    assert.match(rules, /example\.org/);
    assert.equal(await options.locator('#error').isVisible(), false);
    await options.close();
  });

  await test('reinjecting twice leaves one engine and restores original author filters', async () => {
    const id = await tabId(page);
    for (let attempt = 0; attempt < 2; attempt++) {
      await control.evaluate(async tabId => {
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
      }, id);
    }
    await waitFilter(page, '#image', true);
    await waitFilter(await frameFor(page, '#cross-frame'), '#frame-image', true);
    await pixel(page, '#image', [235, 155, 35]);
    assert.equal((await page.locator('#author').evaluate(node => getComputedStyle(node).filter)).match(/invert\(1\)/g)?.length, 1);
    await state(page, 'off');
    await waitFilter(page, '#image', false);
    assert.equal(await page.locator('#author').evaluate(node => getComputedStyle(node).filter), 'opacity(0.8)');
    await state(page, 'default');
  });

  await test('changing a mode restores missing content engines without reloading the page', async () => {
    const id = await tabId(page);
    const disposed = await control.evaluate(async tabId => {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const engine = globalThis[Symbol.for('invert-colors.content.v1')];
          if (!engine) return false;
          engine.dispose();
          return !globalThis[Symbol.for('invert-colors.content.v1')];
        },
      });
      return results.map(result => ({ frameId: result.frameId, disposed: result.result }));
    }, id);
    assert.equal(disposed.find(result => result.frameId === 0)?.disposed, true);
    await waitFilter(page, '#image', false);
    await waitFilter(await frameFor(page, '#cross-frame'), '#frame-image', false);
    await state(page, 'page');
    await waitFilter(page, 'html', true);
    await waitFilter(page, '#image', false);
    await state(page, 'default');
    await waitFilter(page, '#image', true);
    await waitFilter(await frameFor(page, '#cross-frame'), '#frame-image', true);
    await pixel(page, '#image', [235, 155, 35]);
  });
} finally {
  try {
    if (context) await context.close();
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (process.env.KEEP_TEST_PROFILE === '1') console.log(`Test profile retained: ${profile}`);
    else {
      assert.equal(path.dirname(profile), os.tmpdir());
      assert.ok(path.basename(profile).startsWith('invert-colors-e2e-'));
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
console.log(`\n${passed} integration tests passed; ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
