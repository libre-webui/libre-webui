import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const defaults = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'ollamaModelDefaults.js')
  ).href
);

const {
  parseModelParameters,
  parseModelContextLength,
  parseOllamaModelDefaults,
} = defaults;

test('modelfile parameters are read as the model recommends them', () => {
  const options = parseModelParameters(
    [
      'stop                           "<|im_start|>"',
      'stop                           "<|im_end|>"',
      'temperature                    0.6',
      'top_p                          0.95',
      'top_k                          20',
      'repeat_penalty                 1.05',
      'penalize_newline               false',
      '# a comment line',
      'garbage',
    ].join('\n')
  );

  // Repeated stop sequences collect into one list; missing them is what makes
  // a model ramble past its turn.
  assert.deepEqual(options.stop, ['<|im_start|>', '<|im_end|>']);
  assert.equal(options.temperature, 0.6);
  assert.equal(options.top_p, 0.95);
  assert.equal(options.top_k, 20);
  assert.equal(options.repeat_penalty, 1.05);
  assert.equal(options.penalize_newline, false);
  // Comments and malformed lines contribute nothing.
  assert.equal(Object.keys(options).length, 6);
});

test('empty or absent parameters yield no options', () => {
  assert.deepEqual(parseModelParameters(undefined), {});
  assert.deepEqual(parseModelParameters('   \n  '), {});
});

test('the trained context length is read from the architecture metadata', () => {
  assert.equal(
    parseModelContextLength({
      'general.architecture': 'qwen3',
      'qwen3.context_length': 40960,
      'llama.context_length': 4096,
    }),
    40960
  );

  // Without a named architecture, any context length is better than none.
  assert.equal(
    parseModelContextLength({ 'gemma3.context_length': 8192 }),
    8192
  );
  assert.equal(parseModelContextLength(undefined), undefined);
  assert.equal(
    parseModelContextLength({ 'general.architecture': 'x' }),
    undefined
  );
});

test('a trained context is adopted, and capped so the model still loads', () => {
  const modest = parseOllamaModelDefaults({
    parameters: 'temperature 0.7',
    model_info: {
      'general.architecture': 'qwen3',
      'qwen3.context_length': 8192,
    },
  });
  assert.equal(modest.options.num_ctx, 8192);
  assert.equal(modest.contextCapped, false);
  assert.equal(modest.trainedContextLength, 8192);

  const huge = parseOllamaModelDefaults({
    model_info: {
      'general.architecture': 'llama',
      'llama.context_length': 131072,
    },
  });
  // The full window would allocate a KV cache far past most hardware.
  assert.equal(huge.options.num_ctx, 32768);
  assert.equal(huge.contextCapped, true);
  assert.equal(huge.trainedContextLength, 131072);
});

test('the validated provider contract controls context adoption and request clients', async () => {
  const previous = {
    timeout: process.env.OLLAMA_TIMEOUT,
    longTimeout: process.env.OLLAMA_LONG_OPERATION_TIMEOUT,
    maxContext: process.env.OLLAMA_MAX_CONTEXT,
  };
  process.env.OLLAMA_TIMEOUT = '210000';
  process.env.OLLAMA_LONG_OPERATION_TIMEOUT = '610000';
  process.env.OLLAMA_MAX_CONTEXT = '65536';
  try {
    const defaults = parseOllamaModelDefaults({
      model_info: {
        'general.architecture': 'llama',
        'llama.context_length': 131072,
      },
    });
    assert.equal(defaults.options.num_ctx, 65536);

    const { OllamaService } = await import(
      pathToFileURL(
        path.join(repoRoot, 'backend', 'dist', 'services', 'ollamaService.js')
      ).href
    );
    const { getOllamaRuntimeConfig } = await import(
      pathToFileURL(
        path.join(
          repoRoot,
          'backend',
          'dist',
          'platform',
          'ollamaRuntimeConfig.js'
        )
      ).href
    );
    // Constructing the service validates the contract; the timeouts it will
    // spend per request come from the same reader it reads on every call.
    const service = new OllamaService();
    assert.ok(service);
    const runtime = getOllamaRuntimeConfig();
    assert.equal(runtime.timeoutMs, 210000);
    assert.equal(runtime.longOperationTimeoutMs, 610000);
  } finally {
    if (previous.timeout === undefined) delete process.env.OLLAMA_TIMEOUT;
    else process.env.OLLAMA_TIMEOUT = previous.timeout;
    if (previous.longTimeout === undefined) {
      delete process.env.OLLAMA_LONG_OPERATION_TIMEOUT;
    } else {
      process.env.OLLAMA_LONG_OPERATION_TIMEOUT = previous.longTimeout;
    }
    if (previous.maxContext === undefined)
      delete process.env.OLLAMA_MAX_CONTEXT;
    else process.env.OLLAMA_MAX_CONTEXT = previous.maxContext;
  }
});

