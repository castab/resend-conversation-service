import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const releaseSemverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function extractObservedVersion(markdown) {
  const match = markdown.match(
    /Contract\/package version observed in repository: `([^`]+)`/,
  );
  if (!match) {
    fail(
      'Could not find the observed contract/package version in docs/api-consumer-guide.md.',
    );
  }

  return match[1];
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const openapi = readJson('public/openapi.json');
const asyncapi = readJson('public/asyncapi.json');
const consumerGuide = readFileSync(
  resolve(root, 'docs/api-consumer-guide.md'),
  'utf8',
);

const version = packageJson.version;

if (!releaseSemverPattern.test(version)) {
  fail(
    `package.json version must be stable SemVer x.y.z or RC SemVer x.y.z-rc.n. Received: ${version}`,
  );
}

const versions = new Map([
  ['package.json', version],
  ['package-lock.json', packageLock.version],
  ["package-lock.json packages['']", packageLock.packages?.[''].version],
  ['public/openapi.json', openapi.info?.version],
  ['public/asyncapi.json', asyncapi.info?.version],
  ['docs/api-consumer-guide.md', extractObservedVersion(consumerGuide)],
]);

for (const [name, currentVersion] of versions) {
  if (currentVersion !== version) {
    fail(
      `${name} version must match package.json (${version}). Received: ${currentVersion}`,
    );
  }
}

const rawTag =
  process.argv[2] ??
  (process.env.GITHUB_REF_TYPE === 'tag'
    ? process.env.GITHUB_REF_NAME
    : undefined) ??
  (process.env.GITHUB_REF?.startsWith('refs/tags/')
    ? process.env.GITHUB_REF
    : undefined);

if (rawTag) {
  const normalizedTag = rawTag.startsWith('refs/tags/')
    ? rawTag.slice('refs/tags/'.length)
    : rawTag;

  if (!normalizedTag.startsWith('v')) {
    fail(`Release tags must start with v. Received: ${normalizedTag}`);
  }

  const tagVersion = normalizedTag.slice(1);
  if (!releaseSemverPattern.test(tagVersion)) {
    fail(
      `Release tags must use stable SemVer like v0.0.1 or RC SemVer like v0.7.0-rc.1. Received: ${normalizedTag}`,
    );
  }

  if (tagVersion !== version) {
    fail(
      `Release tag ${normalizedTag} must match package.json version ${version}.`,
    );
  }
}

process.stdout.write(`Release metadata is aligned at version ${version}.\n`);
