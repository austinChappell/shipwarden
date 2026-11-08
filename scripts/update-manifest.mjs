// Writes the update manifest of a release: the version, and the name, size and SHA-256 of the zip.
// Usage: node scripts/update-manifest.mjs <version> <zip file> <output file>
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseManifest } from '../src/shared/updates.ts';

const [version, zip, output] = process.argv.slice(2);
if (!version || !zip || !output) {
    console.error('Usage: node scripts/update-manifest.mjs <version> <zip file> <output file>');
    process.exit(2);
}
const manifest = {
    version,
    zip: { name: basename(zip), sha256: createHash('sha256').update(readFileSync(zip)).digest('hex'), size: statSync(zip).size }
};
if (!parseManifest(manifest)) {
    console.error(`The manifest is not valid: ${JSON.stringify(manifest)}`);
    process.exit(1);
}
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Update manifest: ${manifest.zip.name}, ${manifest.zip.size} bytes, sha256 ${manifest.zip.sha256}.`);
