// electron-builder runs this hook before it packs the app (build.beforePack in package.json).
// It builds the dictation helper, so that extraResources can copy it into Contents/Resources/native.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function beforePack(context) {
    if (context.electronPlatformName !== 'darwin') return;
    execFileSync('sh', [path.join(__dirname, 'build-dictation-helper.sh')], { stdio: 'inherit' });
};
