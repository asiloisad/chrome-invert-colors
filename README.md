# Invert colors

A Manifest V3 extension for **Brave and other Chromium browsers**, designed for people who use system-wide inverted screen colors.

With screen inversion enabled, a light website becomes dark, but its images also become negative. Invert colors compensates by inverting the media before the system does. You can save a different mode for each website or change the current tab temporarily.

**English is the only supported interface language.** Requires Chromium 120 or newer. The extension has no runtime dependencies and needs no build step to install.

## Install

### From a release ZIP

1. Download the extension ZIP from this repository's **Releases** section and extract it to a folder you will keep.
2. Open `brave://extensions` in Brave or `chrome://extensions` in Chrome.
3. Enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
4. Pin the extension icon to the toolbar.

If you already use another color-inversion extension, disable it to prevent overlapping filters. To use Invert colors on local files, separately enable **Allow access to file URLs** in its extension details.

### From source

Clone or download this repository, then load its root folder using the steps above. Node.js is only needed for development. After updating the files, reload the extension on the extensions page. Refresh open pages if they retain old filters.

## Use

**Left-click** the icon to open the current website's panel. **Right-click** for a compact menu with temporary inversion, saved site modes, global pause, and settings.

The panel has four tiles, with **Default** first:

| Saved choice | Effect |
| --- | --- |
| Default | Uses the default mode from Settings and removes this website's individual rule. |
| Media only | Inverts selected images, videos, and canvas elements. The default for light websites with system-wide inversion. |
| Whole page | Inverts the entire document, including media. Useful with a website's native dark theme. |
| No changes | Applies no extension filters to the website. |

Rules use the **exact hostname**: `example.com`, `www.example.com`, and `example.org` are separate entries. Scheme, port, and path do not create separate rules. Localhost, IP addresses, and internationalized domain names are supported. One `file://` rule covers all local files.

### Temporary tab controls

The **Temporarily** section offers three mutually exclusive choices:

| Control | Effect in the current tab and its frames |
| --- | --- |
| Disable temporarily | Removes all extension filters. |
| Invert temporarily | Inverts the saved mode's result. Media compensation is preserved in Media only mode; document-wide inversion is removed in Whole page mode. |
| Whole page | Inverts the entire document, including media, regardless of the saved mode. |

These choices preserve saved settings and do not affect other tabs. Clicking the active choice again or choosing **Restore saved mode** ends it. Choosing another temporary control replaces the current one.

Temporary state survives extension service worker restarts. It ends on refresh, navigation to a new document, tab closure, or browser restart. Same-document navigation in a web app preserves it. Selecting a saved mode in the panel also resets temporary state.

**Extension enabled** pauses or resumes filters in all accessible tabs. Pausing preserves both saved rules and temporary choices.

### Settings and shortcuts

Settings lets you change the default mode, choose media categories, manage website rules, and import or export JSON settings. Import replaces the current settings after validation; temporary tab state is excluded.

No keyboard shortcuts are assigned by default. You can assign temporary inversion, site-mode cycling, and global pause at `brave://extensions/shortcuts` or `chrome://extensions/shortcuts`. Chromium does not expose a separate middle-click action for the toolbar icon.

## Media support and limitations

- **Images, videos, and canvas** are enabled by default, including elements added after the page loads.
- **Inline SVG** is optional and off by default because it often contains monochrome icons or text. SVG loaded through an image element follows the Images setting.
- **CSS background images** are optional and off by default. URL and image-set backgrounds are handled only on empty elements without text, child elements, controls, or visible pseudo-element content. Backgrounds on other elements and gradients are left alone.
- **Frames**, including cross-origin frames, inherit the main website's mode. Changing modes also removes obsolete filters inside frames.
- **Open Shadow DOM** is supported, including roots created later. Media inside closed roots is inaccessible; Whole page mode covers their rendered output.
- The extension composes its inversion with site-authored filters and restores them when disabled. Ordinary class, style, and stylesheet changes are tracked. Animated filters or changes made only through CSSOM may require reapplying the mode or refreshing.

Protected browser pages, extension stores, and some built-in document viewers block injection. Automatic operation requires the extension's site access to be enabled.

Settings from other extensions cannot be read automatically. Recreate any old exceptions using complete hostnames.

## Privacy

Settings and host rules stay in this browser's local extension storage. Temporary tab state uses session storage. The extension has no telemetry, account, server, or settings synchronization. JSON exports include your saved hostnames. See [PRIVACY.md](PRIVACY.md) for data use and permissions.

## Development

Use Node.js 20.9 or newer. Install the locked development dependencies and run the checks:

```sh
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:e2e
```

Playwright and Sharp are development dependencies only. End-to-end tests use Playwright's installed Chromium browser by default; set `BROWSER_PATH` to test a Brave or another Chromium executable. Tests launch a separate temporary browser profile and never use your regular profile. Set `KEEP_TEST_PROFILE=1` to retain the test profile for debugging.

Tests cover rendered colors, dynamic media and frames, Shadow DOM, site-authored filters, mode changes, temporary state, service worker restarts, host rules, and the interface. They verify extension filters without emulating system-wide screen inversion.

```sh
npm run icons
npm run package
```

The first command regenerates PNG icons from the SVG source in `icons/`. Packaging creates the ready-to-load extension ZIP and its SHA-256 checksum in `dist/`, excluding tests and development dependencies.

`background.js` manages state and browser events, `model.js` validates settings and resolves rules, and `content.js` applies filters. `shadow-hook.js` observes new open Shadow DOM roots. Other modules implement the popup and settings page.

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and release steps, and [CHANGELOG.md](CHANGELOG.md) for release notes.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
