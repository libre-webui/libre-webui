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
 * Decision models answer typed questions about a state: a choice among
 * named options, the probability that a statement is true, or a score on an
 * ordered scale. They return probabilities, never text.
 *
 * Three wire formats exist. The System One API (`/v1/systemone`) is served
 * by Ollama, llama.cpp, Baseten, and OpenRouter; OpenAI's Decisions API and
 * Gemini's Decisions API carry the same three question types in their own
 * shapes. This module holds one neutral request and answer shape, validates
 * it once, and translates it to and from each format. It does no I/O.
 */

import type { DecisionConfig } from '../types/index.js';

export type DecisionApi = DecisionConfig['api'];
export type DecisionImageInput = NonNullable<DecisionConfig['image_input']>;

export interface DecisionChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option name to its description; null leaves the bare name. */
  criteria: Record<string, string | null>;
}

export interface DecisionNoulQuestion {
  type: 'noul';
  instructions: string;
  /** What "true" and "false" mean here; providers have defaults. */
  criteria?: { true?: string; false?: string };
}

export interface DecisionScoreQuestion {
  type: 'score';
  instructions: string;
  /** Levels from the lowest (score 0) to the highest. */
  criteria: string[];
}

export type DecisionQuestion =
  DecisionChoiceQuestion | DecisionNoulQuestion | DecisionScoreQuestion;

export type DecisionQuestions = Record<string, DecisionQuestion>;

export type DecisionState = string | Record<string, unknown> | unknown[];

export interface DecisionImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Base64 without a data URL prefix. */
  data: string;
}

export interface DecisionInput {
  state: DecisionState;
  images: DecisionImage[];
  questions: DecisionQuestions;
}

export type DecisionAnswer =
  | {
      type: 'choice';
      choice: string;
      probabilities: Record<string, number>;
      confidence?: number;
    }
  | { type: 'noul'; noul: number; confidence?: number }
  | {
      type: 'score';
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence?: number;
    }
  /** The provider declined this question; the others still count. */
  | { type: 'refusal' };

export interface DecisionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** Reported by the provider in US dollars, when it reports one. */
  costUsd?: number;
}

export interface DecisionResult {
  /** The model the provider says answered. */
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
}

/**
 * The tightest limits any supported provider documents, so a request that
 * passes here is not rejected for its shape by any of them. Ollama's cloud
 * takes at most 64 questions named with ASCII letters, digits, `_`, `.`, or
 * `-` and 4 images of 4 MiB (8 MiB in all); a choice takes at most 255
 * options everywhere and a score 2 to 10 levels.
 */
export const DECISION_LIMITS = {
  maxQuestions: 64,
  maxQuestionNameLength: 100,
  minChoiceOptions: 2,
  maxChoiceOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
  maxInstructionsLength: 8000,
  maxCriterionLength: 4000,
  maxStateBytes: 512 * 1024,
  maxImages: 4,
  maxImageBytes: 4 * 1024 * 1024,
  maxTotalImageBytes: 8 * 1024 * 1024,
} as const;

const QUESTION_NAME = /^[A-Za-z0-9_.-]+$/;
const IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class DecisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionValidationError';
  }
}

