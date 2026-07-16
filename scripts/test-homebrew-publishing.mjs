import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Homebrew templates match current release packaging', () => {
  const formula = readRepoFile('homebrew/libre-webui-formula.template');
  const cask = readRepoFile('homebrew/libre-webui-cask.template');

  assert.match(
    formula,
    /registry\.npmjs\.org\/libre-webui\/-\/libre-webui-\{\{VERSION\}\}\.tgz/
  );
  assert.match(formula, /sha256 "\{\{NPM_SHA256\}\}"/);
  assert.match(formula, /depends_on "node"/);
  assert.match(
    formula,
    /system "npm", "install", \*std_npm_args\(ignore_scripts: false\)/
  );
  assert.match(formula, /bin\.install_symlink libexec\.glob\("bin\/\*"\)/);
  assert.doesNotMatch(
    formula,
    /node@20|python-setuptools|npm", "run", "build"/
  );

  assert.match(cask, /Libre-WebUI-Frontend-#\{version\}-mac-arm64\.dmg/);
  assert.match(cask, /verified: "github\.com\/libre-webui\/libre-webui\/"/);
  assert.match(cask, /depends_on arch: :arm64/);
  assert.match(cask, /depends_on macos: :monterey/);
  assert.match(cask, /app "Libre WebUI Frontend\.app"/);
  assert.doesNotMatch(
    cask,
    /Libre\.WebUI-|app "Libre WebUI\.app"|auto_updates/
  );
});

test('release packaging and Homebrew metadata stay aligned', () => {
  const releaseWorkflow = readRepoFile('.github/workflows/release.yml');
  const electronBuilder = readRepoFile('electron-builder.yml');

  assert.match(
    electronBuilder,
    /artifactName: 'Libre-WebUI-Frontend-\$\{version\}-mac-arm64\.\$\{ext\}'/
  );
  assert.match(releaseWorkflow, /electron-builds\/\*\*\/\*\.dmg/);
  assert.match(
    readRepoFile('homebrew/libre-webui-cask.template'),
    /Libre-WebUI-Frontend-#\{version\}-mac-arm64\.dmg/
  );
});

test('Homebrew renderer produces a current formula and cask together', () => {
  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-webui-homebrew-')
  );

  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/render-homebrew-files.mjs'),
        '--version',
        '9.8.7',
        '--npm-sha',
        'a'.repeat(64),
        '--dmg-sha',
        'b'.repeat(64),
        '--output-dir',
        outputDir,
      ],
      { cwd: repoRoot, stdio: 'pipe' }
    );

    const formula = fs.readFileSync(
      path.join(outputDir, 'Formula/libre-webui.rb'),
      'utf8'
    );
    const cask = fs.readFileSync(
      path.join(outputDir, 'Casks/libre-webui.rb'),
      'utf8'
    );

    assert.match(formula, /libre-webui-9\.8\.7\.tgz/);
    assert.match(formula, new RegExp(`sha256 "${'a'.repeat(64)}"`));
    assert.match(cask, /version "9\.8\.7"/);
    assert.match(cask, new RegExp(`sha256 "${'b'.repeat(64)}"`));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
