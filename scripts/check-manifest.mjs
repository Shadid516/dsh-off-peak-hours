/**
 * Validate the contract a DSH plugin must satisfy to be installable *and*
 * discoverable.
 *
 * Nothing here is invented: each assertion mirrors a rule an actual consumer
 * applies. The plugin registries that sweep the GitHub `dsh-plugin` topic only
 * list a repository whose manifest declares a `dsh.bundle` and whose referenced
 * patch file exists and parses as a top-level YAML array, and the DSH Loader
 * itself refuses a patch that is not one. A patch row naming a package other
 * than this one is not caught by either, but it silently installs the wrong
 * thing, so it is checked here.
 *
 * Run with `npm run check:manifest`. Exits non-zero on the first failure group.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

/** Record one failed assertion. */
function fail(message) {
  failures.push(message);
}

/** Assert a condition, recording `message` when it does not hold. */
function check(condition, message) {
  if (!condition) fail(message);
}

/** Read and parse a JSON file relative to the repository root. */
function readJson(relative) {
  const path = join(root, relative);
  if (!existsSync(path)) {
    fail(`${relative} is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${relative} is not valid JSON: ${error.message}`);
    return null;
  }
}

const manifest = readJson('package.json');
if (manifest === null) {
  report();
  process.exit(1);
}

// --- Identity and registry-search metadata ---------------------------------
// `dsh plugin search` is an npm registry search, which ranks on name,
// description and keywords; the description has to say what the plugin does
// without the reader already knowing what a bundle is.
check(typeof manifest.name === 'string' && manifest.name.length > 0, 'package.json: name is required');
check(manifest.private !== true, 'package.json: `private: true` prevents publishing; remove it');
check(/^\d+\.\d+\.\d+$/.test(manifest.version ?? ''), 'package.json: version must be plain semver');
check((manifest.description ?? '').length >= 40, 'package.json: description is too short to be searched on');
check(manifest.license === 'MIT', 'package.json: license must be MIT');

const keywords = manifest.keywords ?? [];
check(Array.isArray(keywords) && keywords.length > 0, 'package.json: keywords are required for registry search');
// The discovery topic and the keyword that mirrors it are the two handles the
// ecosystem actually queries on; everything else is breadth.
for (const required of ['dsh', 'dsh-plugin', 'deepseek-harness']) {
  check(keywords.includes(required), `package.json: keywords must include "${required}"`);
}
check(new Set(keywords).size === keywords.length, 'package.json: keywords contain duplicates');

for (const field of ['repository', 'homepage', 'bugs']) {
  check(manifest[field] !== undefined, `package.json: ${field} is required for a public repository`);
}
check(manifest.publishConfig?.access === 'public', 'package.json: publishConfig.access must be "public"');

// --- Plugin-card display metadata ------------------------------------------
// The Plugin Manager reads these without activating the plugin.
check(typeof manifest.icon === 'string', 'package.json: icon is required for the plugin card');
check(typeof manifest.meta?.title === 'string', 'package.json: meta.title is required for the plugin card');
check(typeof manifest.meta?.description === 'string', 'package.json: meta.description is required');

// Icon: an in-tree relative path, a supported raster/vector type, size-capped.
if (typeof manifest.icon === 'string') {
  check(!isAbsolute(manifest.icon) && !/^[a-z]+:\/\//i.test(manifest.icon), 'package.json: icon must be a relative in-tree path');
  const iconPath = join(root, manifest.icon);
  if (!existsSync(iconPath)) {
    fail(`package.json: icon ${manifest.icon} does not exist`);
  } else {
    const { size } = statSync(iconPath);
    check(size <= 256 * 1024, `package.json: icon is ${size} bytes, over the 256 KiB limit`);
    check(/\.(svg|png|jpe?g|webp)$/i.test(manifest.icon), 'package.json: icon must be svg, png, jpeg or webp');
  }
}

// --- The bundle contract registries verify ---------------------------------
const patchRelative = manifest.dsh?.bundle?.patch;
check(typeof patchRelative === 'string', 'package.json: dsh.bundle.patch is required for discovery');

if (typeof patchRelative === 'string') {
  const patchPath = join(root, patchRelative);
  if (!existsSync(patchPath)) {
    fail(`package.json: dsh.bundle.patch ${patchRelative} does not exist`);
  } else {
    let document;
    try {
      document = parseYaml(readFileSync(patchPath, 'utf8'));
    } catch (error) {
      fail(`${patchRelative} is not valid YAML: ${error.message}`);
    }
    if (document !== undefined) {
      // The Loader requires a top-level array; a registry records the same
      // requirement as its manifest-verification gate.
      check(Array.isArray(document), `${patchRelative} must be a top-level YAML array`);
      if (Array.isArray(document)) {
        const rows = document.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []));
        check(rows.length > 0, `${patchRelative} inserts no plugin rows`);
        for (const row of rows) {
          check(typeof row?.id === 'string' && row.id.length > 0, `${patchRelative}: every inserted row needs an id`);
          // A row naming another package installs that package instead of this
          // one, which is the failure a rename leaves behind.
          check(
            row?.name === manifest.name,
            `${patchRelative}: row "${row?.id}" names "${row?.name}", but this package is "${manifest.name}"`,
          );
        }
      }
    }
  }
}

// The browser half travels through the export map plus dsh.client.
check(manifest.exports?.['./client'] !== undefined, 'package.json: exports["./client"] is required for the browser half');
check(
  manifest.dsh?.client?.platform === 'web',
  'package.json: dsh.client.platform must be "web" for a Web UI plugin',
);
check(
  Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0,
  'package.json: dsh.client.inject must name the client bundles this half requires',
);

// Every file the manifest promises is read by something; a missing entry in
// `files` publishes a package that cannot load. `files` entries are written
// without a leading `./`, while the manifest's own path fields carry one, so
// both sides are normalized before comparing.
const normalize = (value) => value.replace(/^\.\//, '');
const published = (manifest.files ?? []).map(normalize);
for (const required of [patchRelative, 'index.js', 'client.js', manifest.icon].filter((value) => typeof value === 'string')) {
  check(published.includes(normalize(required)), `package.json: files must include ${required}`);
}
check(published.includes('locale/*.json'), 'package.json: files must include locale/*.json');

// --- Localization ----------------------------------------------------------
for (const locale of ['en', 'zh']) {
  const dictionary = readJson(`locale/${locale}.json`);
  if (dictionary !== null) {
    check(typeof dictionary.title === 'string' && dictionary.title.length > 0, `locale/${locale}.json: title is required`);
    check(
      typeof dictionary.description === 'string' && dictionary.description.length > 0,
      `locale/${locale}.json: description is required`,
    );
  }
}

// --- Release bookkeeping ---------------------------------------------------
// A published version that no changelog entry mentions is a version whose
// changes nobody can read.
if (existsSync(join(root, 'CHANGELOG.md'))) {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  check(
    changelog.includes(`## [${manifest.version}]`) || changelog.includes(`## ${manifest.version}`),
    `CHANGELOG.md: no entry for version ${manifest.version}`,
  );
} else {
  fail('CHANGELOG.md is missing');
}
check(existsSync(join(root, 'LICENSE')), 'LICENSE is missing for an MIT-licensed public package');

report();

/** Print the outcome and exit non-zero when anything failed. */
function report() {
  if (failures.length > 0) {
    console.error(`manifest check failed (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('manifest check passed: installable, discoverable, and publication-ready');
  }
}
