export const SETTINGS_KEY = 'settings';
export const MODES = Object.freeze(['media', 'page', 'off']);
export const MEDIA_KEYS = Object.freeze(['images', 'video', 'canvas', 'svg', 'backgrounds']);
export const DEFAULT_MEDIA = Object.freeze({ images: true, video: true, canvas: true, svg: false, backgrounds: false });
export const MODE_LABELS = Object.freeze({ media: 'Media only', page: 'Whole page', off: 'No changes' });

export function defaultSettings() {
  return { version: 1, enabled: true, defaultMode: 'media', media: { ...DEFAULT_MEDIA }, sites: {} };
}

export function isMode(mode) { return MODES.includes(mode); }

/** Exact normalized hostname; no guessing at public suffixes or merging domains. */
export function normalizeHost(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a hostname, such as example.com.');
  const input = value.trim();
  if (input === 'file://') return input;
  let url;
  try { url = new URL(input.includes('://') ? input : `https://${input}`); }
  catch { throw new Error('Invalid hostname.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || /[\s*]/u.test(input)) {
    throw new Error('Enter a hostname or HTTP/HTTPS URL without credentials or wildcards.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (!host || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
    throw new Error('Invalid hostname: domain labels cannot be empty.');
  }
  return host;
}

export function siteKey(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol === 'file:') return 'file://';
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return normalizeHost(url.hostname);
  } catch { return null; }
}

export function isSupportedUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!siteKey(urlString)) return false;
    if (url.hostname === 'chromewebstore.google.com') return false;
    if (url.hostname === 'chrome.google.com' && /^\/webstore(?:\/|$)/u.test(url.pathname)) return false;
    return true;
  } catch { return false; }
}

/** Validate imports strictly instead of silently losing or reinterpreting rules. */
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new Error('Unsupported settings format. Version 1 is required.');
  }
  if (typeof value.enabled !== 'boolean' || !isMode(value.defaultMode)) throw new Error('Invalid enabled state or default mode.');
  if (!value.media || typeof value.media !== 'object' || Array.isArray(value.media)) throw new Error('Media settings are missing.');
  const media = {};
  for (const key of MEDIA_KEYS) {
    if (typeof value.media[key] !== 'boolean') throw new Error(`Invalid media setting: ${key}.`);
    media[key] = value.media[key];
  }
  if (!value.sites || typeof value.sites !== 'object' || Array.isArray(value.sites)) throw new Error('Invalid site list.');
  if (Object.keys(value.sites).length > 10000) throw new Error('The site list exceeds the limit of 10,000 entries.');
  const sites = Object.create(null);
  for (const [input, mode] of Object.entries(value.sites)) {
    const host = normalizeHost(input);
    if (!isMode(mode)) throw new Error(`Invalid site mode: ${input}.`);
    if (Object.hasOwn(sites, host)) throw new Error(`Duplicate site rule: ${host}.`);
    sites[host] = mode;
  }
  return { version: 1, enabled: value.enabled, defaultMode: value.defaultMode, media, sites };
}

export function patchSettings(settings, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings update.');
  for (const key of Object.keys(patch)) {
    if (!['defaultMode', 'media', 'enabled'].includes(key)) throw new Error(`Unknown setting: ${key}.`);
  }
  if (patch.media) {
    if (typeof patch.media !== 'object' || Array.isArray(patch.media)) throw new Error('Invalid media settings.');
    for (const key of Object.keys(patch.media)) if (!MEDIA_KEYS.includes(key)) throw new Error(`Unknown media type: ${key}.`);
  }
  return validateSettings({ ...settings, ...patch, media: { ...settings.media, ...(patch.media || {}) } });
}

export function withSiteMode(settings, input, mode) {
  const host = normalizeHost(input);
  if (mode !== 'default' && !isMode(mode)) throw new Error('Invalid site mode.');
  const sites = Object.assign(Object.create(null), settings.sites);
  if (mode === 'default') delete sites[host];
  else sites[host] = mode;
  return validateSettings({ ...settings, sites });
}

export function resolveMode(settings, urlString) {
  const host = siteKey(urlString);
  return host && Object.hasOwn(settings.sites, host) ? settings.sites[host] : settings.defaultMode;
}

export function renderState(settings, urlString, temporary, topFrame, revision, temporarilyDisabled = false, temporaryWholePage = false) {
  return {
    enabled: settings.enabled && !temporarilyDisabled && isSupportedUrl(urlString),
    mode: temporaryWholePage ? 'page' : resolveMode(settings, urlString),
    temporary: Boolean(temporary),
    topFrame: Boolean(topFrame),
    media: { ...settings.media },
    revision
  };
}
