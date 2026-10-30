// Explicitly include the runtime and public documentation; never copy a checkout wholesale.
export const RELEASE_FILES = Object.freeze([
  'manifest.json', 'background.js', 'model.js', 'content.js', 'shadow-hook.js',
  'popup.html', 'popup.js', 'options.html', 'options.js', 'ui-shared.js', 'ui.css',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png', 'icons/icon.svg',
  'README.md', 'LICENSE', 'PRIVACY.md', 'CHANGELOG.md', 'CONTRIBUTING.md'
].sort());
