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
 * The Gemini API's own wire format (`generateContent` and
 * `streamGenerateContent`), shared by Chat and Work so the two cannot drift.
 *
 * Gemini differs from the OpenAI shape in every place that matters: the
 * conversation is `contents` with `user` and `model` roles, the system prompt
 * is a separate `systemInstruction`, tools are `functionDeclarations`, a tool
 * result is a `functionResponse` part, and a stream is a sequence of whole
 * `GenerateContentResponse` objects rather than deltas.
 */

import type {
  ChatMessage,
  PluginResponse,
  ProviderToolSpec,
} from '../types/index.js';
import type { PluginStreamChunk } from './pluginStreamAdapter.js';
import {
  fitThinkingBudget,
  normalizeThinkingPreference,
  thinkingBudgetTokens,
} from './thinkingOptions.js';

/**
 * Where a reply's thought signatures are kept. Signatures are tied to the
 * model that produced them, so the model travels with them and a different
 * model never receives another one's.
 */
export const GEMINI_THOUGHT_SIGNATURES_METADATA_KEY = 'geminiThoughtSignatures';

export interface GeminiThoughtSignatures {
  model: string;
  /** The signature on the reply's text, if the model attached one there. */
  text?: string;
  /** Signatures on function calls, keyed by call id. */
  calls?: Record<string, string>;
}

/**
 * Ids the stream assigns to function calls that arrived without one. Gemini
 * never issued them, so they are not sent back on the wire.
 */
const LOCAL_CALL_ID_PREFIX = 'gemini-call-';

/** The synchronous output ceiling of every current Gemini text model. */
export const GEMINI_MAX_OUTPUT_TOKENS = 65536;

/**
 * Models whose lowest thinking level is `minimal` ("near-off"), per Google's
 * thinking guide. Thinking cannot be switched off on Gemini 3 and later, so
 * this is what **Off** becomes where it exists. Gemini 3.8 Flash and the
 * Gemini 4 models reject `minimal`.
 */
const GEMINI_MINIMAL_THINKING_MODELS = new Set([
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
]);

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** `gemini-3.8-flash` is generation 3.8; aliases have no generation. */
export function geminiModelGeneration(model: string): number | undefined {
  const match = /(?:^|\/)gemini-(\d+(?:\.\d+)?)/.exec(model.toLowerCase());
  return match ? Number(match[1]) : undefined;
}

/**
 * Gemini 3 and later take a named `thinkingLevel`; Google's reference says
 * sending one to an earlier model is an error, and its migration guides
 * replace `thinkingBudget` with the level from Gemini 3.8 Flash on. The
 * `-latest` aliases point at Gemini 3 models.
 */
export function geminiUsesThinkingLevels(model: string): boolean {
  const generation = geminiModelGeneration(model);
  if (generation !== undefined) return generation >= 3;
  return /(?:^|\/)gemini-(?:flash|flash-lite|pro)-latest$/.test(
    model.toLowerCase()
  );
}

/**
 * Temperature and top-p are deprecated, and silently ignored on Gemini 3.6
 * Flash and newer models, so they are not sent there.
 */
export function geminiIgnoresSampling(model: string): boolean {
  const generation = geminiModelGeneration(model);
  return generation !== undefined && generation >= 3.6;
}

function capOutputTokens(tokens: number): number {
  return Math.min(tokens, GEMINI_MAX_OUTPUT_TOKENS);
}

/**
 * The thinking part of a generation config. Gemini counts thinking against
 * `maxOutputTokens`, so a budget is fitted beside the answer; a level has no
 * size, so the ceiling is whatever was asked for, or the model's own when
 * nothing was. Nothing is sent for an unset preference.
 */
