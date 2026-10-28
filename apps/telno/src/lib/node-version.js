/**
 * The Node floor, in one place.
 *
 * `engines` in package.json is the declaration; `.npmrc` makes npm enforce it on
 * install. This module is what the start-up guard and the smoke suite read, so
 * there is no second number to drift out of step with the manifest.
 */

/** `24`, `24.3`, `24.3.1` -> { major, minor, patch }. Anything else is null. */
export function parseNodeVersion(raw) {
  const match = String(raw || '')
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] || 0), patch: Number(match[3] || 0) };
}

/** `>=24.0.0` -> `24.0.0`; a bare `24` is read as `24.0.0`. */
export function floorOf(range) {
  return String(range || '').replace(/^[>=^~ ]+/, '').trim() || '0.0.0';
}

/**
 * Does this version satisfy the floor? A floor is a minimum, not a range: the
 * point is that the runtime is new enough, and a future major is not worse.
 */
export function meetsFloor(version, floor) {
  const have = parseNodeVersion(version);
  const want = parseNodeVersion(floorOf(floor));
  if (!have || !want) return false;
  if (have.major !== want.major) return have.major > want.major;
  if (have.minor !== want.minor) return have.minor > want.minor;
  return have.patch >= want.patch;
}

/** The sentence a person sees when their runtime is too old. */
export function floorMessage(version, floor, { file = 'package.json' } = {}) {
  return (
    `Node ${floorOf(floor)} or newer is required; this is ${version}.\n\n` +
    'The platform cannot start on an older runtime: the database uses node:sqlite,\n' +
    'which earlier versions refuse to import without an experimental flag.\n' +
    `The requirement is declared in ${file} ("engines"), so an npm install should have\n` +
    'refused already — if the tree was copied rather than installed, that is why.\n\n' +
    'Fix it with `nvm use` (the version is in .nvmrc), or point PATH at a Node 24 install.'
  );
}
