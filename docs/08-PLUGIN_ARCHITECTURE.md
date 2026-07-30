---
sidebar_position: 3
title: 'Plugins'
description: 'Plugin system for AI providers, image generation, text-to-speech, speech-to-text, and embeddings.'
slug: /PLUGIN_ARCHITECTURE
keywords:
  [plugins, openai, anthropic, tts, image generation, comfyui, embeddings]
---

# Plugins

Libre WebUI uses plugins to connect external AI providers and model capabilities alongside local Ollama.

## Plugin Types

| Type             | Purpose                                          |
| ---------------- | ------------------------------------------------ |
| Chat/completion  | Text and chat models from provider APIs          |
| Embeddings       | Vector embeddings for document search and memory |
| Image generation | Image models and ComfyUI-style backends          |
| Text-to-speech   | Voice synthesis providers                        |
| Speech-to-text   | Transcription providers                          |

Plugins can expose static model maps and, where supported, refresh available models from provider APIs.

## Built-In Provider Families

Libre WebUI includes provider definitions for common services:

- OpenAI and OpenAI-compatible APIs
- Anthropic
- Google Gemini
- Groq
- Kimi Code by Moonshot AI
- Mistral
- OpenRouter
- Hugging Face
- GitHub Models
- MLX LM for local Apple Silicon inference
- ComfyUI
- ElevenLabs

Provider catalogs change frequently. The UI should be treated as the source of truth for live model discovery when a plugin supports it.

## Credentials

Credentials can come from environment variables or from user settings.

Environment examples:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...
MISTRAL_API_KEY=...
OPENROUTER_API_KEY=sk-or-...
KIMI_API_KEY=...
GITHUB_API_KEY=github_pat_...
ELEVENLABS_API_KEY=...
```

For shared deployments, user-level credentials are usually better because each user controls their own provider billing and limits. Environment keys are useful for single-user installs, demos, or managed deployments.

## OpenAI-Compatible Providers

Many providers expose an OpenAI-compatible API. A plugin can define:

- Full API endpoint URL
- API key environment variable
- Chat endpoint behavior
- Embedding support
- Model discovery behavior
- Optional model map fallback

If a provider does not support live model discovery, Libre WebUI uses the configured model map.

### Capability-specific endpoints

Chat endpoint overrides are isolated from image, embedding, and text-to-speech
capabilities. Multi-capability plugins can expose `image_endpoint`,
`embedding_endpoint`, or `tts_endpoint` variables (or name another variable
with `config.endpoint_variable`). Leaving those fields blank uses the
capability endpoint declared by the plugin; a generic Chat `endpoint` is never
used as a capability override.

The bundled GitHub Models plugin inherits its current
`models.github.ai/inference/chat/completions` endpoint when its optional
override is blank. The Hugging Face plugin uses task-specific
`hf-inference/models/{model}` routes and payloads for embeddings, images, and
text-to-speech rather than sending those requests to its Chat endpoint.

### Endpoint Overrides

The `endpoint` variable is the complete request URL, including the operation
path. For example, an OpenAI-compatible chat plugin normally uses a URL such as
`https://provider.example/v1/chat/completions`, not only
`https://provider.example`.

Remote endpoints must use HTTPS. Plain HTTP is accepted only for exact loopback
hosts (`localhost`, `127.0.0.1`, or `[::1]`) and private IPv4 literals in the
`10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16` ranges. A hostname that
merely looks private, such as `10.example.com`, is still a remote hostname and
requires HTTPS. Other protocols are rejected. Leaving the override empty uses
the full endpoint from the plugin definition; an explicit invalid or unsafe
override is rejected instead of silently routing to that default.

Remember that requests originate from the Libre WebUI backend. In a container,
`localhost` identifies the container itself, not automatically the container
host or another service.

### Model Discovery

When a plugin is activated, Libre WebUI attempts model discovery with the
activating user's saved endpoint override and API key. For compatible APIs, it
derives a model-list URL from the full endpoint:

- a URL ending in `/models` is used as-is;
- known operation suffixes such as `/chat/completions`, `/completions`,
  `/embeddings`, or `/messages` are replaced with `/models`;