export function resolveGeminiThinking(
  model: string,
  think: unknown,
  requestedMaxTokens: number | undefined
): { maxOutputTokens?: number; thinkingConfig?: JsonObject } {
  const preference = normalizeThinkingPreference(think);
  const requested =
    requestedMaxTokens === undefined
      ? {}
      : { maxOutputTokens: capOutputTokens(requestedMaxTokens) };

  if (geminiUsesThinkingLevels(model)) {
    if (preference === undefined) return requested;
    if (preference === false) {
      return GEMINI_MINIMAL_THINKING_MODELS.has(model)
        ? { ...requested, thinkingConfig: { thinkingLevel: 'MINIMAL' } }
        : requested;
    }
    return {
      ...requested,
      thinkingConfig: {
        ...(preference === true
          ? {}
          : { thinkingLevel: preference.toUpperCase() }),
        // Without this the user pays for thinking and sees none.
        includeThoughts: true,
      },
    };
  }

  // Gemini 2.5 takes a token budget. Only an enabled setting is sent: a zero
  // budget is rejected by the models that always reason, so switching
  // thinking off is left to the model.
  const levelBudget = thinkingBudgetTokens(think);
  if (levelBudget === undefined) return requested;
  const fitted = fitThinkingBudget(requestedMaxTokens, levelBudget);
  return {
    maxOutputTokens: capOutputTokens(fitted.maxTokens),
    thinkingConfig: {
      thinkingBudget: fitted.budgetTokens,
      includeThoughts: true,
    },
  };
}

/** Sampling fields for a generation config, left out where Gemini ignores them. */
export function geminiSamplingConfig(
  model: string,
  params: { temperature?: number; topP?: number }
): JsonObject {
  if (geminiIgnoresSampling(model)) return {};
  return {
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    ...(params.topP !== undefined ? { topP: params.topP } : {}),
  };
}

/** The signatures a stored reply carries, if the same model produced them. */
export function readGeminiThoughtSignatures(
  providerMetadata: Record<string, unknown> | undefined,
  model: string
): GeminiThoughtSignatures | undefined {
  const stored = asObject(
    providerMetadata?.[GEMINI_THOUGHT_SIGNATURES_METADATA_KEY]
  );
  if (!stored || stored.model !== model) return undefined;
  const calls = asObject(stored.calls);
  return {
    model,
    ...(typeof stored.text === 'string' ? { text: stored.text } : {}),
    ...(calls
      ? {
          calls: Object.fromEntries(
            Object.entries(calls).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          ),
        }
      : {}),
  };
}

function splitImage(image: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(image);
  return match
    ? { mimeType: match[1], data: match[2] }
    : { mimeType: 'image/jpeg', data: image };
}

function parseArguments(value: string): JsonObject {
  try {
    return asObject(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

/**
 * A chat history as Gemini contents. System messages become the system
 * instruction; images travel as inline data beside the text they came with;
 * an in-turn tool round becomes `functionCall` parts answered by
 * `functionResponse` parts. Thought signatures go back on the parts they came
 * from, and only to the model that issued them.
 */
export function toGeminiContents(
  messages: readonly ChatMessage[],
  model: string
): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user' | 'model'; parts: JsonObject[] }>;
} {
  const system = messages
    .filter(message => message.role === 'system' && message.content)
    .map(message => message.content)
    .join('\n');
  const contents: Array<{ role: 'user' | 'model'; parts: JsonObject[] }> = [];
  const callNames = new Map<string, string>();

  const append = (role: 'user' | 'model', parts: JsonObject[]) => {
    if (parts.length === 0) return;
    const previous = contents[contents.length - 1];
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'assistant') {
      const signatures = readGeminiThoughtSignatures(
        message.providerMetadata,
        model
      );
      const parts: JsonObject[] = [];
      if (message.content) {
        parts.push({
          text: message.content,
          ...(signatures?.text ? { thoughtSignature: signatures.text } : {}),
        });
      }
      for (const call of message.tool_calls ?? []) {
        callNames.set(call.id, call.function.name);
        const signature = signatures?.calls?.[call.id];
        parts.push({
          functionCall: {
            ...(call.id.startsWith(LOCAL_CALL_ID_PREFIX)
              ? {}
              : { id: call.id }),
            name: call.function.name,
            args: parseArguments(call.function.arguments),
          },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      }
      append('model', parts);
      continue;
    }

    if (message.role === 'tool') {
      const id = message.tool_call_id ?? '';
      append('user', [
        {
          functionResponse: {
            ...(id && !id.startsWith(LOCAL_CALL_ID_PREFIX) ? { id } : {}),
            name: callNames.get(id) ?? 'tool',
            response: { result: message.content },
          },
        },
      ]);
      continue;
    }

    const parts: JsonObject[] = (message.images ?? []).map(image => ({
      inlineData: splitImage(image),
    }));
    if (message.content) parts.push({ text: message.content });
    append('user', parts);
  }

  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
  };
}

export function toGeminiTools(
  tools: readonly ProviderToolSpec[] | undefined
): JsonObject[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      })),
    },
  ];
}

