import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { x as extractTarball } from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function packProject(outputDir) {
  try {
    return JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', outputDir], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
    );
  } catch (error) {
    if (!error.stdout?.includes('pack-destination')) {
      throw error;
    }

    const result = JSON.parse(
      execFileSync('npm', ['pack', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
    );

    const tarballName = result[0]?.filename;
    if (!tarballName) {
      throw new Error('npm pack did not produce a tarball name');
    }

    fs.renameSync(
      path.join(repoRoot, tarballName),
      path.join(outputDir, tarballName)
    );
    return result;
  }
}

test('packed npm artifact resolves package metadata and frontend dist', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-webui-pack-'));

  try {
    const packResult = packProject(tempDir);
    const tarballName = packResult[0]?.filename;
    assert.ok(tarballName, 'npm pack should produce a tarball');

    const tarballPath = path.join(tempDir, tarballName);
    await extractTarball({
      file: tarballPath,
      cwd: tempDir,
    });

    const packedRoot = path.join(tempDir, 'package');
    const backendEntry = path.join(packedRoot, 'backend', 'dist', 'index.js');
    const backendPackageJson = path.join(packedRoot, 'backend', 'package.json');
    const frontendDist = path.join(packedRoot, 'frontend', 'dist');
    const helperPath = path.join(
      packedRoot,
      'backend',
      'dist',
      'utils',
      'packagePaths.js'
    );

    assert.ok(fs.existsSync(path.join(packedRoot, 'package.json')));
    assert.ok(fs.existsSync(backendPackageJson));
    assert.ok(fs.existsSync(backendEntry));
    assert.ok(fs.existsSync(path.join(frontendDist, 'index.html')));
    assert.ok(fs.existsSync(helperPath));

    const pkg = JSON.parse(
      fs.readFileSync(path.join(packedRoot, 'package.json'), 'utf8')
    );
    const helper = await import(pathToFileURL(helperPath).href);
    const backendEntryUrl = pathToFileURL(backendEntry).href;

    assert.equal(helper.resolveAppPackageRoot(backendEntryUrl), packedRoot);
    assert.equal(helper.loadAppPackage(backendEntryUrl).version, pkg.version);
    assert.equal(helper.resolveFrontendDist(backendEntryUrl), frontendDist);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
