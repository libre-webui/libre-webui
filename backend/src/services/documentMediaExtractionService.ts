/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Model-backed knowledge extraction: OCR for images and scanned PDFs through
 * the user's configured vision model, and audio transcripts through the
 * provider STT pipeline. No local OCR or ASR engine is bundled — both paths
 * route to providers the user already configured, with the same fail-closed
 * identity rules as chat and voice input.
 */

import type {
  DocumentSegment,
  ExtractedDocumentContent,
} from '../utils/documentExtraction.js';
import { DocumentExtractionError } from '../utils/documentExtraction.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:document-media-extraction');

const OCR_PROMPT = [
  'Transcribe all text visible in this image, exactly as written, in',
  'natural reading order. Preserve line breaks between distinct lines or',
  'paragraphs. Output the transcription only, with no commentary, no code',
  'fences, and no headers. If the image contains no readable text, instead',
  'describe the image factually in one or two sentences.',
].join(' ');

export interface OcrImageInput {
  data: Buffer;
  mime: string;
  label: string;
}

interface VisionDependencies {
  /** OCR one image; returns the transcribed text. Injectable for tests. */
  ocrOne?: (
    image: OcrImageInput,
    userId: string,
    signal?: AbortSignal
  ) => Promise<string>;
}

const ocrOneWithVisionModel = async (
  image: OcrImageInput,
  userId: string,
  signal?: AbortSignal
): Promise<string> => {
  const { default: preferencesService } =
    await import('./preferencesService.js');
  const preferences = await preferencesService.getPreferences(userId);
  const visionModel = preferences.visionModel?.trim();
  if (!visionModel) {
    throw new DocumentExtractionError(
      'Image extraction needs a vision model: pick one in Settings → Model → Vision Model, then re-upload'
    );
  }
  const { default: chatGenerationService } =
    await import('./chatGenerationService.js');
  const providerSelection =
    preferences.visionProviderType != null
      ? {
          providerType: preferences.visionProviderType as
            'ollama' | 'plugin' | 'agent',
          providerId: preferences.visionProviderId ?? null,
        }
      : undefined;
  const target = await chatGenerationService.prepareGenerationTarget(
    visionModel,
    userId,
    { temperature: 0 },
    providerSelection,
    signal
  );
  const base64 = image.data.toString('base64');
  const result = await chatGenerationService.executeNonStreaming({
    target,
    ollamaMessages: [{ role: 'user', content: OCR_PROMPT, images: [base64] }],
    pluginMessages: [
      {
        id: `ocr-${Date.now()}`,
        role: 'user',
        content: OCR_PROMPT,
        images: [base64],
        timestamp: Date.now(),
      },
    ],
    userId,
    ...(signal ? { signal } : {}),
  });
  return result.assistantContent.trim();
};

/**
 * OCR a list of images into one document text with a labeled segment per
 * image, so retrieval can cite "Image 2" / "Page 3" of a scan.
 */
export const extractImagesToText = async (
  images: readonly OcrImageInput[],
  userId: string,
  signal?: AbortSignal,
  dependencies: VisionDependencies = {}
): Promise<ExtractedDocumentContent> => {
  const ocrOne = dependencies.ocrOne ?? ocrOneWithVisionModel;
  const segments: DocumentSegment[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const image of images) {
    if (signal?.aborted) throw signal.reason;
    const text = (await ocrOne(image, userId, signal)).trim();
    if (!text) continue;
    if (parts.length > 0) offset += 2;
    segments.push({
      kind: 'page',
      label: image.label,
      startChar: offset,
      endChar: offset + text.length,
    });
    parts.push(text);
    offset += text.length;
  }
  if (parts.length === 0) {
    throw new DocumentExtractionError(
      'The vision model returned no text for this image'
    );
  }
  // A single standalone image reads as one unlabeled body of text.
  return {
    content: parts.join('\n\n'),
    segments: images.length > 1 ? segments : [],
  };
};

interface TranscriptionDependencies {
  /** Transcribe validated audio; returns the transcript. Injectable. */
  transcribe?: (
    audio: { buffer: Buffer; mimetype: string; originalname: string },
    userId: string,
    signal?: AbortSignal
  ) => Promise<string>;
  /** STT feature gate; injectable. */
  authorizeStt?: (userId: string) => Promise<boolean>;
}

const authorizeSttForUser = async (userId: string): Promise<boolean> => {
  const [{ authorize }, { userModel }] = await Promise.all([
    import('./authorizationService.js'),
    import('../models/userModel.js'),
  ]);
  const user = await userModel.getUserById(userId);
  if (!user || user.status !== 'active') return false;
  const decision = await authorize({ userId, role: user.role }, 'use', {
    type: 'feature',
    id: 'stt',
  });
  return decision.allowed;
};

const transcribeWithProvider = async (
  audio: { buffer: Buffer; mimetype: string; originalname: string },
  userId: string,
  signal?: AbortSignal
): Promise<string> => {
  const { default: pluginService } = await import('./pluginService.js');
  const models = await pluginService.getAvailableSTTModels(userId);
  const selected = models[0];
  if (!selected) {
    throw new DocumentExtractionError(
      'Audio extraction needs a speech-to-text provider: activate a plugin with STT support, then re-upload'
    );
  }
  const { validateSTTAudio } = await import('../utils/sttAudioUpload.js');
  const validated = validateSTTAudio(
    {
      buffer: audio.buffer,
      mimetype: audio.mimetype,
      originalname: audio.originalname,
      size: audio.buffer.length,
    } as Parameters<typeof validateSTTAudio>[0],
    selected.config
  );
  logger.debug('Transcribing knowledge audio', {
    model: selected.model,
    plugin: selected.plugin,
  });
  const result = await pluginService.executeSTTRequest(
    selected.model,
    validated,
    {
      pluginId: selected.plugin,
      userId,
      ...(signal ? { signal } : {}),
    }
  );
  return result.text.trim();
};

/** Transcribe one uploaded audio file into a single-transcript document. */
export const extractAudioToText = async (
  audio: { buffer: Buffer; mimetype: string; originalname: string },
  userId: string,
  signal?: AbortSignal,
  dependencies: TranscriptionDependencies = {}
): Promise<ExtractedDocumentContent> => {
  const authorizeStt = dependencies.authorizeStt ?? authorizeSttForUser;
  if (!(await authorizeStt(userId))) {
    throw new DocumentExtractionError(
      'Speech-to-text is restricted to administrators on this instance'
    );
  }
  const transcribe = dependencies.transcribe ?? transcribeWithProvider;
  const text = (await transcribe(audio, userId, signal)).trim();
  if (!text) {
    throw new DocumentExtractionError(
      'The speech-to-text provider returned an empty transcript'
    );
  }
  return {
    content: text,
    segments: [
      {
        kind: 'section',
        label: 'Transcript',
        startChar: 0,
        endChar: text.length,
      },
    ],
  };
};
