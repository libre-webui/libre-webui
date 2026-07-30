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

### OpenAI Image Generation

The bundled OpenAI provider exposes the Image API at
`https://api.openai.com/v1/images/generations`. Its image catalog includes
`gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, and `gpt-image-1-mini`.

Image generation uses the same user-scoped OpenAI API key as Chat, but it has a
separate optional `image_endpoint` override. This prevents a custom Chat
endpoint from accidentally receiving image requests. Leave `image_endpoint`
blank to inherit the bundled Image API endpoint.

Image selections are provider-qualified. When two image plugins expose the same
model ID, Libre WebUI sends the request only to the provider selected in the
image panel. GPT Image responses use base64 image data; Libre WebUI converts
that data to an in-app image and saves it to the current user's gallery.
Direct Image API requests may set `n` to a JSON integer from 1 through 10;
numeric strings and fractional values are rejected before reaching the provider.

### Chat Completions and Responses API modes

OpenAI-compatible completion plugins can use either `chat_completions` or
`responses` request semantics. The bundled OpenAI plugin exposes this choice in
**Settings → Plugins**.

Connection settings are resolved in this order:

1. A full `endpoint` override, when configured.
2. `base_url` plus an optional `api_path`.
3. The plugin's legacy `endpoint`.

An endpoint value that exactly matches the plugin manifest's endpoint is
treated as the manifest default, not as an override. This keeps legacy stored
defaults from shadowing a new Base URL after an upgrade. A genuinely custom
full endpoint still has highest precedence.

The default path is `/chat/completions` in Chat Completions mode and
`/responses` in Responses mode. `base_url` should be the API root, such as
`https://api.example.com/v1`; use `api_path` when a compatible provider exposes
the operation at a different relative path. A full endpoint must include the
complete operation path and takes precedence over both fields. A known
`/chat/completions`, `/completions`, or `/responses` suffix is authoritative for
request semantics; custom endpoint paths retain the selected `api_mode`.

Imported plugin JSON can provide the same defaults:

```json
{
  "endpoint": "https://api.example.com/v1/chat/completions",
  "api_mode": "responses",
  "base_url": "https://api.example.com/v1",
  "api_path": "/responses"
}
```

Responses requests use `input`, `max_output_tokens`, flattened function tools,
and `store: false`. Completed and streamed Responses output is normalized back
to Libre WebUI's chat and Work event formats. During stateless Work tool loops,
Libre WebUI retains and replays the provider's ordered output Items verbatim,
including encrypted reasoning and assistant `phase`, before appending function
results. An incomplete Responses result is not treated as a successful Chat or
Work turn; its `incomplete_details.reason` is retained and surfaced to the
caller.

Model discovery derives `/models` from either operation path. For example,
`https://api.example.com/v1/responses` discovers from
`https://api.example.com/v1/models`. Providers without a compatible model-list
endpoint can still use a manual `model_map`. Discovery is scoped to the current
user's variables and credentials. Results are persisted per user rather than
written into the shared plugin manifest. Discovery runs after activation,
explicit refresh, API-key changes, connection-variable changes, and variable
resets; unrelated generation-variable saves do not trigger a network request.
The final derived discovery URL is checked before the user's credential is read
or an authorization header is built, including when the URL originates in an
imported plugin manifest.

Remote endpoints must use HTTPS. Plain HTTP is accepted only for exact loopback
hosts (`localhost`, `127.0.0.1`, or `[::1]`) and private IPv4 literals in the
`10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16` ranges. Requests originate
from the backend, so `localhost` identifies the Libre WebUI container when the
backend runs in a container. Plugin capability routes, including image
generation, resolve endpoint variables and credentials for the requesting
user. Single-user mode uses the `default` user.

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
