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
    // No directive outside frame-ancestors may name any origin at all. The
    // runtime is inlined into the document, so the frame fetches nothing —
    // which is what keeps artifacts working behind an authenticating proxy,
    // where a sandboxed frame's cookie-less request returns a login redirect.
    const fetching = policy
      .split(';')
      .map(directive => directive.trim())
      .filter(directive => !/^(frame-ancestors|sandbox)\b/.test(directive));
    for (const directive of fetching) {
      assert.doesNotMatch(directive, /https?:/, `origin in "${directive}"`);
      assert.doesNotMatch(directive, /'self'/, `'self' in "${directive}"`);
    }
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

test('artifact previews never inherit the application policy', () => {
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
    assert.match(source, /<ArtifactSandboxFrame/);
    // Every live kind goes through the sandbox.
    for (const kind of ['html', 'react', 'mermaid']) {
      assert.match(source, new RegExp(`renderSandbox\\('${kind}'\\)`));
    }
  }

  const frame = readFileSync(
    path.join(frontendComponents, 'ArtifactSandboxFrame.tsx'),
    'utf8'
  );
  assert.match(frame, /src=\{ARTIFACT_SANDBOX_URL\}/);
  assert.doesNotMatch(frame, /srcDoc/);
});

test('the runtime is vendored, never fetched from a CDN', () => {
  const manifest = readFileSync(
    path.join(repoRoot, 'frontend', 'src', 'artifact-runtime', 'manifest.ts'),
    'utf8'
  );
  assert.match(manifest, /ARTIFACT_RUNTIME_PATH = '\/artifact-runtime'/);

  const documents = readFileSync(
    path.join(
      repoRoot,
      'frontend',
      'src',
      'utils',
      'artifactRuntimeDocument.ts'
    ),
    'utf8'
  );
  // The document carries its dependencies as inline script; nothing in it
  // points the frame at a URL.
  assert.match(documents, /rewriteGeneratedHtml/);
  assert.doesNotMatch(documents, /<script[^>]*src=/);
  // An import map only names URLs the frame cannot fetch, so generated ones
  // are stripped and their specifiers resolved from the registry instead.
  assert.match(documents, /import map removed/);
  assert.match(documents, /runInline/);
  // Generated markup is parsed, not pattern-matched: every regex written
  // against it here eventually met a shape it mishandled.
  assert.match(documents, /new DOMParser\(\)\.parseFromString/);
  assert.doesNotMatch(documents, /html\.replace\(/);
  // Artifact code travels as data, with every < escaped, so it cannot end the
  // element it is embedded in.
  assert.match(documents, /jsStringLiteral/);
  assert.match(documents, /\\\\u003c/);

  const loader = readFileSync(
    path.join(repoRoot, 'frontend', 'src', 'utils', 'artifactRuntimeLoader.ts'),
    'utf8'
  );
  // The application page fetches the bundles, with its session.
  assert.match(loader, /credentials: 'same-origin'/);
});
