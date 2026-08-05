import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import helmet from 'helmet';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const artifactsModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'routes', 'artifacts.js')
  ).href
);

const artifactsRouter = artifactsModule.default;

const listen = server =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Test server did not publish a TCP port.'));
        return;
      }
      resolve(address.port);
    });
  });

const close = server =>
  new Promise(resolve => {
    server.close(() => resolve());
  });

const withSandboxServer = async run => {
  const app = express();
  // The application policy that blocks inline scripts everywhere else. The
  // sandbox route has to escape it, so the test reproduces it faithfully.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
        },
      },
    })
  );
  app.use('/api/artifacts', artifactsRouter);

  const server = createServer(app);
  const port = await listen(server);
  try {
    await run(port);
  } finally {
    await close(server);
  }
};

test('the artifact sandbox host overrides the application script policy', async () => {
  await withSandboxServer(async port => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/artifacts/sandbox`
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);

    const policy = response.headers.get('content-security-policy') ?? '';
    // Inline script is the whole point: an artifact is inline script.
    assert.match(policy, /script-src [^;]*'unsafe-inline'/);
    assert.match(policy, /script-src [^;]*'unsafe-eval'/);
    // The application policy must not leak through.
    assert.doesNotMatch(policy, /challenges\.cloudflare\.com/);
  });
});

test('artifacts cannot reach the network or escape their frame', async () => {
  await withSandboxServer(async port => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/artifacts/sandbox`
    );
    const policy = response.headers.get('content-security-policy') ?? '';

    assert.match(policy, /default-src 'none'/);
    // No directive may name an external scheme or host: artifacts are
    // self-contained, so a compromised one has nowhere to send anything.
    assert.doesNotMatch(policy, /https:/);
    assert.doesNotMatch(policy, /http:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/);
    assert.match(policy, /frame-ancestors [^;]*'self'/);
    assert.match(policy, /sandbox [^;]*allow-scripts/);
    assert.doesNotMatch(policy, /sandbox [^;]*allow-same-origin/);
    // frame-ancestors is authoritative; a stray SAMEORIGIN header would block
    // the development server and the desktop build's file:// document.
    assert.equal(response.headers.get('x-frame-options'), null);
  });
});

test('the sandbox host carries no artifact markup of its own', async () => {
  await withSandboxServer(async port => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/artifacts/sandbox`
    );
    const body = await response.text();

    // The host only announces itself and waits; artifact markup arrives over
    // postMessage and is rendered in a nested frame.
    assert.match(body, /libre-artifact:ready/);
    assert.match(body, /libre-artifact:render/);
    assert.match(body, /event\.source !== host/);
    assert.doesNotMatch(body, /document\.write/);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  });
});

test('HTML artifact previews never inherit the application policy', () => {
  const frontendComponents = path.join(
    repoRoot,
    'frontend',
    'src',
    'components'
  );
  for (const filename of [
    'ArtifactRenderer.tsx',
    'ArtifactSlideOutPanel.tsx',
  ]) {
    const source = readFileSync(
      path.join(frontendComponents, filename),
      'utf8'
    );
    // srcDoc inherits the embedder's CSP, which is what broke HTML artifacts in
    // production. Only the SVG preview, which needs no script, may use it.
    assert.doesNotMatch(source, /srcDoc=\{buildHtmlArtifactDocument/);
    assert.match(source, /<HtmlArtifactFrame/);
  }

  const frame = readFileSync(
    path.join(frontendComponents, 'HtmlArtifactFrame.tsx'),
    'utf8'
  );
  assert.match(frame, /src=\{ARTIFACT_SANDBOX_URL\}/);
  assert.doesNotMatch(frame, /srcDoc/);
});
