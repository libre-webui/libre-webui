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
 * A Strands model that serves every turn through Libre WebUI's own provider
 * services. The agent loop, tools, and sessions belong to Strands; the model
 * call goes through the same Ollama and plugin paths Chat uses, so provider
 * credentials, usage metering, and the Ollama switch apply unchanged.
 *
 * Strands expects one content block at a time and a message stop event that
 * says why the turn ended. Tools only run when that reason is 'toolUse'.
 */

import { randomUUID } from 'node:crypto';
import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
  type SystemPrompt,
  type ToolSpec,
} from '@strands-agents/sdk';
import type {
  ChatMessage,
  GenerationOptions,
  ProviderToolSpec,
} from '../types/index.js';
import pluginService from '../services/pluginService.js';
import ollamaService from '../services/ollamaService.js';
import { toOpenAICompatibleTools } from '../utils/pluginChatAdapter.js';
import type { PluginStreamToolCall } from '../utils/pluginStreaming.js';
import type { ResolvedStrandsRoute } from './catalog.js';

const MAX_BUFFERED_EVENTS = 2048;
const MAX_BUFFERED_BYTES = 2_000_000;

export interface LibreWebUiModelConfig extends BaseModelConfig {
  /** Route id the engine resolved for this session. */
  modelId: string;
}

type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCall: PluginStreamToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; reason?: string };

