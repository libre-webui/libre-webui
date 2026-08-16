---
sidebar_position: 47
title: 'OpenAI-Compatible API'
description: 'Point any OpenAI SDK or tool at your Libre WebUI server. Scoped personal API keys, /v1/models and /v1/chat/completions, streaming included.'
slug: /OPENAI_COMPATIBLE_API
keywords:
  [
    openai compatible,
    v1 api,
    chat completions,
    api keys,
    sdk,
    streaming,
    rest api,
  ]
---

# OpenAI-Compatible API

Libre WebUI serves an OpenAI-compatible API at `/v1`, so any OpenAI SDK,
CLI, or integration can use your server as its provider. A request routes
through the same provider selection as the Chat page: a model name resolves
to local Ollama or to one of your active provider connections. Completions
on this surface are one-shot — nothing is written to your conversations.

## Authentication

Use a personal API key as the bearer token. Settings → API keys mints
scoped tokens (prefix `lwk_`); see
[Authentication](/AUTHENTICATION) for how keys are issued and revoked.

- `GET /v1/models` needs the **models** scope.
- `POST /v1/chat/completions` needs the **chat** scope.
- A key with the **admin** scope can call everything.

Requests with a key that lacks the required scope are rejected with `403`.
Your regular browser session (JWT) also works, which is handy for quick
local tests.

```bash
curl http://localhost:3001/v1/models \
  -H "Authorization: Bearer lwk_your_key_here"
```

## Endpoints

### `GET /v1/models`

Lists every chat-capable model you can use — local Ollama models plus the
models of your active provider connections. Non-chat model families
(embeddings, speech, image, moderation, rerankers) are filtered out.

### `POST /v1/chat/completions`

Standard chat completions, streaming and non-streaming.

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="lwk_your_key_here",
)

response = client.chat.completions.create(
    model="llama3.2:3b",
    messages=[{"role": "user", "content": "Say hi"}],
)
print(response.choices[0].message.content)
```

Supported request fields: `model`, `messages` (roles `system`, `user`,
`assistant`), `temperature`, `top_p`, `max_tokens` /
`max_completion_tokens`, `stop`, `stream`, and
`stream_options.include_usage`. Content must be text — strings or
`{"type": "text"}` content parts; image and audio parts return `400`.

Streaming responses are standard server-sent `chat.completion.chunk`
frames ending with `data: [DONE]`. Models that expose their reasoning
stream it as `reasoning_content` in the delta, alongside the usual
`content`. Token usage is reported when the provider supplies it — always
in non-streaming responses, and in the final stream chunk when
`stream_options.include_usage` is set.

## Behavior and limits

- **One-shot**: requests carry their full context; nothing is persisted to
  chat history and no persona or preference rewriting is applied.
- **Honest failures**: provider errors surface as OpenAI-style
  `{"error": {"message", "type", "code"}}` bodies instead of silently
  falling back to another provider.
- **Rate limit**: 600 requests per 5 minutes per client.
- **Text only** for now: multimodal parts, tool calls, and the legacy
  `/v1/completions` surface are not implemented.
