---
title: 'Capability Contracts'
description: 'Generated inventory of every executable provider capability in Libre WebUI.'
slug: /CAPABILITY_CONTRACTS
---

# Capability Contracts

<!-- Generated from scripts/capability-contracts.json. Do not edit this table by hand. -->

This inventory is enforced by `scripts/test-capability-contracts.mjs`. A
provider capability is not complete until its schema and catalog mapping,
executable handler, matching browser client, named UI action, documentation,
focused behavioral test, and bundled manifests agree.

| Capability        | Plugin types         | Executable route                                                               | Browser client                                                               | UI action                                                               | Documentation                    | Focused behavior tests                                                                                                                                                                                                                                                                    | Bundled definitions                                                                                                                          |
| ----------------- | -------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat / completion | `chat`, `completion` | `WS /ws (chat_stream)`                                                         | `frontend/src/hooks/useChat.ts`                                              | `frontend/src/pages/ChatPage.tsx` — `handleSendMessage`                 | `docs/08-PLUGIN_ARCHITECTURE.md` | `scripts/test-chat-provider-selection.mjs` (`test:package`) — exact plugin routing reaches the selected provider for regular and streaming requests                                                                                                                                       | `anthropic`, `codex-oauth`, `gemini`, `github`, `groq`, `huggingface`, `kimi-code`, `llama-cpp`, `mistral`, `mlx-lm`, `openai`, `openrouter` |
| Embeddings        | `embedding`          | `POST /api/ollama/embed`<br>`GET /api/embeddings/models` (discovery only)      | `frontend/src/utils/api/modelApi.ts`                                         | `frontend/src/components/ModelManager.tsx` — `handleGenerateEmbeddings` | `docs/09-RAG_FEATURE.md`         | `scripts/test-plugin-capability-routing.mjs` (`test:package`) — Hugging Face capabilities ignore the generic Chat endpoint and use task payloads                                                                                                                                          | `huggingface`                                                                                                                                |
| Image generation  | `image`              | `POST /api/image-gen/generate`                                                 | `frontend/src/utils/api/imageGenApi.ts`                                      | `frontend/src/components/ImageGenerationPanel.tsx` — `handleGenerate`   | `docs/38-MEDIA_GENERATION.md`    | `scripts/test-image-generation-routing.mjs` (`test:package`) — image generation uses the selected provider and user-scoped OpenAI settings                                                                                                                                                | `comfyui`, `huggingface`, `openai`, `openrouter`                                                                                             |
| Speech to text    | `stt`                | `POST /api/stt/transcribe`                                                     | `frontend/src/utils/api/sttApi.ts`                                           | `frontend/src/components/ChatInput.tsx` — `toggleDictation`             | `docs/42-SPEECH_TO_TEXT.md`      | `scripts/test-stt-routing.mjs` (`test:package`) — STT sends an OpenAI-compatible multipart request to the selected route<br>`frontend/e2e/stt.spec.ts` (`test:e2e`) — provider speech input discloses its route and transcribes recorded audio                                            | `huggingface`, `openai`                                                                                                                      |
| Text to speech    | `tts`                | `POST /api/tts/generate`                                                       | `frontend/src/utils/api/ttsApi.ts`                                           | `frontend/src/components/TTSButton.tsx` — `handlePlay`                  | `docs/38-MEDIA_GENERATION.md`    | `scripts/test-tts-routing.mjs` (`test:package`) — TTS routes a shared model alias through the selected plugin and user valve<br>`frontend/e2e/tts-playback.spec.ts` (`test:e2e`) — batched read-aloud reuses the selected saved voice for every batch                                     | `elevenlabs`, `huggingface`, `kyutai-tts-1.6b`, `kyutai-tts`, `longcat-audiodit`, `openai-tts`, `openai`, `openrouter`, `qwen-tts`           |
| Audio generation  | `audio`              | `POST /api/media/sound/generate`                                               | `frontend/src/utils/api/mediaApi.ts`                                         | `frontend/src/components/MediaGenerationPanel.tsx` — `handleGenerate`   | `docs/38-MEDIA_GENERATION.md`    | `scripts/test-openrouter-media-routing.mjs` (`test:package`) — OpenRouter audio-output models stream generated sound bytes                                                                                                                                                                | `openrouter`                                                                                                                                 |
| Video generation  | `video`              | `POST /api/media/video/generate`<br>`POST /api/media/video/jobs/:jobId/resume` | `frontend/src/utils/api/mediaApi.ts`<br>`frontend/src/utils/api/mediaApi.ts` | `frontend/src/components/MediaGenerationPanel.tsx` — `handleGenerate`   | `docs/38-MEDIA_GENERATION.md`    | `scripts/test-openrouter-media-routing.mjs` (`test:package`) — video generation submits, polls, and downloads through the provider endpoint<br>`scripts/test-openrouter-media-routing.mjs` (`test:package`) — prepared video and resume publications resolve lost commit acknowledgements | `openrouter`                                                                                                                                 |

## Enforcement

The package gate rejects undeclared schema or plugin types, stale catalog
mappings, discovery-only routes presented as execution, handlers without a
matching browser transport, UI actions without an invocation and visible
trigger, documentation without capability-specific claims, tests without
behavior inside the named test case, stale generated inventory, and invalid
manifest endpoints, model maps, or defaults.

Embedding generation executes through `POST /api/ollama/embed` and can route
to a selected embedding plugin. `GET /api/embeddings/models` lists models;
the gate records it as discovery-only and never accepts it as proof that
embedding generation works.

The source contract identifies each focused behavior test and its runner.
Backend scripts must be registered in `test:package`; frontend specs must
be discoverable by the Playwright-based `test:e2e` script. Live discovery
may narrow a model catalog, but it does not create a new executable
capability.