- otherwise, `/models` is appended to the path.

Discovery expects an OpenAI-compatible response containing model IDs in a
`data` array. Activation waits for that attempt before returning, so the first
plugin-list refresh can include the discovered catalog. Successful results are
stored per user and overlaid on that user's plugin view; Libre WebUI does not
rewrite the shared plugin JSON or expose one user's discovered model IDs to
another account. If the provider has no compatible model-list endpoint, cannot
be reached, or returns another response shape, that user keeps their previous
discovery result or the plugin's `model_map` fallback.

Plugin capability routes use the same user context. For example, image model
availability, endpoint variables, and credentials are resolved for the user
making the request. In single-user mode, these values belong to the `default`
user.

## Exact Provider Selection in Chat

Model IDs are not globally unique. An Ollama model and multiple active plugins
can all expose a model named `example-model`. Chat therefore stores the raw
model ID together with optional provider identity:

- `providerType: "ollama"` identifies the local or configured Ollama route;
- `providerType: "plugin"` plus `providerId` identifies one exact plugin.

Provider-qualified, URL-encoded values are used only as collision-safe keys in
model selectors. Requests continue to send the provider's raw model ID.
Duplicate Ollama/plugin and plugin/plugin model names remain separate choices,
and reopening a chat restores the exact choice that was saved.

Explicit provider identity fails closed. If a selected plugin is deactivated,
removed, or no longer advertises that model, Libre WebUI keeps the saved
selection visible as unavailable and does not silently switch to another
provider with the same model name. Reactivate the provider or explicitly choose
another model before generating again.

Sessions and preferences created before provider identity was stored can have
`providerType` and `providerId` unset or `null`. These legacy records retain
their historical name-only routing for compatibility because the original
provider cannot be reconstructed reliably. The selector shows these records as
"provider not recorded" rather than guessing an Ollama or plugin label.
Selecting a concrete provider entry records an exact provider for subsequent
requests. New persona selections keep their `persona:<id>` UI identity and are
recorded as Ollama-backed.

## Plugins in Work

Work can use active `completion` and `chat` plugins in addition to Ollama and
Ollama Cloud. A plugin-backed Work run is accepted only when:

- the plugin is active;
- its model is present in the current user's discovered catalog or the
  plugin's configured model map; and
- credentials are available for the current administrator.

Work keeps the selected provider type and plugin ID with both the task and each
run. Routing is therefore based on the exact saved provider, not only the model
name. Activating a plugin whose model name matches an Ollama model cannot
silently redirect an existing task.

Work adapts tool calls through native OpenAI-compatible, Anthropic, and Gemini
request/response formats. The selected model must support tool calling even if
the provider offers ordinary chat completions. If the provider rejects tools or
returns an incompatible response, the run fails without falling back to another
provider.

A remote Work run can make several provider requests. The provider receives the
Work system prompt, conversation context, tool definitions, and requested tool
results. Tool results can contain source files, directory listings, or command
output. Libre WebUI shows a per-user, dismissible remote-provider disclosure in
Work; operators should still review provider pricing, retention, and training
policies before enabling a service for sensitive projects.

## Embeddings

Embedding-capable plugins can appear in the document embedding settings. Libre WebUI also detects likely Ollama embedding models such as `nomic-embed-text`, `bge`, `e5`, `gte`, and similar model names.

When no embedding model is discovered, the UI falls back to `nomic-embed-text` as the local default candidate.

## Plugin Development Notes

A plugin definition should describe the capability clearly and avoid pretending a provider supports features it does not expose. Keep model maps small enough to be useful as fallbacks, and prefer discovery for providers with fast, reliable model-list APIs.

When adding a provider:

1. Add the plugin definition.
2. Define the credential key or user credential fields.
3. Implement model discovery if the provider offers a model-list endpoint.
4. Add request mapping for chat, embeddings, image, TTS, or STT.
5. Test missing-key, bad-key, and provider-error states.

## Related Docs

- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Working with Models](./WORKING_WITH_MODELS)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Kimi Code](./KIMI_CODE)
- [MLX LM on Apple Silicon](./MLX_APPLE_SILICON)
