import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings, normalizeHost, siteKey, isSupportedUrl, validateSettings,
  patchSettings, withSiteMode, resolveMode, renderState
} from '../model.js';

test('default media compensation leaves SVG and background heuristics optional', () => {
  const settings = defaultSettings();
  assert.equal(settings.defaultMode, 'media');
  assert.equal(settings.enabled, true);
  assert.deepEqual(settings.media, { images: true, video: true, canvas: true, svg: false, backgrounds: false });
  settings.media.images = false;
  assert.equal(defaultSettings().media.images, true);
});

test('exact hostname rules never merge suffixes, subdomains, or localhost', () => {
  let settings = withSiteMode(defaultSettings(), 'example.com', 'page');
  settings = withSiteMode(settings, 'localhost', 'off');
  assert.equal(resolveMode(settings, 'https://example.com/a'), 'page');
  for (const url of ['https://example.org', 'https://www.example.com', 'https://sub.example.com']) {
    assert.equal(resolveMode(settings, url), 'media');
  }
  assert.equal(resolveMode(settings, 'http://localhost:3000/a'), 'off');
  assert.equal(siteKey('http://127.0.0.1:8080'), '127.0.0.1');
  assert.equal(siteKey('http://[::1]:8080'), '[::1]');
  assert.equal(siteKey('file:///C:/images/test.html'), 'file://');
  assert.equal(normalizeHost('HTTPS://ŻÓŁĆ.PL./path'), 'xn--kda4b0koi.pl');
});

test('following the default removes a rule without changing other hosts', () => {
  let settings = withSiteMode(defaultSettings(), 'example.com', 'off');
  settings = withSiteMode(settings, 'example.org', 'page');
  settings = withSiteMode(settings, 'example.com', 'default');
  assert.equal(Object.hasOwn(settings.sites, 'example.com'), false);
  assert.equal(settings.sites['example.org'], 'page');
});

test('reject privileged URLs and extension store pages, not ordinary chrome-named paths', () => {
  for (const url of ['brave://settings', 'chrome://extensions', 'about:blank', 'data:text/html,hi', 'chrome-extension://id/a', 'https://chromewebstore.google.com/detail/id', 'https://chrome.google.com/webstore/detail/id']) {
    assert.equal(isSupportedUrl(url), false, url);
  }
  for (const url of ['https://example.com/chrome-theme?edge://hi', 'http://localhost', 'file:///C:/test.html', 'https://chrome.google.com/other']) {
    assert.equal(isSupportedUrl(url), true, url);
  }
});

test('partial media updates preserve other options and reject malformed imports', () => {
  const settings = patchSettings(defaultSettings(), { media: { canvas: false }, defaultMode: 'page' });
  assert.equal(settings.media.canvas, false);
  assert.equal(settings.media.images, true);
  assert.equal(settings.defaultMode, 'page');
  for (const patch of [{ defaultMode: 'bad' }, { media: { images: 'true' } }, { media: { unknown: true } }, { sites: {} }]) {
    assert.throws(() => patchSettings(settings, patch));
  }
  for (const invalid of [null, [], {}, { ...settings, version: 9 }, { ...settings, sites: { 'example.com': 'bad' } }]) {
    assert.throws(() => validateSettings(invalid));
  }
  assert.throws(() => normalizeHost('javascript:alert(1)'));
  assert.throws(() => normalizeHost('https://user:password@example.com'));
  assert.throws(() => normalizeHost('*.example.com'));
  assert.throws(() => validateSettings({ ...settings, sites: { 'EXAMPLE.com': 'off', 'example.com': 'page' } }));
});

test('host keys cannot mutate the object prototype', () => {
  const settings = withSiteMode(defaultSettings(), '__proto__', 'off');
  assert.equal(Object.getPrototypeOf(settings.sites), null);
  assert.equal(settings.sites.__proto__, 'off');
  assert.equal(resolveMode(settings, 'https://constructor'), 'media');
  assert.equal({}.polluted, undefined);
});

test('hostname normalization is idempotent and rejects all-dot or empty labels', () => {
  for (const host of ['.', '..', '...', 'example.com..', '.example.com', 'example..com']) {
    assert.throws(() => normalizeHost(host), host);
    assert.throws(() => withSiteMode(defaultSettings(), host, 'page'), host);
  }
  for (const host of ['EXAMPLE.com.', 'localhost', 'ŻÓŁĆ.PL', '[::1]', 'file://']) {
    const normalized = normalizeHost(host);
    assert.equal(normalizeHost(normalized), normalized);
  }
});

test('temporary is independent from the saved mode and pauses with all effects', () => {
  const settings = withSiteMode(defaultSettings(), 'example.com', 'page');
  const state = renderState(settings, 'https://example.com', true, false, 123);
  assert.deepEqual(state, { enabled: true, mode: 'page', temporary: true, topFrame: false, media: settings.media, revision: 123 });
  assert.equal(settings.sites['example.com'], 'page');
  assert.equal(renderState({ ...settings, enabled: false }, 'https://example.com', true, true, 124).enabled, false);
  assert.equal(renderState(settings, 'brave://settings', false, true, 125).enabled, false);
  const disabled = renderState(settings, 'https://example.com', false, true, 126, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.mode, 'page', 'temporary disable never changes the saved base mode');
  assert.equal(settings.enabled, true, 'temporary disable never changes global enabled state');
  for (const mode of ['media', 'page', 'off']) {
    const source = withSiteMode(defaultSettings(), 'example.com', mode);
    const whole = renderState(source, 'https://example.com', false, true, 127, false, true);
    assert.equal(whole.mode, 'page');
    assert.equal(whole.enabled, true);
    assert.equal(whole.temporary, false);
    assert.equal(source.sites['example.com'], mode, 'temporary whole-page never changes a saved mode');
  }
});
