// Writes the release notes of a version from the commits since the last release tag.
// Usage: node scripts/release-notes.mjs <version> <output file>
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { releaseNotes } from '../src/shared/updates.ts';

const [version, output] = process.argv.slice(2);
if (!version || !output) {
    console.error('Usage: node scripts/release-notes.mjs <version> <output file>');
    process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let previous;
try {
    previous = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');
} catch {
    // No release yet: the notes list all commits.
}
const range = previous ? `${previous}..HEAD` : 'HEAD';
const log = git('log', '--no-merges', '--format=%H%x09%s', range);
const commits = log ? log.split('\n').map(line => {
    const [hash, ...subject] = line.split('\t');
    return { hash, subject: subject.join('\t') };
}) : [];
writeFileSync(output, releaseNotes(version, commits, previous));
console.log(`Release notes for ${version}: ${commits.length} commits since ${previous ?? 'the start'}.`);
