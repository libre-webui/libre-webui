/*
 * Image edit/inpaint/composite (IMAGE-01).
 *
 * Covers: the bundled OpenAI manifest's edit declaration staying inside its
 * trust anchor, the multipart edit contract (image, mask, prompt, auth),
 * capability enforcement (no edit endpoint, mask support, reference-image
 * ceilings), upload validation magic-byte/MIME/size checks, and usage
 * metering for edits.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const importBuilt = file =>
  import(pathToFileURL(path.join(repoRoot, 'backend', 'dist', file)).href);

const { PluginImageGenerationService } = await importBuilt(
  'services/pluginImageGenerationService.js'
);
const {
  validateImageEditUpload,
  detectImageEditFormat,
  ImageEditUploadError,
} = await importBuilt('utils/imageEditUpload.js');
const { getPluginDefinitionFingerprint, BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS } =
  await importBuilt('utils/pluginDefinitionTrust.js');

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('image-edit-fixture'),
]);
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('jpeg-fixture'),
]);

const editPlugin = (endpoint, config = {}) => ({
  id: 'edit-provider',
  name: 'edit-provider',
  type: 'completion',
  active: true,
  endpoint: 'https://example.com/v1/chat/completions',
  auth: {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'EDIT_PROVIDER_API_KEY',
  },
  model_map: [],
  capabilities: {
    image: {
      endpoint: 'https://example.com/v1/images/generations',
      model_map: ['edit-model'],
      config: {
        edit_endpoint: endpoint,
        supports_response_format: false,
        ...config,
      },
    },
  },
});

const serviceFor = (plugin, usageEvents = []) =>
  new PluginImageGenerationService({
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'edit-secret-key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: value => value,
    recordUsage: event => usageEvents.push(event),
  });

const startServer = server =>
  new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

const image = (buffer = PNG_BYTES, mimeType = 'image/png') => ({
  buffer,
  mimeType,
  filename: 'source.png',
});

test('the bundled OpenAI manifest declares editing inside its trust anchor', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'openai.json'), 'utf8')
  );
  const config = manifest.capabilities.image.config;
  assert.equal(config.edit_endpoint, 'https://api.openai.com/v1/images/edits');
  assert.equal(config.supports_mask, true);
  assert.equal(config.max_reference_images, 4);
  assert.deepEqual(config.edit_mime_types, [
    'image/png',
    'image/jpeg',
    'image/webp',
  ]);
  assert.equal(
    getPluginDefinitionFingerprint(manifest),
    BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS.openai,
    'the shipped trust anchor must match the manifest exactly'
  );
});

test('edits post an authorized multipart request and meter usage', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on('data', chunk => {
      body = Buffer.concat([body, chunk]);
    });
    req.on('end', () => {
      requests.push({
        url: req.url,
        contentType: req.headers['content-type'],
        authorization: req.headers.authorization,
        body: body.toString('latin1'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('edited').toString('base64') }],
        })
      );
    });
  });
  const port = await startServer(server);
  t.after(() => server.close());

  const usageEvents = [];
  const plugin = editPlugin(`http://127.0.0.1:${port}/v1/images/edits`, {
    supports_mask: true,
    max_reference_images: 2,
  });
  const service = serviceFor(plugin, usageEvents);
  const result = await service.executeImageEditRequest(
    'edit-model',
    'replace the sky',
    [image()],
    image(PNG_BYTES, 'image/png'),
    { pluginId: plugin.id, userId: 'editor-user', size: '1024x1024' }
  );

  assert.equal(result.images[0].b64_json, Buffer.from('edited').toString('base64'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/images/edits');
  assert.match(requests[0].contentType, /^multipart\/form-data;/);
  assert.equal(requests[0].authorization, 'Bearer edit-secret-key');
  assert.match(requests[0].body, /name="model"/);
  assert.match(requests[0].body, /name="prompt"/);
  assert.match(requests[0].body, /name="image"/);
  assert.match(requests[0].body, /name="mask"/);
  assert.match(requests[0].body, /name="size"/);
  assert.doesNotMatch(
    requests[0].body,
    /name="response_format"/,
    'providers that reject response_format never receive it'
  );
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].capability, 'image');
  assert.equal(usageEvents[0].status, 'success');
  assert.equal(usageEvents[0].outputUnits, 1);
});

test('capability limits are enforced before any provider call', async () => {
  const noEdit = editPlugin(undefined);
  delete noEdit.capabilities.image.config.edit_endpoint;
  await assert.rejects(
    serviceFor(noEdit).executeImageEditRequest(
      'edit-model',
      'prompt',
      [image()],
      null,
      { pluginId: noEdit.id }
    ),
    /does not support image editing/
  );

  const noMask = editPlugin('http://127.0.0.1:9/v1/images/edits', {
    supports_mask: false,
  });
  await assert.rejects(
    serviceFor(noMask).executeImageEditRequest(
      'edit-model',
      'prompt',
      [image()],
      image(),
      { pluginId: noMask.id }
    ),
    /does not support edit masks/
  );

  const single = editPlugin('http://127.0.0.1:9/v1/images/edits', {
    max_reference_images: 1,
  });
  await assert.rejects(
    serviceFor(single).executeImageEditRequest(
      'edit-model',
      'prompt',
      [image(), image()],
      null,
      { pluginId: single.id }
    ),
    /at most 1 reference image/
  );

  await assert.rejects(
    serviceFor(single).executeImageEditRequest(
      'edit-model',
      '   ',
      [image()],
      null,
      { pluginId: single.id }
    ),
    /Invalid prompt/
  );
});

test('upload validation sniffs magic bytes and enforces MIME and size', () => {
  assert.equal(detectImageEditFormat(PNG_BYTES), 'png');
  assert.equal(detectImageEditFormat(JPEG_BYTES), 'jpeg');
  assert.equal(detectImageEditFormat(Buffer.from('not an image')), null);

  const valid = validateImageEditUpload(
    { buffer: PNG_BYTES, mimetype: 'image/png', size: PNG_BYTES.length },
    { filename: 'a.png' }
  );
  assert.equal(valid.mimeType, 'image/png');

  assert.throws(
    () =>
      validateImageEditUpload(
        { buffer: JPEG_BYTES, mimetype: 'image/png', size: JPEG_BYTES.length },
        { filename: 'a.png' }
      ),
    error =>
      error instanceof ImageEditUploadError &&
      error.code === 'signature_mismatch'
  );

  assert.throws(
    () =>
      validateImageEditUpload(
        { buffer: JPEG_BYTES, mimetype: 'image/jpeg', size: JPEG_BYTES.length },
        { filename: 'a.jpg' }
      ),
    error =>
      error instanceof ImageEditUploadError &&
      error.code === 'unsupported_mime_type',
    'PNG-only is the default when a model does not broaden edit_mime_types'
  );

  assert.throws(
    () =>
      validateImageEditUpload(
        { buffer: PNG_BYTES, mimetype: 'image/png', size: PNG_BYTES.length },
        { filename: 'a.png', maxBytes: 4 }
      ),
    error =>
      error instanceof ImageEditUploadError && error.code === 'file_too_large'
  );

  assert.throws(
    () =>
      validateImageEditUpload(
        { buffer: Buffer.from('junk'), mimetype: 'image/png', size: 4 },
        { filename: 'a.png' }
      ),
    error =>
      error instanceof ImageEditUploadError &&
      error.code === 'signature_mismatch'
  );
});