/** A provider answered with an error status or a shape we cannot read. */
export class DecisionProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'DecisionProviderError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function readText(value: unknown, label: string, max: number): string {
  if (!nonEmptyText(value)) {
    throw new DecisionValidationError(`${label} must be a non-empty string.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new DecisionValidationError(
      `${label} must be at most ${max} characters.`
    );
  }
  return text;
}

function readQuestion(name: string, raw: unknown): DecisionQuestion {
  if (!isRecord(raw)) {
    throw new DecisionValidationError(`Question "${name}" must be an object.`);
  }
  const instructions = readText(
    raw.instructions,
    `The instructions of "${name}"`,
    DECISION_LIMITS.maxInstructionsLength
  );
  const type = raw.type === 'yesno' ? 'noul' : raw.type;

  if (type === 'choice') {
    if (!isRecord(raw.criteria)) {
      throw new DecisionValidationError(
        `Choice "${name}" needs criteria: option names mapped to descriptions.`
      );
    }
    const entries = Object.entries(raw.criteria);
    if (
      entries.length < DECISION_LIMITS.minChoiceOptions ||
      entries.length > DECISION_LIMITS.maxChoiceOptions
    ) {
      throw new DecisionValidationError(
        `Choice "${name}" needs ${DECISION_LIMITS.minChoiceOptions} to ${DECISION_LIMITS.maxChoiceOptions} options.`
      );
    }
    const criteria: Record<string, string | null> = {};
    for (const [option, description] of entries) {
      const key = option.trim();
      if (!key || key.length > DECISION_LIMITS.maxQuestionNameLength) {
        throw new DecisionValidationError(
          `Choice "${name}" has an option without a usable name.`
        );
      }
      if (Object.prototype.hasOwnProperty.call(criteria, key)) {
        throw new DecisionValidationError(
          `Choice "${name}" lists the option "${key}" twice.`
        );
      }
      criteria[key] =
        description === null || description === undefined
          ? null
          : nonEmptyText(description)
            ? readText(
                description,
                `The description of "${key}"`,
                DECISION_LIMITS.maxCriterionLength
              )
            : null;
    }
    return { type: 'choice', instructions, criteria };
  }

  if (type === 'noul') {
    if (raw.criteria === undefined || raw.criteria === null) {
      return { type: 'noul', instructions };
    }
    if (!isRecord(raw.criteria)) {
      throw new DecisionValidationError(
        `Yes/no "${name}" criteria must describe "true" and "false".`
      );
    }
    const extra = Object.keys(raw.criteria).filter(
      key => key !== 'true' && key !== 'false'
    );
    if (extra.length > 0) {
      throw new DecisionValidationError(
        `Yes/no "${name}" criteria take only "true" and "false".`
      );
    }
    const criteria: { true?: string; false?: string } = {};
    for (const key of ['true', 'false'] as const) {
      if (nonEmptyText(raw.criteria[key])) {
        criteria[key] = readText(
          raw.criteria[key],
          `The "${key}" description of "${name}"`,
          DECISION_LIMITS.maxCriterionLength
        );
      }
    }
    return Object.keys(criteria).length > 0
      ? { type: 'noul', instructions, criteria }
      : { type: 'noul', instructions };
  }

  if (type === 'score') {
    if (!Array.isArray(raw.criteria)) {
      throw new DecisionValidationError(
        `Score "${name}" needs criteria: levels from lowest to highest.`
      );
    }
    if (
      raw.criteria.length < DECISION_LIMITS.minScoreLevels ||
      raw.criteria.length > DECISION_LIMITS.maxScoreLevels
    ) {
      throw new DecisionValidationError(
        `Score "${name}" needs ${DECISION_LIMITS.minScoreLevels} to ${DECISION_LIMITS.maxScoreLevels} levels.`
      );
    }
    const criteria = raw.criteria.map((level, index) =>
      readText(
        level,
        `Level ${index} of "${name}"`,
        DECISION_LIMITS.maxCriterionLength
      )
    );
    return { type: 'score', instructions, criteria };
  }

  throw new DecisionValidationError(
    `Question "${name}" must be of type choice, noul, or score.`
  );
}

/** Validates a question set, keeping its order. */
export function parseDecisionQuestions(raw: unknown): DecisionQuestions {
  if (!isRecord(raw)) {
    throw new DecisionValidationError(
      'questions must be an object of named questions.'
    );
  }
  const names = Object.keys(raw);
  if (names.length === 0) {
    throw new DecisionValidationError('Ask at least one question.');
  }
  if (names.length > DECISION_LIMITS.maxQuestions) {
    throw new DecisionValidationError(
      `Ask at most ${DECISION_LIMITS.maxQuestions} questions at once.`
    );
  }
  const questions: DecisionQuestions = {};
  for (const name of names) {
    if (
      name.length > DECISION_LIMITS.maxQuestionNameLength ||
      !QUESTION_NAME.test(name)
    ) {
      throw new DecisionValidationError(
        `Question names use letters, digits, "_", ".", or "-" (at most ${DECISION_LIMITS.maxQuestionNameLength}): "${name}".`
      );
    }
    questions[name] = readQuestion(name, raw[name]);
  }
  return questions;
}

/** Like parseDecisionQuestions, but an empty set is allowed. */
export function parseOptionalDecisionQuestions(
  raw: unknown
): DecisionQuestions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (isRecord(raw) && Object.keys(raw).length === 0) return undefined;
  return parseDecisionQuestions(raw);
}

export function parseDecisionState(raw: unknown): DecisionState {
  let state: DecisionState;
  if (typeof raw === 'string') {
    if (!raw.trim()) {
      throw new DecisionValidationError('state must not be empty.');
    }
    state = raw;
  } else if (Array.isArray(raw) || isRecord(raw)) {
    if (
      (Array.isArray(raw) && raw.length === 0) ||
      (isRecord(raw) && Object.keys(raw).length === 0)
    ) {
      throw new DecisionValidationError('state must not be empty.');
    }
    state = raw as DecisionState;
  } else {
    throw new DecisionValidationError(
      'state must be text, a JSON object, or a JSON array.'
    );
  }
  const bytes = Buffer.byteLength(
    typeof state === 'string' ? state : JSON.stringify(state),
    'utf8'
  );
  if (bytes > DECISION_LIMITS.maxStateBytes) {
    throw new DecisionValidationError(
      `state must be at most ${DECISION_LIMITS.maxStateBytes} bytes.`
    );
  }
  return state;
}

function sniffImageMimeType(bytes: Buffer): DecisionImage['mimeType'] | null {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Images as data URLs or bare base64. The format is read from the bytes,
 * not trusted from the prefix: decision APIs take PNG, JPEG, and WebP only.
 */
export function parseDecisionImages(raw: unknown): DecisionImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new DecisionValidationError('images must be an array.');
  }
  if (raw.length > DECISION_LIMITS.maxImages) {
    throw new DecisionValidationError(
      `Send at most ${DECISION_LIMITS.maxImages} images.`
    );
  }
  let total = 0;
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new DecisionValidationError(`Image ${index + 1} is empty.`);
    }
    const match = IMAGE_DATA_URL.exec(entry.trim());
    const data = (match ? match[2] : entry).replace(/\s+/g, '');
    if (!BASE64.test(data)) {
      throw new DecisionValidationError(
        `Image ${index + 1} must be base64 or a base64 data URL.`
      );
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > DECISION_LIMITS.maxImageBytes) {
      throw new DecisionValidationError(
        `Image ${index + 1} is larger than ${DECISION_LIMITS.maxImageBytes / (1024 * 1024)} MiB.`
      );
    }
    total += bytes.length;
    if (total > DECISION_LIMITS.maxTotalImageBytes) {
      throw new DecisionValidationError(
        `Images may total at most ${DECISION_LIMITS.maxTotalImageBytes / (1024 * 1024)} MiB.`
      );
    }
    const mimeType = sniffImageMimeType(bytes);
    if (!mimeType) {
      throw new DecisionValidationError(
        `Image ${index + 1} must be a PNG, JPEG, or WebP file.`
      );
    }
    return { mimeType, data };
  });
}

export function parseDecisionInput(raw: {
  state?: unknown;
  images?: unknown;
  questions?: unknown;
}): DecisionInput {
  return {
    state: parseDecisionState(raw.state),
    images: parseDecisionImages(raw.images),
    questions: parseDecisionQuestions(raw.questions),
  };
}

const dataUrl = (image: DecisionImage): string =>
  `data:${image.mimeType};base64,${image.data}`;

const stateText = (state: DecisionState): string =>
  typeof state === 'string' ? state : JSON.stringify(state, null, 2);

function systemOneState(
  input: DecisionInput,
  imageInput: DecisionImageInput
): { state: unknown; images?: string[] } {
  if (input.images.length === 0) return { state: input.state };
  switch (imageInput) {
    case 'images':
      return { state: input.state, images: input.images.map(i => i.data) };
    case 'images-data-url':
      return { state: input.state, images: input.images.map(dataUrl) };
    case 'state-messages':
      return {
        state: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: stateText(input.state) },
                ...input.images.map(image => ({
                  type: 'image_url',
                  image_url: { url: dataUrl(image) },
                })),
              ],
            },
          ],
        },
      };
    case 'state-parts':
      return {
        state: [
          stateText(input.state),
          ...input.images.map(image => ({
            type: 'image_url',
            image_url: { url: dataUrl(image) },
          })),
        ],
      };
    case 'none':
    default:
      throw new DecisionValidationError(
        'This provider does not take images with decisions.'
      );
  }
}

function openAIInput(input: DecisionInput): unknown {
  const textPart = (): Record<string, unknown> => {
    if (typeof input.state === 'string') {
      return { type: 'input_text', text: input.state };
    }
    // input_json takes an object or an array of objects; anything else is
    // read as text.
    const objectsOnly =
      isRecord(input.state) ||
      (Array.isArray(input.state) && input.state.every(isRecord));
    return objectsOnly
      ? { type: 'input_json', data: input.state }
      : { type: 'input_text', text: stateText(input.state) };
  };
  if (typeof input.state === 'string' && input.images.length === 0) {
    return input.state;
  }
  return [
    {
      role: 'user',
      content: [
        textPart(),
        ...input.images.map(image => ({
          type: 'input_image',
          image_url: dataUrl(image),
        })),
      ],
    },
  ];
}

function openAIQuestions(questions: DecisionQuestions): unknown[] {
  return Object.entries(questions).map(([name, question]) => {
    if (question.type === 'choice') {
      return {
        type: 'choice',
        name,
        instructions: question.instructions,
        choices: Object.entries(question.criteria).map(
          ([value, description]) =>
            description ? { value, description } : { value }
        ),
      };
    }
    if (question.type === 'score') {
      return {
        type: 'score',
        name,
        instructions: question.instructions,
        levels: question.criteria.map(label => ({ label })),
      };
    }
    // A predicate has no criteria of its own; what true and false mean
    // becomes part of the statement.
    const meanings = [
      question.criteria?.true ? `True means: ${question.criteria.true}` : '',
      question.criteria?.false ? `False means: ${question.criteria.false}` : '',
    ].filter(Boolean);
    return {
      type: 'predicate',
      name,
      instructions: [question.instructions, ...meanings].join('\n'),
    };
  });
}

function geminiInput(input: DecisionInput): unknown {
  if (input.images.length === 0) return stateText(input.state);
  return [
    { type: 'text', text: stateText(input.state) },
    ...input.images.map(image => ({
      type: 'image',
      data: image.data,
      mime_type: image.mimeType,
    })),
  ];
}

function geminiQuestions(
  questions: DecisionQuestions
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      out[name] = {
        type: 'choice',
        instructions: question.instructions,
        criteria: Object.fromEntries(
          Object.entries(question.criteria).map(([option, description]) => [
            option,
            description ?? option,
          ])
        ),
      };
    } else if (question.type === 'score') {
      out[name] = {
        type: 'score',
        instructions: question.instructions,
        criteria: question.criteria,
      };
    } else {
      out[name] = {
        type: 'noul',
        instructions: question.instructions,
        ...(question.criteria
          ? {
              criteria: {
                ...(question.criteria.true
                  ? { true_description: question.criteria.true }
                  : {}),
                ...(question.criteria.false
                  ? { false_description: question.criteria.false }
                  : {}),
              },
            }
          : {}),
      };
    }
  }
  return out;
}

/** The request body one provider expects for a validated decision. */
export function buildDecisionRequestBody(
  api: DecisionApi,
  imageInput: DecisionImageInput,
  model: string,
  input: DecisionInput
): Record<string, unknown> {
  if (api === 'openai') {
    return {
      model,
      input: openAIInput(input),
      questions: openAIQuestions(input.questions),
    };
  }
  if (api === 'gemini') {
    return {
      model,
      input: geminiInput(input),
      questions: geminiQuestions(input.questions),
    };
  }
  const { state, images } = systemOneState(input, imageInput);
  return {
    model,
    state,
    ...(images ? { images } : {}),
    questions: input.questions,
  };
}

const probability = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;

function readProbabilityMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    const p = probability(entry);
    if (p !== undefined) out[key] = p;
  }
  return out;
}

function scoreLegend(question: DecisionQuestion | undefined) {
  return question?.type === 'score'
    ? Object.fromEntries(
        question.criteria.map((level, i) => [String(i), level])
      )
    : {};
}

function readKeyedAnswer(
  raw: unknown,
  question: DecisionQuestion | undefined
): DecisionAnswer | undefined {
  if (!isRecord(raw)) return undefined;
  const type = raw.type ?? question?.type;
  const confidence = probability(raw.confidence);
  if (type === 'refusal') return { type: 'refusal' };
  if (type === 'noul') {
    const noul = probability(raw.noul);
    if (noul === undefined) return undefined;
    return confidence === undefined
      ? { type: 'noul', noul }
      : { type: 'noul', noul, confidence };
  }
  if (type === 'choice') {
    const probabilities = readProbabilityMap(raw.probabilities);
    const choice =
      typeof raw.choice === 'string'
        ? raw.choice
        : Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (choice === undefined) return undefined;
    return {
      type: 'choice',
      choice,
      probabilities,
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
  if (type === 'score') {
    const score =
      typeof raw.score === 'number' && Number.isFinite(raw.score)
        ? raw.score
        : undefined;
    if (score === undefined) return undefined;
    const legend: Record<string, string> = isRecord(raw.legend)
      ? Object.fromEntries(
          Object.entries(raw.legend).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : scoreLegend(question);
    return {
      type: 'score',
      score,
      legend: Object.keys(legend).length > 0 ? legend : scoreLegend(question),
      probabilities: readProbabilityMap(raw.probabilities),
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
  return undefined;
}

function readOpenAIAnswer(
  raw: Record<string, unknown>,
  question: DecisionQuestion | undefined
): DecisionAnswer | undefined {
  const confidence = probability(raw.confidence);
  if (raw.type === 'refusal') return { type: 'refusal' };
  if (raw.type === 'predicate') {
    const noul = probability(raw.probability);
    return noul === undefined ? undefined : { type: 'noul', noul };
  }
  if (raw.type === 'choice') {
    const probabilities: Record<string, number> = {};
    if (Array.isArray(raw.probabilities)) {
      for (const entry of raw.probabilities) {
        if (!isRecord(entry)) continue;
        const p = probability(entry.probability);
        if (p !== undefined) probabilities[String(entry.value)] = p;
      }
    }
    if (raw.choice === undefined || raw.choice === null) return undefined;
    return {
      type: 'choice',
      choice: String(raw.choice),
      probabilities,
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
  if (raw.type === 'score') {
    if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) {
      return undefined;
    }
    const probabilities: Record<string, number> = {};
    const legend: Record<string, string> = scoreLegend(question);
    if (Array.isArray(raw.probabilities)) {
      for (const entry of raw.probabilities) {
        if (!isRecord(entry)) continue;
        const index = String(entry.value);
        const p = probability(entry.probability);
        if (p !== undefined) probabilities[index] = p;
        if (typeof entry.label === 'string' && !legend[index]) {
          legend[index] = entry.label;
        }
      }
    }
    return {
      type: 'score',
      score: raw.score,
      legend,
      probabilities,
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
  return undefined;
}

/** A provider's error body as one line of text. */
export function readDecisionProviderError(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim().slice(0, 500) || undefined;
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (isRecord(error)) {
    if (typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
  }
  if (typeof body.message === 'string' && body.message.trim()) {
    return body.message.trim();
  }
  return undefined;
}

/**
 * Reads one provider's answer into the neutral shape. Every question must
 * come back; a provider that drops one has not answered the request.
 */
export function parseDecisionResponse(
  api: DecisionApi,
  body: unknown,
  questions: DecisionQuestions,
  requestedModel: string
): DecisionResult {
  if (!isRecord(body)) {
    throw new DecisionProviderError(
      'The decision provider returned an unexpected response.'
    );
  }

  if (api === 'gemini' && isRecord(body.prompt_feedback)) {
    const reason = body.prompt_feedback.block_reason;
    if (typeof reason === 'string' && reason) {
      const message = body.prompt_feedback.block_reason_message;
      throw new DecisionProviderError(
        `The provider blocked this request (${reason})${typeof message === 'string' && message ? `: ${message}` : '.'}`
      );
    }
  }

  const answers: Record<string, DecisionAnswer> = {};
  if (api === 'openai') {
    const list = Array.isArray(body.answers) ? body.answers : [];
    const names = Object.keys(questions);
    list.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const name =
        typeof entry.name === 'string' && entry.name
          ? entry.name
          : names[index];
      if (!name) return;
      const answer = readOpenAIAnswer(entry, questions[name]);
      if (answer) answers[name] = answer;
    });
  } else if (isRecord(body.answers)) {
    for (const [name, entry] of Object.entries(body.answers)) {
      const answer = readKeyedAnswer(entry, questions[name]);
      if (answer) answers[name] = answer;
    }
  }

  const missing = Object.keys(questions).filter(name => !answers[name]);
  if (missing.length > 0) {
    throw new DecisionProviderError(
      `The decision provider did not answer: ${missing.join(', ')}.`
    );
  }

  const usage: DecisionUsage = {};
  const rawUsage = isRecord(body.usage) ? body.usage : {};
  if (api === 'gemini') {
    usage.inputTokens = count(rawUsage.total_input_tokens);
    usage.outputTokens = count(rawUsage.total_output_tokens);
    usage.cachedTokens = count(rawUsage.total_cached_tokens);
  } else {
    usage.inputTokens = count(rawUsage.input_tokens);
    usage.outputTokens = count(rawUsage.output_tokens);
    const details = isRecord(rawUsage.input_tokens_details)
      ? rawUsage.input_tokens_details
      : {};
    usage.cachedTokens = count(details.cached_tokens);
    if (typeof rawUsage.cost === 'number' && Number.isFinite(rawUsage.cost)) {
      usage.costUsd = rawUsage.cost;
    }
  }
  for (const key of Object.keys(usage) as Array<keyof DecisionUsage>) {
    if (usage[key] === undefined) delete usage[key];
  }

  return {
    model:
      typeof body.model === 'string' && body.model
        ? body.model
        : requestedModel,
    answers,
    usage,
  };
}

/* ------------------------------------------------------------- chat turns */

/** A chat message as the decision chat mode reads it. */
export interface DecisionChatMessage {
  role: string;
  content: string;
  images?: string[];
}

/**
 * What one chat turn asks of a decision model.
 *
 * With a question set saved on the chat, every message is a new state and
 * the set is answered about it. Without one, the chat follows `ollama run`
 * with a decision model: the first message is the state, and each line of a
 * later message is a yes/no question about it; `/clear` starts over.
 */
export type DecisionChatTurn =
  | { kind: 'decide'; input: DecisionInput; mode: 'questions' | 'interactive' }
  | { kind: 'state' }
  | { kind: 'cleared' };

const CLEAR_COMMAND = '/clear';

export function resolveDecisionChatTurn(
  messages: readonly DecisionChatMessage[],
  savedQuestions?: DecisionQuestions
): DecisionChatTurn {
  const userMessages = messages.filter(message => message.role === 'user');
  const latest = userMessages[userMessages.length - 1];
  if (!latest) {
    throw new DecisionValidationError('Send a message to decide about.');
  }

  if (savedQuestions && Object.keys(savedQuestions).length > 0) {
    const images = parseDecisionImages(latest.images);
    const text = latest.content.trim();
    if (!text && images.length === 0) {
      throw new DecisionValidationError('Send a message to decide about.');
    }
    return {
      kind: 'decide',
      mode: 'questions',
      input: {
        // Images alone still need a state; it holds the context.
        state: text || 'The attached image.',
        images,
        questions: savedQuestions,
      },
    };
  }

  if (latest.content.trim() === CLEAR_COMMAND) return { kind: 'cleared' };

  let stateMessage: DecisionChatMessage | undefined;
  const asked: DecisionChatMessage[] = [];
  for (const message of userMessages) {
    if (message.content.trim() === CLEAR_COMMAND) {
      stateMessage = undefined;
      asked.length = 0;
      continue;
    }
    if (!stateMessage) stateMessage = message;
    else asked.push(message);
  }
  if (!stateMessage || asked.length === 0) return { kind: 'state' };

  const lines = latest.content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new DecisionValidationError(
      'Ask a yes/no question about the first message, one per line.'
    );
  }
  if (lines.length > DECISION_LIMITS.maxQuestions) {
    throw new DecisionValidationError(
      `Ask at most ${DECISION_LIMITS.maxQuestions} questions at once.`
    );
  }
  const questions: DecisionQuestions = {};
  lines.forEach((line, index) => {
    questions[`q${index + 1}`] = {
      type: 'noul',
      instructions: readText(
        line,
        `Question ${index + 1}`,
        DECISION_LIMITS.maxInstructionsLength
      ),
    };
  });
  const images = parseDecisionImages(stateMessage.images);
  const text = stateMessage.content.trim();
  return {
    kind: 'decide',
    mode: 'interactive',
    input: {
      state: text || 'The attached image.',
      images,
      questions,
    },
  };
}

const percent = (value: number): string =>
  `${(Math.round(value * 1000) / 10).toFixed(1)}%`;

// Backslashes first, so a `\|` in the text cannot turn the escape for its
// pipe into an escaped backslash followed by a bare cell separator.
const escapeCell = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * The answers as a Markdown table. The chat shows its own rendering from the
 * structured result; this text is what exports, the API, and search see.
 */
export function renderDecisionMarkdown(
  questions: DecisionQuestions,
  result: DecisionResult
): string {
  const rows = Object.entries(questions).map(([name, question]) => {
    const answer = result.answers[name];
    const asked = escapeCell(question.instructions);
    if (!answer || answer.type === 'refusal') {
      return `| ${asked} | declined | |`;
    }
    if (answer.type === 'noul') {
      const yes = answer.noul >= 0.5;
      return `| ${asked} | ${yes ? 'yes' : 'no'} | ${percent(yes ? answer.noul : 1 - answer.noul)} |`;
    }
    if (answer.type === 'choice') {
      const p = answer.probabilities[answer.choice];
      return `| ${asked} | ${escapeCell(answer.choice)} | ${p === undefined ? '' : percent(p)} |`;
    }
    const levels =
      question.type === 'score'
        ? question.criteria.length
        : Object.keys(answer.legend).length;
    const top = Object.entries(answer.probabilities).sort(
      (a, b) => b[1] - a[1]
    )[0];
    const label = top ? (answer.legend[top[0]] ?? top[0]) : '';
    return `| ${asked} | ${escapeCell(label)} (${(answer.score + 1).toFixed(2)} of ${levels}) | ${top ? percent(top[1]) : ''} |`;
  });
  return [
    '| Question | Answer | Probability |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}
