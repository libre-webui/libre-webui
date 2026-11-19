import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distRoot = path.resolve(__dirname, '..', 'backend', 'dist');

const { buildPluginChatPayload, providerRequestContextHeaders } = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginChatAdapter.js')).href
);

const { isValidPluginRequestContextConfig } = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginValidation.js')).href
);

const requestContextConfig = {
  conversation_id_header: 'X-Libre-Conversation-Id',
  message_id_header: 'X-Libre-Message-Id',
  operation_header: 'X-Libre-Operation',
};

test('plugins without request-context configuration send no context headers', () => {
  assert.deepEqual(
    providerRequestContextHeaders(
      {},
      {
        conversationId: 'conversation-1',
        messageId: 'message-1',
        operation: 'chat',
      }
    ),
    {}
  );
});

test('configured request-context headers are generated', () => {
  assert.deepEqual(
    providerRequestContextHeaders(
      { request_context: requestContextConfig },
      {
        conversationId: 'conversation-1',
        messageId: 'message-1',
        operation: 'chat',
      }
    ),
    {
      'X-Libre-Conversation-Id': 'conversation-1',
      'X-Libre-Message-Id': 'message-1',
      'X-Libre-Operation': 'chat',
    }
  );
});

test('plugin chat payload includes configured request-context headers', () => {
  const plugin = {
    id: 'custom-provider',
    name: 'Custom provider',
    type: 'completion',
    active: true,
    endpoint: 'https://provider.example/v1/chat/completions',
    api_mode: 'chat_completions',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'CUSTOM_PROVIDER_API_KEY',
    },
    model_map: ['chat-model'],
    request_context: requestContextConfig,
  };

  const result = buildPluginChatPayload(
    plugin,
    'chat-model',
    [
      {
        id: 'message-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      },
    ],
    {},
    {},
    false,
    'chat_completions',
    undefined,
    {
      conversationId: 'conversation-1',
      messageId: 'message-1',
      operation: 'chat',
    }
  );

  assert.deepEqual(result.headers, {
    'X-Libre-Conversation-Id': 'conversation-1',
    'X-Libre-Message-Id': 'message-1',
    'X-Libre-Operation': 'chat',
  });
  assert.equal(result.payload.model, 'chat-model');
  assert.equal(result.payload.stream, false);
});

test('missing request-context values are omitted', () => {
  assert.deepEqual(
    providerRequestContextHeaders(
      { request_context: requestContextConfig },
      {
        conversationId: 'conversation-1',
        operation: 'title',
      }
    ),
    {
      'X-Libre-Conversation-Id': 'conversation-1',
      'X-Libre-Operation': 'title',
    }
  );
});

test('invalid provider context values are rejected', () => {
  const plugin = { request_context: requestContextConfig };

  for (const invalidValue of [
    '',
    'contains space',
    'contains\nnewline',
    'non-ascii-ž',
    'x'.repeat(513),
  ]) {
    assert.throws(
      () =>
        providerRequestContextHeaders(plugin, {
          conversationId: invalidValue,
        }),
      /invalid value/
    );
  }
});

test('valid provider request-context configuration is accepted', () => {
  assert.equal(
    isValidPluginRequestContextConfig(requestContextConfig, 'Authorization'),
    true
  );
});

test('duplicate request-context headers are rejected case-insensitively', () => {
  assert.equal(
    isValidPluginRequestContextConfig(
      {
        conversation_id_header: 'X-Libre-Context',
        message_id_header: 'x-libre-context',
      },
      'Authorization'
    ),
    false
  );
});

test('authentication-header collisions are rejected case-insensitively', () => {
  assert.equal(
    isValidPluginRequestContextConfig(
      {
        conversation_id_header: 'x-api-key',
      },
      'X-API-Key'
    ),
    false
  );
});

test('forbidden transport and credential headers are rejected', () => {
  for (const header of [
    'Authorization',
    'Host',
    'Content-Length',
    'Cookie',
    'Connection',
    'Transfer-Encoding',
  ]) {
    assert.equal(
      isValidPluginRequestContextConfig(
        {
          conversation_id_header: header,
        },
        'X-Provider-Key'
      ),
      false
    );
  }
});

test('invalid and unknown request-context fields are rejected', () => {
  assert.equal(
    isValidPluginRequestContextConfig(
      {
        conversation_id_header: 'Invalid Header',
      },
      'Authorization'
    ),
    false
  );

  assert.equal(
    isValidPluginRequestContextConfig(
      {
        conversation_id_header: 'X-Libre-Conversation-Id',
        unexpected_header: 'X-Unexpected',
      },
      'Authorization'
    ),
    false
  );
});
