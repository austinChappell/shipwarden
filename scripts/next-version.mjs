// Sets the version of the next release in package.json and prints it.
// The base is the highest of the release tags (v*) and the version in package.json.
// Usage: node scripts/next-version.mjs <patch|minor|major>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { nextVersion } from '../src/shared/updates.ts';

const bump = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bump)) {
    console.error('Usage: node scripts/next-version.mjs <patch|minor|major>');
    process.exit(2);
}
const tags = execFileSync('git', ['tag', '--list', 'v[0-9]*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const version = nextVersion(tags, current, bump);
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { stdio: 'ignore' });
process.stdout.write(version);