function systemText(prompt: SystemPrompt | undefined): string {
  if (!prompt) return '';
  if (typeof prompt === 'string') return prompt;
  return prompt
    .map(block => (block.type === 'textBlock' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

function toolResultText(block: {
  content: ReadonlyArray<{ type: string; text?: string; json?: unknown }>;
}): string {
  return block.content
    .map(item => {
      if (item.type === 'textBlock') return item.text ?? '';
      if (item.type === 'jsonBlock') return JSON.stringify(item.json);
      return `[${item.type} omitted]`;
    })
    .join('\n');
}

/** Convert a Strands transcript into Libre WebUI's provider message shape. */
export function toChatMessages(
  messages: readonly Message[],
  systemPrompt?: SystemPrompt
): ChatMessage[] {
  const now = Date.now();
  let index = 0;
  const id = () => `strands-${now}-${index++}`;
  const out: ChatMessage[] = [];
  const system = systemText(systemPrompt);
  if (system) {
    out.push({ id: id(), role: 'system', content: system, timestamp: now });
  }
  for (const message of messages) {
    const text: string[] = [];
    const thinking: string[] = [];
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'textBlock':
          text.push(block.text);
          break;
        case 'reasoningBlock':
          if (block.text) thinking.push(block.text);
          break;
        case 'toolUseBlock':
          toolCalls.push({
            id: block.toolUseId,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
          break;
        case 'toolResultBlock':
          out.push({
            id: id(),
            role: 'tool',
            content:
              (block.status === 'error' ? 'Error: ' : '') +
              toolResultText(block),
            tool_call_id: block.toolUseId,
            timestamp: now,
          });
          break;
        default:
          break;
      }
    }
    if (text.length === 0 && toolCalls.length === 0) continue;
    out.push({
      id: id(),
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: text.join(''),
      ...(thinking.length ? { thinking: thinking.join('') } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      timestamp: now,
    });
  }
  return out;
}

export function toProviderTools(
  specs: readonly ToolSpec[] | undefined
): ProviderToolSpec[] | undefined {
  if (!specs?.length) return undefined;
  return specs.map(spec => ({
    name: spec.name,
    description: spec.description,
    parameters: (spec.inputSchema as Record<string, unknown> | undefined) ?? {
      type: 'object',
      properties: {},
    },
  }));
}

export function stopReasonFor(
  reason: string | undefined,
  hasTools: boolean
): 'toolUse' | 'maxTokens' | 'endTurn' {
  if (hasTools) return 'toolUse';
  if (
    reason === 'length' ||
    reason === 'max_tokens' ||
    reason === 'max-tokens' ||
    reason === 'incomplete:max_output_tokens'
  ) {
    return 'maxTokens';
  }
  return 'endTurn';
}

export class LibreWebUiModel extends Model<LibreWebUiModelConfig> {
  private config: LibreWebUiModelConfig;

  constructor(
    private readonly target: ResolvedStrandsRoute,
    private readonly userId: string,
    config: Partial<LibreWebUiModelConfig> = {}
  ) {
    super();
    this.config = { ...config, modelId: target.id };
  }

  updateConfig(modelConfig: LibreWebUiModelConfig): void {
    this.config = { ...this.config, ...modelConfig, modelId: this.target.id };
  }

  getConfig(): LibreWebUiModelConfig {
    return { ...this.config };
  }

  async *stream(
    messages: Message[],
    options: StreamOptions = {}
  ): AsyncIterable<ModelStreamEvent> {
    const signal = options.cancelSignal;
    signal?.throwIfAborted();
    const chatMessages = toChatMessages(messages, options.systemPrompt);
    const tools = toProviderTools(options.toolSpecs);
    const generation: GenerationOptions = {
      ...(this.config.temperature === undefined
        ? {}
        : { temperature: this.config.temperature }),
      ...(this.config.maxTokens === undefined
        ? {}
        : { num_predict: this.config.maxTokens }),
    };

    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    let open: 'text' | 'reasoning' | undefined;
    let hasTools = false;
    let doneReason: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;

    const source =
      this.target.route.type === 'plugin'
        ? this.pluginEvents(chatMessages, generation, tools, signal)
        : this.ollamaEvents(chatMessages, generation, tools, signal);

    for await (const event of source) {
      if (event.type === 'text' || event.type === 'reasoning') {
        if (!event.text) continue;
        if (open && open !== event.type) {
          yield { type: 'modelContentBlockStopEvent' };
          open = undefined;
        }
        open = event.type;
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta:
            event.type === 'text'
              ? { type: 'textDelta', text: event.text }
              : { type: 'reasoningContentDelta', text: event.text },
        };
        continue;
      }
      if (event.type === 'tool-call') {
        if (open) {
          yield { type: 'modelContentBlockStopEvent' };
          open = undefined;
        }
        hasTools = true;
        yield {
          type: 'modelContentBlockStartEvent',
          start: {
            type: 'toolUseStart',
            name: event.toolCall.name,
            toolUseId: event.toolCall.id || `call_${randomUUID()}`,
          },
        };
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'toolUseInputDelta',
            input: event.toolCall.arguments || '{}',
          },
        };
        yield { type: 'modelContentBlockStopEvent' };
        continue;
      }
      if (event.type === 'usage') {
        sawUsage = true;
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        continue;
      }
      doneReason = event.reason;
    }
    signal?.throwIfAborted();
    if (open) yield { type: 'modelContentBlockStopEvent' };
    yield {
      type: 'modelMessageStopEvent',
      stopReason: stopReasonFor(doneReason, hasTools),
    };
    if (sawUsage) {
      yield {
        type: 'modelMetadataEvent',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      };
    }
  }

  private async *pluginEvents(
    messages: ChatMessage[],
    generation: GenerationOptions,
    tools: ProviderToolSpec[] | undefined,
    signal?: AbortSignal
  ): AsyncGenerator<ProviderEvent> {
    const route = this.target.route;
    if (route.type !== 'plugin') return;
    for await (const chunk of pluginService.executePluginStreamRequest(
      route.model,
      messages,
      { ...generation, ...(tools ? { tools } : {}) },
      this.userId,
      route.pluginId,
      signal
    )) {
      signal?.throwIfAborted();
      if (chunk.type === 'content' && chunk.content) {
        yield { type: 'text', text: chunk.content };
      } else if (chunk.type === 'reasoning' && chunk.content) {
        yield { type: 'reasoning', text: chunk.content };
      } else if (chunk.type === 'tool_call' && chunk.toolCall) {
        yield { type: 'tool-call', toolCall: chunk.toolCall };
      } else if (chunk.type === 'usage' && chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.promptTokens ?? 0,
          outputTokens: chunk.usage.completionTokens ?? 0,
        };
      } else if (chunk.type === 'done') {
        yield { type: 'done', reason: chunk.doneReason };
      }
    }
  }

  /** Ollama streams through callbacks, so bridge them onto a bounded queue. */
  private async *ollamaEvents(
    messages: ChatMessage[],
    generation: GenerationOptions,
    tools: ProviderToolSpec[] | undefined,
    outer?: AbortSignal
  ): AsyncGenerator<ProviderEvent> {
    const controller = new AbortController();
    const signal = outer
      ? AbortSignal.any([outer, controller.signal])
      : controller.signal;
    const queue: ProviderEvent[] = [];
    let bufferedBytes = 0;
    let settled = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    let doneReason: string | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const fail = (error: Error) => {
      failure ??= error;
      settled = true;
      notify();
    };
    const push = (event: ProviderEvent) => {
      if (settled || signal.aborted) return;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (
        queue.length >= MAX_BUFFERED_EVENTS ||
        bufferedBytes + bytes > MAX_BUFFERED_BYTES
      ) {
        const error = new Error(
          'Strands provider output exceeded its stream buffer limit.'
        );
        fail(error);
        controller.abort(error);
        return;
      }
      queue.push(event);
      bufferedBytes += bytes;
      notify();
    };
    const abort = () =>
      fail(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Request aborted')
      );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();

    const route = this.target.route;
    const finished = ollamaService
      .generateChatStreamResponse(
        {
          model: route.model,
          messages,
          stream: true,
          options: { ...generation } as Record<string, unknown>,
          ...(tools?.length ? { tools: toOpenAICompatibleTools(tools) } : {}),
        },
        chunk => {
          const text = chunk.message?.content;
          if (text) push({ type: 'text', text });
          if (chunk.message?.thinking) {
            push({ type: 'reasoning', text: chunk.message.thinking });
          }
          for (const rawCall of chunk.message?.tool_calls ?? []) {
            const fn = rawCall.function as
              { name?: unknown; arguments?: unknown } | undefined;
            push({
              type: 'tool-call',
              toolCall: {
                id:
                  typeof rawCall.id === 'string' && rawCall.id
                    ? rawCall.id
                    : `call_${randomUUID()}`,
                name: typeof fn?.name === 'string' ? fn.name : '',
                arguments:
                  typeof fn?.arguments === 'string'
                    ? fn.arguments
                    : JSON.stringify(fn?.arguments ?? {}),
              },
            });
          }
          if (
            typeof chunk.prompt_eval_count === 'number' &&
            typeof chunk.eval_count === 'number'
          ) {
            push({
              type: 'usage',
              inputTokens: chunk.prompt_eval_count,
              outputTokens: chunk.eval_count,
            });
          }
          if (chunk.done_reason) doneReason = chunk.done_reason;
        },
        fail,
        () => push({ type: 'done', reason: doneReason }),
        signal,
        { userId: this.userId }
      )
      .catch(error =>
        fail(error instanceof Error ? error : new Error(String(error)))
      )
      .finally(() => {
        settled = true;
        notify();
      });
    try {
      while (!settled || queue.length) {
        if (failure) throw failure;
        const event = queue.shift();
        if (event) {
          bufferedBytes -= Buffer.byteLength(JSON.stringify(event));
          yield event;
        } else {
          await new Promise<void>(resolve => {
            wake = resolve;
          });
        }
      }
      if (failure) throw failure;
    } finally {
      signal.removeEventListener('abort', abort);
      controller.abort();
      queue.length = 0;
      await finished;
    }
  }
}
