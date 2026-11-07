# Changelog

## Unreleased

- Remove a one-frame flash when entering or leaving fullscreen by applying its filter before the next paint.
- Preserve whole-page and temporary inversion when videos or players enter fullscreen, including embedded players and open Shadow DOM, and restore page filtering after exit.

## 1.0.1

- Keep media inversion stable during CSS filter transitions, tab returns, and scrolling.
- Preserve filter ownership when a site copies a thumbnail into an enlarged image preview, avoiding an extra inversion.

## 1.0.0

Initial release of Invert colors, a Manifest V3 extension for Brave and other Chromium browsers.

- Media-only compensation for system-wide inverted screen colors, with configurable images, video, canvas, inline SVG, and selected CSS background images.
- Saved website modes: Media only, Whole page, and No changes, with a configurable default and exact-host rules.
- Independent temporary tab controls: Disable temporarily, Invert temporarily, and Whole page.
- Toolbar panel, compact toolbar context menu, global pause, and optional user-assigned keyboard shortcuts.
- Settings management with rule search and validated JSON import and export.
- Support for frames, dynamically added media, and open Shadow DOM; preservation of site-authored filters.
- Local settings storage and session-scoped temporary state that survives service worker restarts.
- English-only interface, automated unit and browser tests, and ZIP packaging with a SHA-256 checksum.
