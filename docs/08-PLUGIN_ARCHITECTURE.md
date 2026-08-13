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
| Audio generation | Sound and audio-generation providers             |
| Video generation | Asynchronous video-generation providers          |

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

## Ownership and Authorization

Plugin definitions are shared instance configuration. Every `/api/plugins`
route requires authentication, and only administrators can upload, install,
update, or delete a definition. Activation is different: each authenticated
user can activate or deactivate a shared plugin only for their own account.
That state is stored in SQLite and survives backend restarts without affecting
another user's active providers.

During upgrade, the legacy global `.status.json` activation list is copied once
to the accounts that already exist, but only for definitions that exactly match
Libre WebUI's compiled trust anchors. Legacy custom or shadow definitions stay
quarantined and inactive. Accounts created after that migration start with no
plugins activated.

Bundled definitions are trusted only when their normalized contents match a
hash compiled into the backend. Writable definitions are approved in SQLite by
normalized source path and full definition hash. An administrator install,
update, or re-import records that approval; direct file changes invalidate it.
Approval and updates clear every account's activation before replacing the
file, so each user must reactivate the reviewed definition. Pre-upgrade custom
definitions must be re-imported by an administrator before they can appear in
catalogs, discover models, accept credentials, or execute any capability.

Plugin variables are split by purpose. Only administrators can store recognized
connection-routing variables:

`endpoint`, `base_url`, `api_path`, `models_endpoint`, `api_url`,
`image_endpoint`, `embedding_endpoint`, `stt_endpoint`, `tts_endpoint`,
`voice_clone_endpoint`, `api_mode`, `model`, and `model_id`. A capability's
declared `config.endpoint_variable`, `config.models_endpoint_variable`, or
`config.voice_clone_endpoint_variable` is also connection routing, even when
it uses a different name.

Non-administrators can continue to save generation controls such as temperature
and streaming preferences. Old routing rows belonging to a non-administrator
are ignored, are not returned as configured values, and are removed by that
account's full plugin-variable reset. This prevents a later role promotion from
silently reviving a dormant route.

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

An environment key is a fallback only while the request uses the routing and
authentication projection from an unshadowed bundled plugin definition. An
imported definition, a writable definition that shadows a bundled ID, or an
administrator's stored connection-routing override requires a credential saved
by the same account. Libre WebUI compares the root endpoint, authentication
fields, capability endpoints and endpoint-variable selectors, and recognized
routing-variable definitions and defaults before allowing environment fallback.
The compiled manifest hash remains authoritative even when the legacy and
bundled plugin directories share a path, as in the standard container layout;
an overwritten package manifest cannot establish its own trust.

This rule applies to discovery, Chat, Work, availability checks, and capability
catalogs. It prevents a custom endpoint or a pre-upgrade custom manifest from
receiving an operator-managed secret.

User-stored credentials are bound to the effective definition source, complete
definition hash, authentication contract, capability endpoints and selectors,
and effective routing values at the moment the user saves them. A route or
definition change makes the old credential unavailable until the user reviews
the new destination and saves the credential again. Legacy credentials without
a binding are accepted only on an exact anchored bundled route; their first
successful use writes the binding before returning the decrypted key.

## OpenAI-Compatible Providers

Many providers expose an OpenAI-compatible API. A plugin can define:

- Full API endpoint URL
- API key environment variable
- Chat endpoint behavior
- Embedding support
- Model discovery behavior
- Optional model map fallback

If a provider does not support live model discovery, Libre WebUI uses the configured model map.
Imported plugin JSON configures providers that already speak one of Libre
WebUI's supported wire formats: OpenAI Chat Completions, OpenAI Responses,
Anthropic Messages, or Gemini. JSON alone does not translate an arbitrary
proprietary protocol; a provider with a different request, streaming, tool-call,
or response shape needs a small backend adapter.

### OpenAI Image Generation

The bundled OpenAI provider exposes the Image API at
`https://api.openai.com/v1/images/generations`. `gpt-image-2` is the current
model. The catalog also retains the deprecated `gpt-image-1.5`, `gpt-image-1`,
and `gpt-image-1-mini` IDs for existing compatible deployments; new
configurations should select `gpt-image-2`.

Image generation uses the same effective OpenAI credential as Chat: the current
user's saved key, or the trusted bundled provider's environment fallback. It
has a separate optional `image_endpoint` override so a custom Chat endpoint
cannot accidentally receive image requests. Leave `image_endpoint` blank to
inherit the bundled Image API endpoint.

