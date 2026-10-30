import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { RELEASE_FILES } from './release-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(root, file), 'utf8');
const manifest = JSON.parse(await read('manifest.json'));
const pkg = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));
assert.equal(manifest.manifest_version, 3, 'The extension must use Manifest V3.');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/u, 'Use a three-part release version.');
assert.equal(pkg.version, manifest.version, 'Manifest and package versions must match.');
assert.equal(lock.version, pkg.version, 'Lockfile version must match.');
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root version must match.');
assert.equal(pkg.license, 'MIT', 'Package metadata must declare the MIT license.');
assert.equal(manifest.background.type, 'module');
assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'Runtime code must remain dependency-free.');
assert.ok(Object.values(manifest.commands || {}).every(command => !Object.hasOwn(command, 'suggested_key')), 'Do not assign default keyboard shortcuts.');

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--tag'), 'Usage: npm run check -- [--tag v1.0.0]');
if (args.length) assert.equal(args[1], `v${manifest.version}`, 'The release tag must match the manifest version.');

function assetPath(file) {
  assert.equal(typeof file, 'string', 'Asset paths must be strings.');
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Asset must remain inside the project: ${file}`);
  return resolved;
}

const references = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap(script => [...(script.js || []), ...(script.css || [])])
]);
for (const file of references) {
  assert.ok((await stat(assetPath(file))).isFile(), `Missing manifest asset: ${file}`);
  assert.ok(RELEASE_FILES.includes(file), `Manifest asset is missing from the ZIP allowlist: ${file}`);
}
assert.equal(new Set(RELEASE_FILES).size, RELEASE_FILES.length, 'The release allowlist contains duplicates.');
for (const file of RELEASE_FILES) assert.ok((await stat(assetPath(file))).isFile(), `Missing release file: ${file}`);

for (const file of ['popup.html', 'options.html']) {
  const html = await read(file);
  assert.match(html, /<html\s+lang="en"/u, `${file} must declare English.`);
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"#]+)"/gu)) {
    assert.ok(RELEASE_FILES.includes(reference), `HTML resource is missing from the ZIP: ${reference}`);
    assert.ok((await stat(assetPath(reference))).isFile());
  }
}
assert.ok(!manifest.default_locale, 'English is the only supported interface language.');

for (const size of [16, 32, 48, 128]) {
  const file = `icons/icon${size}.png`;
  const bytes = await readFile(assetPath(file));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG.`);
  assert.equal(bytes.readUInt32BE(16), size, `${file} width must match its filename.`);
  assert.equal(bytes.readUInt32BE(20), size, `${file} height must match its filename.`);
}
assert.match(await read('LICENSE'), /^MIT License\r?\n/u);
assert.match(await read('CHANGELOG.md'), new RegExp(`^## ${manifest.version.replaceAll('.', '\\.')}\\s*$`, 'm'), 'The changelog must include this version.');

const ignored = new Set(['.git', 'node_modules', 'dist', 'test-results', 'playwright-report', '.cache']);
const scripts = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (/\.(?:m?js)$/u.test(entry.name)) scripts.push(file);
  }
}
await collect(root);
for (const file of scripts) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `JavaScript syntax error in ${path.relative(root, file)}:\n${result.stderr || result.error || ''}`);
}
console.log(`Validated Invert colors ${manifest.version}: ${scripts.length} scripts, manifest assets, icons, release files, and metadata.`);
