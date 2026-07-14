import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pluginTTSModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'pluginTTSService.js')
  ).href
);
const { PluginTTSService } = pluginTTSModule;

function createPlugin(id, endpoint) {
  return {
    id,
    name: id,
    type: 'tts',
    endpoint,
    auth: { header: '', key_env: '' },
    model_map: ['tts-1-hd'],
    capabilities: {
      tts: {
        endpoint,
        model_map: ['tts-1-hd'],
        config: {
          voices: ['alba'],
          default_voice: 'alba',
          formats: ['wav'],
          default_format: 'wav',
          no_auth_required: true,
        },
      },
    },
  };
}

function startServer(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

test('TTS routes a shared model alias through the selected plugin and user valve', async () => {
  const requests = [];
  const providerServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(Buffer.from('RIFFtest-audio'));
  });
  const providerPort = await startServer(providerServer);
  const savedEndpoint = `http://127.0.0.1:${providerPort}/v1/audio/speech`;
  const plugins = [
    createPlugin('wrong-provider', 'http://127.0.0.1:9/wrong'),
    createPlugin('kyutai-tts-1.6b', 'http://127.0.0.1:9/default'),
  ];
  const apiKeyLookups = [];
  const variableLookups = [];
  const service = new PluginTTSService({
    getAllPlugins: () => plugins,
    getPlugin: id => plugins.find(plugin => plugin.id === id) || null,
    getApiKey: (plugin, userId) => {
      apiKeyLookups.push({ pluginId: plugin.id, userId });
      return null;
    },
    getPluginVariables: (plugin, userId) => {
      variableLookups.push({ pluginId: plugin.id, userId });
      return { endpoint: savedEndpoint, speed: 1.25 };
    },
    validateEndpointUrl: endpoint => endpoint,
  });

  try {
    const models = service.getAvailableTTSModels('user-42');
    assert.deepEqual(
      models.map(({ model, plugin }) => ({ model, plugin })),
      [
        { model: 'tts-1-hd', plugin: 'wrong-provider' },
        { model: 'tts-1-hd', plugin: 'kyutai-tts-1.6b' },
      ]
    );

    const audio = await service.executeTTSRequest(
      'tts-1-hd',
      'hello from a user valve',
      {
        pluginId: 'kyutai-tts-1.6b',
        userId: 'user-42',
        voice: 'alba',
        response_format: 'wav',
      }
    );

    assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.ok(apiKeyLookups.every(lookup => lookup.userId === 'user-42'));
    assert.equal(apiKeyLookups.at(-1)?.pluginId, 'kyutai-tts-1.6b');
    assert.deepEqual(variableLookups, [
      { pluginId: 'kyutai-tts-1.6b', userId: 'user-42' },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/v1/audio/speech');
    assert.deepEqual(JSON.parse(requests[0].body), {
      model: 'tts-1-hd',
      input: 'hello from a user valve',
      voice: 'alba',
      response_format: 'wav',
      speed: 1.25,
    });
  } finally {
    await new Promise(resolve => providerServer.close(resolve));
  }
});