Image selections are provider-qualified. When two image plugins expose the same
model ID, Libre WebUI sends the request only to the provider selected in the
image panel. GPT Image responses use base64 image data; Libre WebUI converts
that data to an in-app image and saves it to the current user's gallery.
Image API routes require authentication, and direct generation requests must
include both `pluginId` and `model`. They may set `n` to a JSON integer from 1
through 10; numeric strings and fractional values are rejected before reaching
the provider.

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
`store: false`, and request encrypted reasoning content for stateless
continuation. Completed and streamed Responses output is normalized back to
Libre WebUI's chat and Work event formats. Replay state is retained only when
the complete ordered output Item array is at most 64 Items and 90 KB; Items are
kept exact and are never field-truncated. Replayable Items require unique,
non-empty IDs and types, and message, reasoning, and function-call structures
are validated before any tool call is emitted. Oversized Chat state falls back
to normalized visible history. Chat also discards raw function-call Items
because Chat does not persist corresponding tool outputs. Tool-bearing Work
responses without bounded, exact replay state are rejected before any tool side
effect.

SQLite-backed Chat storage encrypts retained provider state with the message;
Work stores tool-only state in hidden context rows that are not returned by
message APIs. A hashed scope binds replay to the same provider, model, Responses
mode, final configured endpoint, and an opaque one-way fingerprint of the
selected credential. When that scope changes, including after API-key rotation,
Libre WebUI falls back to normalized message history rather than sending
provider-specific Items across an authentication boundary. An active Work run
also fingerprints its routing and credential and revalidates them immediately
before every provider round; changing the mode, endpoint, or API key stops the
run before another request can receive prior tool state.
Tool-bearing state must fit both the replay limit and the complete 100 KB
persisted metadata wrapper before Work performs a side effect. If a persisted
Work batch was interrupted, every missing tool result is restored with its
exact call ID and an outcome-unknown warning so the provider can inspect the
workspace instead of blindly repeating a possible side effect. An incomplete
Responses result is not treated as a successful Chat or Work turn; its
`incomplete_details.reason` is retained and surfaced to the caller.

Model discovery derives `/models` from either operation path. For example,
`https://api.example.com/v1/responses` discovers from
`https://api.example.com/v1/models`. Providers without a compatible model-list
endpoint can still use a manual `model_map`. Discovery is scoped to the current
user's variables and credentials. Results are persisted per user rather than
written into the shared plugin manifest. Discovery runs after activation,
explicit refresh, API-key changes, connection-variable changes, and variable
resets; unrelated generation-variable saves do not trigger a network request.

Discovery also runs on its own. Reading the plugin list rediscovers any active
completion provider whose catalog is missing or older than
`PLUGIN_MODEL_DISCOVERY_TTL_MS`, so reloading the application reflects the
provider's current models rather than the catalog captured at activation. A
per-provider backoff keeps an unreachable provider from being probed on every
request, and a deadline stops a slow provider from delaying the response; a
refresh that outruns it is served on the following request.
The final derived discovery URL is checked before the user's credential is read
or an authorization header is built, including when the URL originates in an
imported plugin manifest. Discovery and provider capability requests do not
follow HTTP redirects. Configure the final Chat, Work, model-list, image,
embedding, transcription, speech, voice-clone, audio, or video endpoint
directly; this prevents credentials from being forwarded from a validated URL
to an unvalidated redirect destination.

Provider endpoints may use HTTP or HTTPS. HTTP sends API keys, prompts, tool
results, and generated content without transport encryption, so use it only for
a self-hosted gateway on a network you trust; prefer HTTPS whenever the gateway
supports TLS. Requests originate from the backend. In container deployments,
that means a service URL such as `http://ai-gateway:8080/v1`, while `localhost`
identifies the Libre WebUI container itself. Plugin capability routes, including
image generation, resolve endpoint variables and credentials for the requesting
authenticated account. Libre WebUI does not have an unauthenticated
single-user mode.

### Capability-specific endpoints

Chat endpoint overrides are isolated from image, embedding, transcription,
text-to-speech, audio, and video capabilities. Multi-capability plugins can
expose `image_endpoint`, `embedding_endpoint`, `stt_endpoint`, `tts_endpoint`,
or another variable named by `config.endpoint_variable`. Voice-cloning routes
can likewise name `config.voice_clone_endpoint_variable`. Leaving those fields
blank uses the capability endpoint declared by the plugin; a generic Chat
`endpoint` is never used as a capability override.

The bundled GitHub Models plugin inherits its current
`models.github.ai/inference/chat/completions` endpoint when its optional
override is blank. The Hugging Face plugin uses task-specific
`hf-inference/models/{model}` routes and payloads for embeddings, images, and
text-to-speech rather than sending those requests to its Chat endpoint.

### Endpoint Overrides

The `endpoint` variable is the complete request URL, including the operation
path. For example, an OpenAI-compatible chat plugin normally uses a URL such as
`https://provider.example/v1/chat/completions`, not only
`https://provider.example`. Imported legacy plugin configurations may call this
variable `api_url`; Libre WebUI accepts that alias, but a non-empty `endpoint`
always takes precedence when both are present.

