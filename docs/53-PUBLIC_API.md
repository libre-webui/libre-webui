---
sidebar_position: 53
title: 'Public API'
description: 'OpenAI-compatible /v1 endpoints and scoped API tokens for programmatic access to Libre WebUI.'
slug: /PUBLIC_API
keywords: [public api, openai compatible, api tokens, chat completions]
---

# Public API

Libre WebUI exposes an OpenAI-compatible API so existing SDKs, editors, and
scripts can point at your instance with only a base-URL change.

## Authentication

Create a **scoped API token** under Settings → Account → API tokens (tokens
use the `lwk_` prefix and are stored hashed). The `/v1` surface requires
the `chat` scope. Pass the token as an ordinary bearer key:

```bash
export OPENAI_BASE_URL="https://your-instance/v1"
export OPENAI_API_KEY="lwk_..."
```

Requests are governed by the per-token rate limit (600 requests per
minute) and the shared chat rate limit.

## Endpoints

| Endpoint                   | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `GET /v1/models`           | Available models (local and provider-plugin backed)  |
| `POST /v1/chat/completions`| Stateless chat completion, streaming or not          |

`POST /v1/chat/completions` accepts the familiar body — `model`,
`messages` (system/user/assistant; multimodal text parts are flattened),
`stream`, `temperature`, `top_p`, `max_tokens`/`max_completion_tokens`,
`seed`, and `stop`. Streaming responses are `chat.completion.chunk` SSE
frames terminated by `data: [DONE]`; non-streaming responses include
`usage` token counts when the provider reports them.

```bash
curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2",
    "messages": [{"role": "user", "content": "One sentence on herons."}]
  }'
```

## Deliberate boundaries

The `/v1` surface is **stateless inference**: it never creates chats,
touches your knowledge base, or runs tools. Stateful conversations with
durable replayable events, cancellation by identity, idempotent enqueues,
and the native tool loop live on the native `/api/chat` event API, which
the same tokens can call with the `chat` scope. Roles other than
`system`/`user`/`assistant` (for example `tool`) are rejected rather than
silently accepted.

## Related Docs

- [Authentication](/AUTHENTICATION) — accounts, sessions, and API tokens
- [Chat Tools](/CHAT_TOOLS) — the native tool loop on the event API
