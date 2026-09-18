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

/** JSON-only protocol for one-call access to a native DSH model registry. */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
export const NATIVE_PROVIDER_INSTANCE_HEADER = 'x-native-provider-instance';

export interface NativeProviderModel {
  providerId: string;
  model: string;
  name: string;
  providerName: string;
  contextWindow?: number;
  defaultMaxTokens?: number;
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>;
    defaultEffort?: string;
  };
}

export interface NativeProviderCatalog {
  instanceId: string;
  models: NativeProviderModel[];
}

export type NativeProviderRequest = Omit<
  GenerateOptions,
  'signal' | 'sessionId'
> & {
  instanceId?: string;
};

export class NativeProviderProtocolError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'NativeProviderProtocolError';
  }
}

function fail(label: string): never {
  throw new NativeProviderProtocolError(`Invalid native provider ${label}.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    fail(label);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string
): void {
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(
      key => !required.includes(key) && !optional.includes(key)
    )
  )
    fail(label);
}

function text(
  value: unknown,
  label: string,
  maximum = 2048,
  empty = false
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    value.length > maximum
  )
    fail(label);
}

function integer(value: unknown, label: string, minimum = 0): void {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    fail(label);
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  minimum = 0
): void {
  if (value[key] !== undefined) integer(value[key], key, minimum);
}

/** Reject non-JSON inputs and bound arbitrary schemas/replay data as well as text. */
function json(value: unknown, limit: number): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 32) fail('JSON complexity');
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      item.forEach(child => visit(child, depth + 1));
      return;
    }
    const object = record(item, 'JSON value');
    Object.values(object).forEach(child => visit(child, depth + 1));
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > limit) {
    throw new NativeProviderProtocolError(
      'Native provider message exceeds its byte limit.',
      413
    );
  }
}

function block(value: unknown): void {
  const data = record(value, 'content block');
  switch (data.type) {
    case 'text':
    case 'reasoning':
      keys(data, ['type', 'text'], [], 'text block');
      text(data.text, 'text', MAX_CHUNK_BYTES, true);
      return;
    case 'tool-call':
      keys(data, ['type', 'id', 'name', 'arguments'], [], 'tool call');
      text(data.id, 'tool call ID');
      text(data.name, 'tool name');
      text(data.arguments, 'tool arguments', MAX_REQUEST_BYTES, true);
      return;
    case 'tool-result':
      keys(data, ['type', 'toolCallId', 'content'], ['isError'], 'tool result');
      text(data.toolCallId, 'tool result ID');
      blocks(data.content);
      if (data.isError !== undefined && typeof data.isError !== 'boolean')
        fail('tool result outcome');
      return;
    default:
      // Native file/image references are capabilities, not transferable text.
      fail('content block type');
  }
}

function blocks(value: unknown): void {
  if (!Array.isArray(value) || value.length > 2048) fail('message content');
  value.forEach(block);
}

function message(value: unknown): void {
  const data = record(value, 'message');
  keys(data, ['id', 'role', 'content', 'source'], [], 'message');
  text(data.id, 'message ID');
  if (!['system', 'user', 'assistant'].includes(String(data.role)))
    fail('message role');
  blocks(data.content);
  const source = record(data.source, 'message source');
  switch (source.kind) {
    case 'user':
      keys(source, ['kind'], [], 'user source');
      break;
    case 'plugin':
      keys(source, ['kind', 'plugin'], [], 'plugin source');
      text(source.plugin, 'plugin source ID');
      break;
    case 'tool':
      keys(source, ['kind', 'callId'], [], 'tool source');
      text(source.callId, 'tool source ID');
      break;
    case 'model':
      keys(
        source,
        ['kind', 'provider', 'model'],
        ['replayState'],
        'model source'
      );
      text(source.provider, 'source provider');
      text(source.model, 'source model');
      break;
    default:
      fail('message source kind');
  }
  if (data.role === 'system' && source.kind !== 'plugin') fail('system source');
  if (source.kind === 'tool') {
    const content = data.content as Array<Record<string, unknown>>;
    if (
      data.role !== 'user' ||
      content.length !== 1 ||
      content[0].type !== 'tool-result' ||
      content[0].toolCallId !== source.callId
    )
      fail('tool result correlation');
  }
}

export function parseNativeProviderRequest(
  value: unknown
): NativeProviderRequest {
  json(value, MAX_REQUEST_BYTES);
  const data = record(value, 'request');
  keys(
    data,
    ['provider', 'model', 'messages'],
    [
      'instanceId',
      'system',
      'tools',
      'temperature',
      'maxTokens',
      'stop',
      'reasoningEffort',
      'purpose',
    ],
    'request'
  );
  text(data.provider, 'provider');
  text(data.model, 'model');
  if (data.instanceId !== undefined) text(data.instanceId, 'instance ID', 128);
  if (data.reasoningEffort !== undefined)
    text(data.reasoningEffort, 'reasoning effort');
  if (
    data.purpose !== undefined &&
    !['session-title', 'compaction'].includes(String(data.purpose))
  )
    fail('request purpose');
  if (data.system !== undefined)
    text(data.system, 'system prompt', MAX_REQUEST_BYTES, true);
  if (!Array.isArray(data.messages) || data.messages.length > 2048)
    fail('messages');
  data.messages.forEach(message);
  optionalInteger(data, 'maxTokens', 1);
  if (
    data.temperature !== undefined &&
    (typeof data.temperature !== 'number' ||
      !Number.isFinite(data.temperature) ||
      data.temperature < 0 ||
      data.temperature > 2)
  )
    fail('temperature');
  if (data.stop !== undefined) {
    if (!Array.isArray(data.stop) || data.stop.length > 64)
      fail('stop sequences');
    data.stop.forEach(item => text(item, 'stop sequence'));
  }
  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools) || data.tools.length > 256) fail('tools');
    const names = new Set<string>();
    for (const item of data.tools) {
      const tool = record(item, 'tool schema');
      keys(tool, ['name', 'description', 'parameters'], [], 'tool schema');
      text(tool.name, 'tool name');
      text(tool.description, 'tool description', MAX_REQUEST_BYTES, true);
      record(tool.parameters, 'tool parameters');
      if (names.has(tool.name)) fail('duplicate tool name');
      names.add(tool.name);
    }
  }
  return data as unknown as NativeProviderRequest;
}

export function parseNativeProviderCatalog(
  value: unknown
): NativeProviderCatalog {
  json(value, MAX_CHUNK_BYTES);
  const data = record(value, 'catalog');
  keys(data, ['instanceId', 'models'], [], 'catalog');
  text(data.instanceId, 'instance ID', 128);
  if (!Array.isArray(data.models) || data.models.length > 10000)
    fail('catalog models');
  const seen = new Set<string>();
  for (const entry of data.models) {
    const model = record(entry, 'catalog model');
    keys(
      model,
      ['providerId', 'model', 'name', 'providerName'],
      ['contextWindow', 'defaultMaxTokens', 'reasoning'],
      'catalog model'
    );
    for (const key of ['providerId', 'model', 'name', 'providerName'])
      text(model[key], `catalog ${key}`, 4096);
    const identity = JSON.stringify([model.providerId, model.model]);
    if (seen.has(identity)) fail('duplicate catalog model');
    seen.add(identity);
    optionalInteger(model, 'contextWindow', 1);
    optionalInteger(model, 'defaultMaxTokens', 1);
    if (model.reasoning !== undefined) {
      const reasoning = record(model.reasoning, 'reasoning catalog');
      keys(reasoning, ['efforts'], ['defaultEffort'], 'reasoning catalog');
      if (!Array.isArray(reasoning.efforts) || reasoning.efforts.length > 64)
        fail('reasoning efforts');
      const efforts = new Set<string>();
      for (const entry of reasoning.efforts) {
        const effort = record(entry, 'reasoning effort');
        keys(effort, ['id', 'name'], ['description'], 'reasoning effort');
        text(effort.id, 'reasoning effort ID');
        text(effort.name, 'reasoning effort name');
        if (effort.description !== undefined)
          text(effort.description, 'reasoning effort description', 16384, true);
        if (efforts.has(effort.id)) fail('duplicate reasoning effort');
        efforts.add(effort.id);
      }
      if (
        reasoning.defaultEffort !== undefined &&
        !efforts.has(String(reasoning.defaultEffort))
      )
        fail('default reasoning effort');
    }
  }
  return data as unknown as NativeProviderCatalog;
}

export function parseNativeProviderChunk(value: unknown): StreamChunk {
  json(value, MAX_CHUNK_BYTES);
  const data = record(value, 'stream chunk');
  switch (data.type) {
    case 'block-start':
      keys(data, ['type', 'index', 'blockType'], [], 'block start');
      integer(data.index, 'block index');
      if (!['text', 'reasoning', 'tool-call'].includes(String(data.blockType)))
        fail('stream block type');
      break;
    case 'text-delta':
    case 'reasoning-delta':
      keys(data, ['type', 'index', 'text'], [], 'text delta');
      integer(data.index, 'block index');
      text(data.text, 'text delta', MAX_CHUNK_BYTES, true);
      break;
    case 'tool-call-delta':
      keys(
        data,
        ['type', 'index', 'id', 'argumentsDelta'],
        ['name'],
        'tool delta'
      );
      integer(data.index, 'block index');
      text(data.id, 'tool call ID');
      text(data.argumentsDelta, 'tool arguments delta', MAX_CHUNK_BYTES, true);
      if (data.name !== undefined) text(data.name, 'tool name');
      break;
    case 'block-end':
      keys(data, ['type', 'index', 'block'], [], 'block end');
      integer(data.index, 'block index');
      block(data.block);
      break;
    case 'usage': {
      keys(data, ['type', 'usage'], [], 'usage chunk');
      const usage = record(data.usage, 'usage');
      keys(
        usage,
        ['inputTokens', 'outputTokens'],
        [
          'totalTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
          'reasoningTokens',
        ],
        'usage'
      );
      Object.values(usage).forEach(value => integer(value, 'token usage'));
      break;
    }
    case 'finish': {
      keys(data, ['type', 'reason'], ['replayState'], 'finish chunk');
      const reason = record(data.reason, 'finish reason');
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        keys(reason, ['kind', 'failure'], [], 'failure reason');
        const failure = record(reason.failure, 'failure');
        keys(
          failure,
          ['message', 'code'],
          ['status', 'providerRetryAfterMs', 'requestId', 'offloadImages'],
          'failure'
        );
        text(failure.message, 'failure message', MAX_CHUNK_BYTES, true);
        text(failure.code, 'failure code');
        for (const key of ['status', 'providerRetryAfterMs', 'offloadImages'])
          optionalInteger(failure, key);
        if (failure.requestId !== undefined)
          text(failure.requestId, 'provider request ID');
      } else {
        keys(reason, ['kind'], [], 'finish reason');
        if (!['stop', 'tool-calls', 'max-tokens'].includes(String(reason.kind)))
          fail('finish reason kind');
      }
      if (data.replayState !== undefined) {
        const replay = record(data.replayState, 'replay state');
        keys(replay, ['response'], ['blocks'], 'replay state');
        if (replay.blocks !== undefined && !Array.isArray(replay.blocks))
          fail('replay blocks');
      }
      break;
    }
    default:
      fail('stream chunk type');
  }
  return data as unknown as StreamChunk;
}
