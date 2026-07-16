const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const {
  buildBlockMap,
} = require('app-builder-lib/out/targets/blockmap/blockmap');

const execFileAsync = promisify(execFile);

module.exports = async function finalizeMacosArtifact(context) {
  if (
    process.platform !== 'darwin' ||
    path.extname(context.file).toLowerCase() !== '.dmg'
  ) {
    return;
  }

  const finalizer = path.join(
    context.packager.projectDir,
    'scripts',
    'finalize-macos-dmg.sh'
  );
  await execFileAsync('/bin/bash', [finalizer, context.file], {
    maxBuffer: 1024 * 1024,
  });

  if (context.updateInfo) {
    context.updateInfo = await buildBlockMap(
      context.file,
      'gzip',
      `${context.file}.blockmap`
    );
  }
};
