import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [{ default: express }, { createStaticAssetHandlers, pickEncoding }] =
  await Promise.all([
    import('express'),
    importBuilt('middleware/staticAssets.js'),
  ]);

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-static-'));
fs.mkdirSync(path.join(dist, 'js'));
fs.mkdirSync(path.join(dist, 'assets'));
const chunk = `export const answer = ${'42;'.repeat(2000)}`;
fs.writeFileSync(path.join(dist, 'js', 'app-Ab12Cd34.js'), chunk);
fs.writeFileSync(
  path.join(dist, 'assets', 'index-Zz99Yy88.css'),
  'body{margin:0}'
);
fs.writeFileSync(path.join(dist, 'index.html'), '<div id="root"></div>');
fs.writeFileSync(
  path.join(dist, 'sw.js'),
  'self.addEventListener("fetch", () => {});'
);

const app = express();
const handlers = createStaticAssetHandlers(dist);
app.use(handlers.compressedAssets, handlers.files);
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (route, headers = {}) => fetch(`${base}${route}`, { headers });

test('hashed bundles are served compressed and immutable, the shell revalidates', async () => {
  try {
    const brotli = await get('/js/app-Ab12Cd34.js', {
      'accept-encoding': 'gzip, deflate, br',
    });
    assert.equal(brotli.status, 200);
    assert.equal(brotli.headers.get('content-encoding'), 'br');
    assert.equal(
      brotli.headers.get('cache-control'),
      'public, max-age=31536000, immutable'
    );
    assert.equal(brotli.headers.get('vary'), 'Accept-Encoding');
    assert.match(brotli.headers.get('content-type'), /javascript/);
    // fetch() transparently decodes; the declared length is the compressed size.
    assert.ok(Number(brotli.headers.get('content-length')) < chunk.length / 4);
    assert.equal(await brotli.text(), chunk);

    const gz = await get('/assets/index-Zz99Yy88.css', {
      'accept-encoding': 'gzip',
    });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.match(gz.headers.get('content-type'), /text\/css/);
    assert.equal(await gz.text(), 'body{margin:0}');

    const plain = await get('/js/app-Ab12Cd34.js', {
      'accept-encoding': 'identity',
    });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(
      plain.headers.get('cache-control'),
      'public, max-age=31536000, immutable'
    );
    assert.equal(await plain.text(), chunk);

    const shell = await get('/index.html', { 'accept-encoding': 'br' });
    assert.equal(shell.headers.get('cache-control'), 'no-cache');
    assert.equal(shell.headers.get('content-encoding'), null);
    const worker = await get('/sw.js', { 'accept-encoding': 'br' });
    assert.equal(worker.headers.get('cache-control'), 'no-cache');

    const missing = await get('/js/nope-Ab12Cd34.js', {
      'accept-encoding': 'br',
    });
    assert.equal(missing.status, 404);

    const head = await fetch(`${base}/js/app-Ab12Cd34.js`, {
      method: 'HEAD',
      headers: { 'accept-encoding': 'br' },
    });
    assert.equal(head.headers.get('content-encoding'), 'br');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('encoding negotiation honours client weights', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip;q=1.0, br;q=0.5'), 'gzip');
  assert.equal(pickEncoding('br;q=0'), null);
  assert.equal(pickEncoding('deflate'), null);
  assert.equal(pickEncoding('*'), 'br');
  assert.equal(pickEncoding(undefined), null);
});

// Sanity check the decoders exist for the shape of data we emit.
void brotliDecompressSync;
void gunzipSync;
