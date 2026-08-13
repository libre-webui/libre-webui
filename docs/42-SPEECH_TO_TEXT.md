---
sidebar_position: 42
title: 'Speech to Text'
description: 'Transcribe microphone recordings through configured providers.'
slug: /SPEECH_TO_TEXT
keywords: [speech to text, transcription, microphone, openai, hugging face]
---

# Speech to Text

Libre WebUI can transcribe microphone recordings through an active plugin that
declares a speech-to-text capability. The chat microphone prefers the first
active provider model whose advertised formats the browser can record. It uses
the browser's built-in speech recognition only when no compatible provider is
available.

Bundled support includes:

- OpenAI transcription models through a multipart
  `/v1/audio/transcriptions` request; and
- Hugging Face automatic speech recognition models through its raw-audio
  inference endpoint.

The browser records only after the user presses the microphone button. Press
it again to stop; Libre sends that recording to the selected provider and
inserts the returned transcript into the composer. The recording is held in
memory for the request and is not saved by Libre WebUI.

## Provider contract

An STT capability declares an endpoint, model map, accepted formats, request
mode, and optional endpoint variable. Libre validates the authenticated user's
exact plugin/model route before forwarding audio. Requests are limited to 25
MiB globally (or a lower manifest limit), validated against MIME type and file
signature, bounded to two concurrent transcriptions per user and six per
process, and aborted when the browser disconnects.

Provider credentials remain on the backend. Libre refuses redirects so an
authorization header or audio recording cannot be forwarded to a different
host. Provider authentication failures are surfaced as an upstream failure,
not as an expired Libre session.

Use HTTPS for remote providers. The provider may retain or process recordings
under its own terms, so review that policy before dictating sensitive text.