Absolute HTTP and HTTPS endpoint URLs are accepted; other protocols are
rejected. HTTP is intended for self-hosted gateways on trusted networks because
it sends credentials and request content without transport encryption. Prefer
HTTPS for any route that leaves a private deployment boundary. Leaving the
override empty uses the full endpoint from the plugin definition; an explicit
invalid override is rejected instead of silently routing to that default.

Provider requests do not follow redirects. Configure the final validated
operation URL directly; a redirect response is reported as a provider error
instead of forwarding credentials or request content to another hop.

Remember that requests originate from the Libre WebUI backend. In a container,
`localhost` identifies the container itself, not automatically the container
host or another service. Use the gateway's container service name, or a
host-reachable name such as `host.docker.internal` where the container runtime
provides it.

### Model Discovery

Settings → Plugins includes a **Provider connections** workspace for this
flow. Search for a provider in the left pane, select it, and use the right pane
to review its active state and effective model catalog. Provider configuration
remains collapsed until **Configure** is selected. This keeps endpoint,
credential, and advanced generation controls out of the default view.

For chat and completion providers, **Refresh models** runs discovery for the
selected provider and then reloads both the plugin catalog and Chat's model
list. The catalog is read-only: its rows come from the current user's
discovered IDs plus the plugin definition's capability model maps. Capability
labels describe which plugin route lists a model; they are not health checks.
Add fallback or manually maintained model IDs through the plugin JSON
`model_map`, not by editing a discovered row.

When a plugin is activated, Libre WebUI attempts model discovery with that
account's effective endpoint and credential. An administrator's custom route
requires a credential stored by the same account; an environment fallback is
used only with the trusted manifest route. For compatible APIs, Libre WebUI
derives a model-list URL from the full endpoint:

- a URL ending in `/models` is used as-is;
- known operation suffixes such as `/chat/completions`, `/completions`,
  `/responses`, `/embeddings`, or `/messages` are replaced with `/models`;
- otherwise, `/models` is appended to the path.

Plugins that cannot use the derived URL may expose `models_endpoint` as an
explicit full model-list URL. It takes precedence over derivation, is subject
to the same outbound URL policy, and is requested without following redirects.
Saving or resetting `endpoint`, `api_url`, `models_endpoint`, `base_url`,
`api_path`, or `api_mode` clears and refreshes the current user's discovered
catalog before the UI reloads it.

All custom routes are resolved and validated before credential selection. The
credential policy must not fall back to a server environment key for a stored
custom route; configure a per-user key for that route instead. Environment
fallback is reserved for the endpoint supplied by the trusted plugin
definition.

Discovery expects an OpenAI-compatible response containing model IDs in a
`data` array. Activation waits for that attempt before returning, so the first
plugin-list refresh can include the discovered catalog. Successful results are
stored per user and overlaid on that user's plugin view; Libre WebUI does not
rewrite the shared plugin JSON or expose one user's discovered model IDs to
another account. If the provider has no compatible model-list endpoint, cannot
be reached, or returns another response shape, an ordinary activation keeps
that user's previous discovery result. An intentional connection-field change
clears the obsolete catalog first and therefore uses the plugin's `model_map`
fallback when the new route cannot be discovered.

Saving or resetting connection routing clears that account's previous
discovered catalog before the next discovery attempt, so models learned from
one destination cannot remain selectable after a route change.

Plugin status, Work availability, model catalogs, and capability routes use the
same user context and credential boundary. For example, image model
availability, endpoint variables, and credentials are resolved for the user
making the request.

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

## Provider Settings and Inheritance

Open **Settings → Plugins** and choose **Configure** for a provider. Provider
panels are closed by default. Administrators can manage shared definitions and
connection-routing values. Other authenticated users can activate providers,
save their own API keys, and change their own generation controls, but the UI
does not expose plugin upload, install, export, delete, or routing controls to
them.

For administrators, connection overrides appear first. Sampling and other
specialist controls remain under **Advanced parameters**, which is also closed
by default. Inherited connection and generation values render as blank inputs
with a provider-default hint. Libre WebUI does not copy manifest defaults into
an account's saved settings merely because the panel was opened.

Saving sends only fields changed in the current editor session. Clearing a
saved non-sensitive value removes that account's override and restores the
provider default; a blank masked sensitive field is left unchanged. **Reset to
Defaults** removes every variable override that the account is allowed to
manage. If a save or reset fails, the editor keeps the unsaved values visible
so the user can retry.

This distinction is important for custom endpoints: an administrator leaves
the endpoint blank to inherit the plugin's bundled URL, or enters a complete
compatible URL to override it for that administrator's provider connection.

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
