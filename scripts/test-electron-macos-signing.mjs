import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('macOS packaging uses intentional ad-hoc signing', () => {
  const builderConfig = readRepoFile('electron-builder.yml');
  const entitlements = readRepoFile('electron/entitlements.mac.plist');

  assert.match(builderConfig, /^\s+identity: '-'$/m);
  assert.match(builderConfig, /^\s+notarize: false$/m);
  assert.match(
    entitlements,
    /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>/
  );
});

test('macOS DMG uses the branded Libre WebUI installer layout', () => {
  const builderConfig = readRepoFile('electron-builder.yml');
  const backgroundSvg = readRepoFile('electron/assets/dmg-background.svg');
  const iconGenerator = readRepoFile('scripts/generate-icons.js');

  assert.match(builderConfig, /^\s+title: 'Install Libre WebUI'$/m);
  assert.match(builderConfig, /^\s+iconSize: 112$/m);
  assert.match(builderConfig, /^\s+iconTextSize: 13$/m);
  assert.match(builderConfig, /^\s+width: 760$/m);
  assert.match(builderConfig, /^\s+height: 500$/m);
  assert.match(backgroundSvg, /<svg width="760" height="500"/);
  assert.match(backgroundSvg, /Make whatever/);
  assert.match(backgroundSvg, /comes next\./);
  assert.match(iconGenerator, /dmg-art\.png/);
  assert.match(iconGenerator, /const dmgWidth = 760/);
  assert.match(iconGenerator, /const dmgHeight = 500/);
  assert.ok(
    fs.existsSync(path.join(repoRoot, 'electron/assets/dmg-art.png')),
    'the generated DMG artwork must be committed'
  );
});

test('macOS CI verifies the packaged application before upload', () => {
  for (const workflowPath of [
    '.github/workflows/electron-dev.yml',
    '.github/workflows/release.yml',
  ]) {
    const workflow = readRepoFile(workflowPath);
    const buildIndex = workflow.indexOf('run: npm run electron:build');
    const verifyIndex = workflow.indexOf('run: npm run electron:verify:mac');
    const uploadIndex = workflow.indexOf('Upload Electron artifacts');
    const fallbackUploadIndex = workflow.indexOf('Upload artifacts');
    const effectiveUploadIndex =
      uploadIndex === -1 ? fallbackUploadIndex : uploadIndex;

    assert.notEqual(buildIndex, -1, `${workflowPath} must build the macOS app`);
    assert.notEqual(
      verifyIndex,
      -1,
      `${workflowPath} must verify the macOS app`
    );
    assert.notEqual(
      effectiveUploadIndex,
      -1,
      `${workflowPath} must upload the macOS app`
    );
    assert.ok(
      buildIndex < verifyIndex && verifyIndex < effectiveUploadIndex,
      `${workflowPath} must verify the macOS app after building and before upload`
    );
  }
});