test("a modelfile's own num_ctx wins over the trained length", () => {
  const result = parseOllamaModelDefaults({
    parameters: 'num_ctx 4096',
    model_info: {
      'general.architecture': 'llama',
      'llama.context_length': 131072,
    },
  });

  // The author chose it deliberately; the trained maximum is not a target.
  assert.equal(result.options.num_ctx, 4096);
  assert.equal(result.contextCapped, false);
});

test('a model that says nothing produces no options at all', () => {
  const result = parseOllamaModelDefaults({});
  assert.deepEqual(result.options, {});
  assert.equal(result.trainedContextLength, undefined);
  assert.equal(parseOllamaModelDefaults(undefined).options.num_ctx, undefined);
});

test('the model has the last word over the application default, and the user over both', async () => {
  const { mergeGenerationOptions } = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'utils', 'generationUtils.js')
    ).href
  );

  // What the application ships with: a window far shorter than a modern model.
  const application = { temperature: 0.8, num_ctx: 2048, top_p: 0.9 };
  const recommended = parseOllamaModelDefaults({
    parameters: 'temperature 0.6\nstop "<|im_end|>"',
    model_info: {
      'general.architecture': 'qwen3',
      'qwen3.context_length': 40960,
    },
  }).options;
  const pinned = { temperature: 0.2 };

  const effective = mergeGenerationOptions(
    mergeGenerationOptions(application, recommended),
    pinned
  );

  // The model's context replaces the short default rather than being clamped.
  assert.equal(effective.num_ctx, 32768);
  // Its stop sequences arrive, which nothing in the application supplies.
  assert.deepEqual(effective.stop, ['<|im_end|>']);
  // The user's own choice still wins over the model's recommendation.
  assert.equal(effective.temperature, 0.2);
  // Untouched application settings survive.
  assert.equal(effective.top_p, 0.9);
});

test('a non-positive num_ctx never reaches Ollama', async () => {
  const { sanitizeOptionsForModel } = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'ollamaService.js')
    ).href
  );

  // Pins written while a hosted model was selected carry num_ctx: -1, which
  // hosted backends ignore but a local Ollama would take as a context size.
  // num_predict: -1 stays for local models; it is Ollama's own "unlimited".
  assert.deepEqual(
    sanitizeOptionsForModel('smollm2:latest', {
      num_ctx: -1,
      num_predict: -1,
      temperature: 0.8,
    }),
    { num_predict: -1, temperature: 0.8 }
  );

  // Hosted models reject both sentinels.
  assert.deepEqual(
    sanitizeOptionsForModel('deepseek-v4-pro:cloud', {
      num_ctx: -1,
      num_predict: -1,
      temperature: 0.8,
    }),
    { temperature: 0.8 }
  );

  // Real values pass through untouched, as the same object.
  const options = { num_ctx: 8192, num_predict: -1 };
  assert.equal(sanitizeOptionsForModel('smollm2:latest', options), options);
  assert.equal(sanitizeOptionsForModel('smollm2:latest', undefined), undefined);
});
