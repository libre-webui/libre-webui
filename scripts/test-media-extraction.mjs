/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * KB-02 media extraction: OCR of images and scanned PDFs through the
 * vision-model path with per-page provenance, and audio transcripts through
 * the STT pipeline behind the stt feature gate. Model and provider calls
 * are injected so the contract (segments, labels, gates, empty-result
 * refusal) is what gets pinned.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const media = await import(dist('services/documentMediaExtractionService.js'));
const { DocumentExtractionError } = await import(
  dist('utils/documentExtraction.js')
);

test('multi-image OCR produces one labeled page segment per image', async () => {
  const seen = [];
  const extracted = await media.extractImagesToText(
    [
      { data: Buffer.from('a'), mime: 'image/jpeg', label: 'Page 1' },
      { data: Buffer.from('b'), mime: 'image/jpeg', label: 'Page 2' },
      { data: Buffer.from('c'), mime: 'image/jpeg', label: 'Page 3' },
    ],
    'user-1',
    undefined,
    {
      ocrOne: async image => {
        seen.push(image.label);
        // The middle page has no recoverable text.
        return image.label === 'Page 2' ? '' : `Text of ${image.label}`;
      },
    }
  );
  assert.deepEqual(seen, ['Page 1', 'Page 2', 'Page 3']);
  assert.equal(extracted.content, 'Text of Page 1\n\nText of Page 3');
  assert.deepEqual(
    extracted.segments.map(segment => [segment.kind, segment.label]),
    [
      ['page', 'Page 1'],
      ['page', 'Page 3'],
    ]
  );
  assert.equal(
    extracted.content.slice(
      extracted.segments[1].startChar,
      extracted.segments[1].endChar
    ),
    'Text of Page 3'
  );
});

test('a single image yields plain text without segment labels', async () => {
  const extracted = await media.extractImagesToText(
    [{ data: Buffer.from('x'), mime: 'image/png', label: 'Image' }],
    'user-1',
    undefined,
    { ocrOne: async () => '  A receipt for twelve apples.  ' }
  );
  assert.equal(extracted.content, 'A receipt for twelve apples.');
  assert.deepEqual(extracted.segments, []);
});

test('OCR that recovers no text at all fails deterministically', async () => {
  await assert.rejects(
    () =>
      media.extractImagesToText(
        [{ data: Buffer.from('x'), mime: 'image/png', label: 'Image' }],
        'user-1',
        undefined,
        { ocrOne: async () => '   ' }
      ),
    DocumentExtractionError
  );
});

test('audio transcripts carry one Transcript section and respect the stt gate', async () => {
  const extracted = await media.extractAudioToText(
    { buffer: Buffer.from('audio'), mimetype: 'audio/wav', originalname: 'm.wav' },
    'user-1',
    undefined,
    {
      authorizeStt: async () => true,
      transcribe: async () => ' We will ship the drills on Thursday. ',
    }
  );
  assert.equal(extracted.content, 'We will ship the drills on Thursday.');
  assert.deepEqual(extracted.segments, [
    {
      kind: 'section',
      label: 'Transcript',
      startChar: 0,
      endChar: extracted.content.length,
    },
  ]);

  await assert.rejects(
    () =>
      media.extractAudioToText(
        {
          buffer: Buffer.from('audio'),
          mimetype: 'audio/wav',
          originalname: 'm.wav',
        },
        'user-1',
        undefined,
        { authorizeStt: async () => false, transcribe: async () => 'text' }
      ),
    /restricted to administrators/
  );

  await assert.rejects(
    () =>
      media.extractAudioToText(
        {
          buffer: Buffer.from('audio'),
          mimetype: 'audio/wav',
          originalname: 'm.wav',
        },
        'user-1',
        undefined,
        { authorizeStt: async () => true, transcribe: async () => '' }
      ),
    /empty transcript/
  );
});
