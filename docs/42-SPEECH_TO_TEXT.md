---
sidebar_position: 42
title: 'Speech to Text'
description: 'Transcribe microphone recordings through configured providers.'
slug: /SPEECH_TO_TEXT
keywords: [speech to text, transcription, microphone, openai, hugging face]
---

# Speech to Text

Libre WebUI can transcribe microphone recordings through an active plugin that
declares a speech-to-text capability. When the browser exposes its speech
recognition service, Chat selects that service by default; its implementation
and data handling are controlled by the browser vendor and are not necessarily
on-device. Select a named provider explicitly to use provider-backed STT. When
the browser service is unavailable, Chat selects the first compatible provider.

Bundled support includes:

- OpenAI transcription models through a multipart
  `/v1/audio/transcriptions` request; and
- Hugging Face automatic speech recognition models through its raw-audio
  inference endpoint.

The browser records only after the user presses the microphone button. Chat
shows the selected provider and transfer notice before recording. Press the
button again to stop recording; while transcription is running, the same button
cancels the provider request. Libre inserts the returned transcript into the
composer. The recording is held in memory for the request and is not saved by
Libre WebUI. Navigating to another chat cancels pending microphone permission,
recording, and transcription work.

## Provider contract

An STT capability declares an endpoint, model map, accepted formats, request
mode, and optional endpoint variable. Libre validates the authenticated user's
exact plugin/model route before forwarding audio. Libre currently accepts
uncompressed PCM WAV and Opus WebM recordings. It validates the filename
extension, declared MIME type, container structure, codec identifier, sample
rate, channels, decoded-size ratio, and duration before forwarding audio.
Requests are limited to 25 MiB and 300 seconds globally (or a lower manifest
limit), bounded to two concurrent transcriptions per user and six per process,
and aborted when the browser disconnects.

Provider credentials remain on the backend. Libre refuses redirects so an
authorization header or audio recording cannot be forwarded to a different
host. Provider authentication failures are surfaced as an upstream failure,
not as an expired Libre session.

Use HTTPS for the Libre WebUI origin and remote providers. Browsers do not expose
microphone capture to an insecure remote origin, and Libre does not advertise
either speech path unless the browser exposes its secure-origin media APIs. The
provider may retain or process recordings under its own terms, so review that
policy before dictating sensitive text.
