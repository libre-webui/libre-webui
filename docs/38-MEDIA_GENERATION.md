---
sidebar_position: 38
title: 'Video & Audio Generation'
description: 'Generate video, speech, and sound through provider plugins and browse everything in the unified media gallery.'
slug: /MEDIA_GENERATION
keywords:
  [
    libre webui video generation,
    audio generation,
    media gallery,
    plugin capabilities,
    openrouter media,
  ]
---

# Video & Audio Generation

Libre WebUI 0.18.0 extends generation beyond images: provider plugins can
declare video and audio capabilities, and everything generated — images,
videos, speech, and sound — lands in one per-user media gallery.

Media generation is available to every authenticated user. The gallery is
strictly per-user: every read, content fetch, and delete is scoped to the
signed-in account.

## Plugin Capability Blocks

A plugin definition declares each media capability as its own block:

```json
"capabilities": {
  "image": { "endpoint": "...", "model_map": ["..."], "config": { ... } },
  "tts":   { "endpoint": "...", "model_map": ["..."], "config": { ... } },
  "audio": { "endpoint": "...", "model_map": ["..."], "config": { ... } },
  "video": { "endpoint": "...", "model_map": ["..."], "config": { ... } }
}
```

Every block has an `endpoint`, a `model_map` fallback list, an optional
`models_endpoint` for live model discovery, and a `config` object with
capability-specific options — sizes and aspect ratios for images, voices and
formats for speech, resolutions, aspect ratios, and durations for video. A
video provider may also declare a prompt-ID `cancel_endpoint` and
`cancel_method`; Libre does not infer cancellation support from an ordinary
generation endpoint.

Two audio capabilities exist and both end up in the gallery as audio:

- `tts` is speech: text is read aloud in a selected voice.
- `audio` is sound: a model generates audio content from a prompt.

OpenRouter (`plugins/openrouter.json`) is currently the only bundled plugin
that declares `video` and `audio` blocks. When a `models_endpoint` is present,
the model list refreshes on the normal discovery cycle (see
[Environment Variables](./ENVIRONMENT_VARIABLES) for the discovery TTL
settings); the `model_map` remains the fallback.

## Generating Media

Open **Imagine** (`/gallery`). The header offers **Generate** for images (when
image generation is enabled in Settings), plus **Video** and **Audio** panels.

Speech and sound generation are synchronous: the request runs, the result is
saved to the gallery, and the response returns the finished item. **Cancel**
aborts the browser request and Libre's outbound provider request; a cancelled
result is not saved. Image generation follows the same disconnect-cancellation
contract.

For an accepted ComfyUI workflow, Libre sends both the prompt-ID job-cancel
operation and a prompt-ID queue deletion, then waits up to three seconds for
that teardown before releasing the request. It never calls ComfyUI's unscoped
interrupt operation, which could stop another user's workflow. Current ComfyUI
releases expose `/api/jobs/:promptId/cancel` for a running workflow. On an old
release without that operation, Libre can still remove the exact pending queue
item, but cannot safely stop an already-running workflow; upgrade ComfyUI for
the complete cancellation contract.

TTS plugins can also declare voice cloning. For those models, the Audio panel
shows a reference-audio upload and, when the provider requires it, an exact
transcript field. Libre WebUI validates the manifest's file type and size
limits, holds the upload in memory, and forwards it only to the selected
provider. Only the generated speech is placed in the gallery.

A clone can optionally be saved as a reusable, named voice for the same plugin
and model. Saving requires a separate storage-consent confirmation. Libre WebUI
encrypts the original reference and transcript in a user-owned voice profile;
it does not use generated speech as the reference. Saved profiles can be
selected or permanently deleted under **Settings → Text-to-Speech**. The
configured provider receives the stored reference again whenever it generates
a Speech batch. The profile is bound to that provider's approved routing; if
the plugin definition or endpoint changes, recreate the profile to consent to
the new destination. Only use recordings from speakers who consented to both
the cloning request and any requested storage.

Voice profiles are intentionally omitted from Libre WebUI's general data
export because they contain biometric source material. Back up the encrypted
application database and `ENCRYPTION_KEY` together if you need disaster
recovery; otherwise recreate profiles from the original consented recordings.

### Video Job Lifecycle

Video generation is asynchronous. Submitting a job
(`POST /api/media/video/generate`) returns `202` with a job record, and the
job moves through `pending`, `in_progress`, and finally `completed` or
`failed`.

- Submission is detached from the browser response after validation. Libre
  persists the provider job ID immediately after acceptance even if the panel
  or network connection closes while the provider is replying.
- `GET /api/media/video/jobs` lists only the authenticated user's saved handles;
  the panel requests up to 100 active handles whenever it opens. A pending job
  can therefore be reopened after navigation, refresh, or disconnect.
- A durable `media.video.resume.v1` job polls the provider and downloads a
  completed result even when the panel is closed. Solo mode runs that handler
  in the embedded worker; team mode runs it in the external worker. Leases,
  bounded retry, actor revalidation, and conditional completion let another
  worker reclaim the job after a process dies without creating a duplicate
  gallery row or blob reference. The existing resume/GET endpoints remain
  compatibility and status boundaries; the UI may still poll them for display.
- Closing the panel or choosing **Stop waiting** aborts only the current status
  or download transport. A provider-side **Cancel job** action appears only
  when that plugin explicitly declares a job-ID cancellation endpoint. On a
  confirmed provider cancellation, Libre removes the saved local handle.
- On completion the backend downloads the video (200 MB cap, HTTP redirects
  not followed) and saves it to the gallery.
- The job record stores the plugin, model, options, status, and the prompt
  (encrypted at rest). Completed and failed job records older than 30 days are
  pruned opportunistically; pending handles are not expired by that cleanup.

## The Unified Gallery

The gallery lists all media kinds interleaved by creation time, with filter
pills for **All**, **Images**, **Videos**, and **Audio**. Videos and audio play
inline; images open in the lightbox; every item can be downloaded or deleted.

Storage and serving are deliberately conservative:

- Media is stored encrypted inside the application database (under
  `DATA_DIR`), not as loose files on disk. Back up the database and
  `ENCRYPTION_KEY` together, as with all encrypted data.
- API responses never embed media payloads; items reference a per-item content
  URL instead.
- Served content must match a per-kind MIME allowlist and the stored type, is
  capped at 200 MB, and is delivered with `X-Content-Type-Options: nosniff`
  and a `Content-Security-Policy` that sandboxes the response.

The previous image-only endpoints and the image generation panel keep working
unchanged; they write into the same gallery.

## Rate Limits

The media API is rate-limited per client:

| Operation                             | Limit                   |
| ------------------------------------- | ----------------------- |
| Generation (video, speech, sound)     | 10 requests per minute  |
| Video job polling                     | 60 requests per minute  |
| Gallery listing, content, and deletes | 120 requests per minute |

The 30-second UI poll stays well inside the polling budget.

## Metering and Privacy

Media generation calls are metered in the administrator
[usage analytics](./SYSTEM_MONITORING) like every other outbound provider
call: plugin, model, status, duration, and unit counts. Prompts and generated
content are never written to the usage records. The generated media itself and
the video job's prompt exist only in the user's own encrypted rows.

As with chat, the configured provider receives the prompt and returns the
content — provider pricing, retention, and content policies apply.

## Related Docs

- [Plugin Architecture](./PLUGIN_ARCHITECTURE)
- [Connect Third-Party and Self-Hosted Providers](./PROVIDER_CONNECTIONS)
- [System Diagnostics & Usage Analytics](./SYSTEM_MONITORING)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Database Encryption](./DATABASE_ENCRYPTION)