/** `:generateContent` becomes the server-sent-events stream of the same call. */
export function geminiStreamingEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(
    /:generateContent$/,
    ':streamGenerateContent'
  );
  url.searchParams.set('alt', 'sse');
  return url.toString();
}

const FINISH_REASONS: Record<string, string> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  IMAGE_SAFETY: 'content_filter',
};

function finishReason(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === 'FINISH_REASON_UNSPECIFIED') {
    return undefined;
  }
  return FINISH_REASONS[value] ?? value.toLowerCase();
}

function usageFrom(value: unknown):
  | {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    }
  | undefined {
  const usage = asObject(value);
  if (!usage) return undefined;
  const count = (key: string): number | undefined =>
    typeof usage[key] === 'number' ? (usage[key] as number) : undefined;
  const promptTokens = count('promptTokenCount');
  const candidates = count('candidatesTokenCount');
  const thoughts = count('thoughtsTokenCount');
  // Thinking is billed as output but reported apart from the answer.
  const completionTokens =
    candidates === undefined && thoughts === undefined
      ? undefined
      : (candidates ?? 0) + (thoughts ?? 0);
  const totalTokens =
    count('totalTokenCount') ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function providerError(payload: JsonObject): string | undefined {
  const error = asObject(payload.error);
  if (typeof error?.message === 'string') return error.message.slice(0, 500);
  const blocked = asObject(payload.promptFeedback)?.blockReason;
  if (
    typeof blocked === 'string' &&
    !(Array.isArray(payload.candidates) && payload.candidates.length > 0)
  ) {
    return `Gemini blocked the prompt (${blocked})`;
  }
  return undefined;
}

/**
 * Reads one `GenerateContentResponse`, whole or streamed, into stream chunks
 * and collects the signatures it carries.
 */
class GeminiResponseReader {
  private readonly signatures: GeminiThoughtSignatures;
  private callIndex = 0;
  doneReason: string | undefined;

  constructor(model: string) {
    this.signatures = { model };
  }

  *read(payload: JsonObject): Generator<PluginStreamChunk> {
    const error = providerError(payload);
    if (error) throw new Error(`Plugin API error: ${error}`);

    const candidates = Array.isArray(payload.candidates)
      ? payload.candidates
      : [];
    const candidate = asObject(candidates[0]);
    const parts = asObject(candidate?.content)?.parts;
    for (const rawPart of Array.isArray(parts) ? parts : []) {
      const part = asObject(rawPart);
      if (!part) continue;
      const signature =
        typeof part.thoughtSignature === 'string'
          ? part.thoughtSignature
          : undefined;
      const call = asObject(part.functionCall);
      if (call && typeof call.name === 'string') {
        const id =
          typeof call.id === 'string' && call.id
            ? call.id
            : `${LOCAL_CALL_ID_PREFIX}${this.callIndex++}`;
        if (signature) {
          this.signatures.calls = { ...this.signatures.calls, [id]: signature };
        }
        yield {
          type: 'tool_call',
          toolCall: {
            id,
            name: call.name,
            arguments: JSON.stringify(asObject(call.args) ?? {}),
            ...(signature
              ? { providerMetadata: { geminiThoughtSignature: signature } }
              : {}),
          },
        };
        continue;
      }
      if (signature) this.signatures.text = signature;
      if (typeof part.text === 'string' && part.text) {
        yield part.thought === true
          ? { type: 'reasoning', content: part.text }
          : { type: 'content', content: part.text };
      }
    }

    const reason = finishReason(candidate?.finishReason);
    if (reason) this.doneReason = reason;

    const usage = usageFrom(payload.usageMetadata);
    if (usage) yield { type: 'usage', usage };
  }

  providerMetadata(): Record<string, unknown> | undefined {
    return this.signatures.text || this.signatures.calls
      ? { [GEMINI_THOUGHT_SIGNATURES_METADATA_KEY]: { ...this.signatures } }
      : undefined;
  }

  done(): PluginStreamChunk {
    const providerMetadata = this.providerMetadata();
    return {
      type: 'done',
      ...(this.doneReason ? { doneReason: this.doneReason } : {}),
      ...(providerMetadata ? { providerMetadata } : {}),
    };
  }
}

/**
 * A `streamGenerateContent?alt=sse` response as stream chunks. A server that
 * answers with plain JSON instead (a whole response, or the JSON array the
 * stream returns without `alt=sse`) is read the same way.
 */
export async function* streamGeminiResponse(
  response: Response,
  model: string
): AsyncGenerator<PluginStreamChunk, void, unknown> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Plugin API error: ${response.status} - ${errorText.slice(0, 200)}`
    );
  }

  const reader = new GeminiResponseReader(model);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const parsed = (await response.json()) as unknown;
    for (const payload of Array.isArray(parsed) ? parsed : [parsed]) {
      const record = asObject(payload);
      if (record) yield* reader.read(record);
    }
    yield reader.done();
    return;
  }

  if (!response.body) {
    throw new Error('No response body for streaming');
  }
  const body = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await body.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        let payload: JsonObject | undefined;
        try {
          payload = asObject(JSON.parse(trimmed.slice(5).trim()));
        } catch {
          // A malformed event does not end the stream.
          continue;
        }
        if (payload) yield* reader.read(payload);
      }
    }
    yield reader.done();
  } finally {
    await body.cancel().catch(() => undefined);
    body.releaseLock();
  }
}

/** A whole `generateContent` response in the OpenAI-shaped plugin response. */
export function convertGeminiResponse(
  geminiResponse: Record<string, unknown>,
  model: string
): PluginResponse {
  const reader = new GeminiResponseReader(model);
  let content = '';
  let reasoning = '';
  let usage: PluginResponse['usage'];
  const toolCalls: NonNullable<
    PluginResponse['choices'][number]['message']['tool_calls']
  > = [];
  for (const chunk of reader.read(geminiResponse)) {
    if (chunk.type === 'content') content += chunk.content;
    else if (chunk.type === 'reasoning') reasoning += chunk.content;
    else if (chunk.type === 'tool_call') {
      toolCalls.push({
        id: chunk.toolCall.id,
        type: 'function',
        function: {
          name: chunk.toolCall.name,
          arguments: chunk.toolCall.arguments,
        },
      });
    } else if (chunk.type === 'usage' && chunk.usage) {
      const prompt = chunk.usage.promptTokens ?? 0;
      const completion = chunk.usage.completionTokens ?? 0;
      usage = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: chunk.usage.totalTokens ?? prompt + completion,
      };
    }
  }
  const providerMetadata = reader.providerMetadata();

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    ...(providerMetadata ? { providerMetadata } : {}),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: reader.doneReason ?? 'stop',
      },
    ],
    usage,
  };
}
