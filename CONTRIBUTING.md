# Contributing

Invert colors is a build-free Manifest V3 extension for Brave and other Chromium browsers. Keep the interface and documentation in English.

## Set up

Use Node.js 20.9 or newer:

```sh
npm ci
npx playwright install chromium
```

Load the repository root as an unpacked extension from `brave://extensions` or `chrome://extensions`. Reload the extension after editing its files, and refresh test pages when needed.

## Validate a change

```sh
npm run check
npm test
npm run test:e2e
```

The checks validate the extension files. Unit tests cover settings and background state. End-to-end tests use Playwright with a separate temporary Chromium profile and verify rendered colors as well as the interface. Set `BROWSER_PATH` to a Brave or another Chromium executable to test that browser instead. Set `KEEP_TEST_PROFILE=1` to retain the test profile for debugging.

For changes to filters or state, check all three base modes, all three temporary controls, refresh and navigation behavior, frames, and global pause. Tests should cover observable behavior and regressions. System-wide screen inversion is not required for the automated tests.

Run `npm run icons` after changing `icons/icon.svg`, and include the regenerated PNG files. Run `npm run package` to verify that the extension can be packaged. Files generated in `dist/`, installed dependencies, and browser test profiles are not source files and should not be committed.

## Scope and behavior

- Keep runtime code self-contained; Playwright and Sharp are development tools.
- Preserve exact-host rules and local settings. Temporary controls must not overwrite saved rules.
- Remove the extension's filters cleanly and preserve the website's own styles.
- Document user-visible changes and limitations.
- Keep the version in `manifest.json` and `package.json` synchronized. Update the lockfile when package metadata or dependencies change.

## Releases

1. Update both version fields and add the release notes to [CHANGELOG.md](CHANGELOG.md).
2. Run the validation commands above and `npm run package`.
3. Commit the reviewed source changes and create a matching version tag, such as `v1.0.0` for version `1.0.0`.
4. Push the tag to GitHub. The release workflow prepares a **draft GitHub Release** with the extension ZIP and its SHA-256 checksum. Reusing a tag for an existing mutable release replaces its assets while preserving its publication status and notes; immutable releases require a new version. The workflow rejects assets if the tag moved during the build.
5. Review the draft notes and assets before publishing the release.

A GitHub Release distributes an unpacked extension archive. It does not publish the extension to a browser extension store.
