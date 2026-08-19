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
 * The native multi-round tool loop (CHAT-03). The loop composes provider
 * rounds inside one assistant turn: when a round finishes with tool calls,
 * the calls run through the approval policy and the gateway, their results
 * extend the in-turn conversation, and the provider is called again. The
 * consumer sees one continuous chunk stream across every round, so each
 * transport still persists exactly one assistant message; the completed
 * turn's calls (with bounded result previews) are recorded on that message's
 * providerMetadata.toolCalls. Cancellation aborts the provider call, any
 * in-flight tool call, and any pending approval wait.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  ChatMessage,
  OllamaChatMessage,
  OllamaChatRequest,
  OllamaChatResponse,
  ProviderToolSpec,
} from '../types/index.js';
import type {
  ChatApprovalEventPayload,
  ChatToolCall,
  ChatToolCallEventPayload,
  ChatToolResultEventPayload,
  EffectiveTool,
} from '../types/tools.js';
import {
  CHAT_APPROVAL_EVENT,
  CHAT_TOOL_CALL_EVENT,
  CHAT_TOOL_RESULT_EVENT,
} from '../types/tools.js';
import type { PluginStreamChunk } from '../utils/pluginStreamAdapter.js';
import { throwIfChatGenerationCancelled } from '../utils/chatCancellation.js';
import type { AuthzActor } from './authorizationService.js';
import {
  APPROVAL_TIMEOUT_MS,
  createPendingApproval,
  findStandingApproval,
  waitForDecision,
} from './toolApprovalService.js';
import { executeToolCall, type ToolCatalog } from './toolGatewayService.js';
import type { OllamaChatStreamGenerator } from '../utils/ollamaStreaming.js';

export const MAX_TOOL_ROUNDS = 8;
export const MAX_TOOL_CALLS_PER_ROUND = 8;
const MAX_RECORDED_ARGUMENT_CHARS = 4096;
const MAX_RESULT_PREVIEW_CHARS = 2000;

export interface ToolLoopEventSink {
  toolEvent(
    event:
      | ChatToolCallEventPayload
      | ChatToolResultEventPayload
      | ChatApprovalEventPayload
  ): void | Promise<void>;
}

export interface PluginToolLoopOptions {
  actor: AuthzActor;
  /** The persisted session id; the loop never runs for private sessions. */
  sessionId: string;
  assistantMessageId: string;
  catalog: ToolCatalog;
  /**
   * Start one provider round. `extension` holds the in-turn wire messages
   * accumulated by earlier rounds, to append after the prepared base context
   * in the transport's native message shape.
   */
  startRound: (
    extension: readonly ChatMessage[],
    tools: readonly ProviderToolSpec[]
  ) => AsyncIterable<PluginStreamChunk>;
  sink: ToolLoopEventSink;
  signal?: AbortSignal;
}

export interface PluginToolLoopState {
  /** Every tool call across every round, with final statuses. */
  toolCalls: ChatToolCall[];
  rounds: number;
}

export const providerToolSpecs = (catalog: ToolCatalog): ProviderToolSpec[] =>
  catalog.tools.map(tool => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.paramsSchema ? { parameters: tool.paramsSchema } : {}),
  }));

const bounded = (value: string, maximum: number): string =>
  value.length > maximum ? `${value.slice(0, maximum)}…` : value;

interface RoundToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ExecutedCall {
  record: ChatToolCall;
  resultText: string;
  isError: boolean;
}

const executeRoundCall = async (
  options: PluginToolLoopOptions,
  call: RoundToolCall,
  overflow: boolean
): Promise<ExecutedCall> => {
  const entry: EffectiveTool | undefined = options.catalog.byName.get(
    call.name
  );
  const record: ChatToolCall = {
    id: call.id,
    name: call.name,
    arguments: bounded(call.arguments, MAX_RECORDED_ARGUMENT_CHARS),
    source: entry?.source ?? 'builtin',
    ...(entry?.serverId ? { serverId: entry.serverId } : {}),
    ...(entry?.serverName ? { serverName: entry.serverName } : {}),
    sideEffect: entry?.sideEffect ?? false,
    status: 'running',
    startedAt: Date.now(),
  };

  const finish = (
    status: ChatToolCall['status'],
    resultText: string,
    isError: boolean
  ): ExecutedCall => {
    record.status = status;
    record.finishedAt = Date.now();
    record.isError = isError;
    record.resultPreview = bounded(resultText, MAX_RESULT_PREVIEW_CHARS);
    if (isError) record.error = record.resultPreview;
    return { record, resultText, isError };
  };

  if (overflow) {
    await options.sink.toolEvent({
      type: CHAT_TOOL_CALL_EVENT,
      messageId: options.assistantMessageId,
      toolCall: { ...record, status: 'failed' },
    });
    return finish(
      'failed',
      `Too many tool calls in one round; at most ${MAX_TOOL_CALLS_PER_ROUND} are executed.`,
      true
    );
  }

  if (!entry) {
    await options.sink.toolEvent({
      type: CHAT_TOOL_CALL_EVENT,
      messageId: options.assistantMessageId,
      toolCall: { ...record, status: 'failed' },
    });
    return finish('failed', `Unknown tool: ${call.name}`, true);
  }

  if (entry.sideEffect) {
    const standing = await findStandingApproval(
      options.actor.userId,
      entry.serverId ?? null,
      entry.toolName,
      options.sessionId
    );
    if (!standing) {
      record.status = 'awaiting_approval';
      const pending = await createPendingApproval({
        userId: options.actor.userId,
        sessionId: options.sessionId,
        serverId: entry.serverId ?? null,
        toolName: entry.toolName,
        callId: call.id,
        argumentsJson: call.arguments,
      });
      await options.sink.toolEvent({
        type: CHAT_APPROVAL_EVENT,
        messageId: options.assistantMessageId,
        approvalId: pending.id,
        toolCall: { ...record },
        expiresAt: pending.expiresAt ?? Date.now() + APPROVAL_TIMEOUT_MS,
      });
      const decision = await waitForDecision(
        options.actor.userId,
        pending.id,
        options.signal
      );
      if (decision.status !== 'approved') {
        const denied = decision.status === 'denied';
        const executed = finish(
          'denied',
          denied
            ? 'The user denied this tool call.'
            : 'The approval request expired before the user decided.',
          true
        );
        await options.sink.toolEvent({
          type: CHAT_TOOL_RESULT_EVENT,
          messageId: options.assistantMessageId,
          toolCallId: call.id,
          status: 'denied',
          preview: executed.record.resultPreview ?? '',
          isError: true,
        });
        return executed;
      }
    }
  }

  record.status = 'running';
  await options.sink.toolEvent({
    type: CHAT_TOOL_CALL_EVENT,
    messageId: options.assistantMessageId,
    toolCall: { ...record },
  });

  const result = await executeToolCall({
    actor: options.actor,
    tool: entry,
    argumentsJson: call.arguments,
    sessionId: options.sessionId,
    selection: options.catalog.selection,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const executed = finish(
    result.isError ? 'failed' : 'succeeded',
    result.text,
    result.isError
  );
  await options.sink.toolEvent({
    type: CHAT_TOOL_RESULT_EVENT,
    messageId: options.assistantMessageId,
    toolCallId: call.id,
    status: executed.record.status,
    preview: executed.record.resultPreview ?? '',
    isError: executed.isError,
  });
  return executed;
};

/**
 * Wrap per-round provider streams into one continuous chunk stream that
 * executes tool calls between rounds. Intermediate `done` chunks are
 * swallowed; per-round usage chunks are summed and re-emitted once before
 * the final `done`, so transports account complete turn usage.
 */
export function runPluginToolLoop(options: PluginToolLoopOptions): {
  chunks: AsyncIterable<PluginStreamChunk>;
  state: PluginToolLoopState;
} {
  const state: PluginToolLoopState = { toolCalls: [], rounds: 0 };
  const tools = providerToolSpecs(options.catalog);

  async function* compose(): AsyncGenerator<PluginStreamChunk, void, unknown> {
    const extension: ChatMessage[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let sawUsage = false;
    let timings:
      | { promptMs?: number; predictedMs?: number; predictedPerSecond?: number }
      | undefined;

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      state.rounds = round;
      throwIfChatGenerationCancelled(options.signal);

      // The final permitted round runs without tools so the model must
      // answer instead of requesting work nothing will execute.
      const roundTools = round < MAX_TOOL_ROUNDS ? tools : [];
      const roundCalls: RoundToolCall[] = [];
      let roundContent = '';
      let roundMetadata: Record<string, unknown> | undefined;
      let doneChunk: PluginStreamChunk | undefined;

      for await (const chunk of options.startRound(extension, roundTools)) {
        throwIfChatGenerationCancelled(options.signal);
        if (chunk.type === 'tool_call' && chunk.toolCall) {
          roundCalls.push(chunk.toolCall);
          continue;
        }
        if (chunk.type === 'usage') {
          if (chunk.usage) {
            sawUsage = true;
            promptTokens += chunk.usage.promptTokens ?? 0;
            completionTokens += chunk.usage.completionTokens ?? 0;
          }
          if (chunk.timings) timings = { ...timings, ...chunk.timings };
          continue;
        }
        if (chunk.type === 'done') {
          roundMetadata = chunk.providerMetadata;
          doneChunk = chunk;
          if (chunk.doneReason?.startsWith('incomplete:')) yield chunk;
          continue;
        }
        if (chunk.type === 'content' && chunk.content) {
          roundContent += chunk.content;
        }
        yield chunk;
      }

      if (roundCalls.length === 0) {
        if (sawUsage) {
          yield {
            type: 'usage',
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            },
            ...(timings ? { timings } : {}),
          };
        }
        yield {
          type: 'done',
          ...(doneChunk?.type === 'done' && doneChunk.doneReason
            ? { doneReason: doneChunk.doneReason }
            : {}),
          ...(roundMetadata ? { providerMetadata: roundMetadata } : {}),
        };
        return;
      }

      const executed: ExecutedCall[] = [];
      for (const [index, call] of roundCalls.entries()) {
        executed.push(
          await executeRoundCall(
            options,
            call,
            index >= MAX_TOOL_CALLS_PER_ROUND
          )
        );
      }
      state.toolCalls.push(...executed.map(entry => entry.record));

      const now = Date.now();
      extension.push({
        id: `${options.assistantMessageId}-round-${round}`,
        role: 'assistant',
        content: roundContent,
        timestamp: now,
        tool_calls: roundCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
        ...(roundMetadata ? { providerMetadata: roundMetadata } : {}),
      });
      for (const entry of executed) {
        extension.push({
          id: `${entry.record.id}-result`,
          role: 'tool',
          content: entry.resultText,
          timestamp: now,
          tool_call_id: entry.record.id,
        });
      }
    }

    // The round cap ran out with the model still requesting tools (the final
    // round offers none, but a provider may ignore that). Close the turn
    // anyway so every transport still sees exactly one terminal chunk.
    if (sawUsage) {
      yield {
        type: 'usage',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        ...(timings ? { timings } : {}),
      };
    }
    yield { type: 'done', doneReason: 'tool-round-limit' };
  }

  return { chunks: compose(), state };
}

/** Convert the loop's in-turn wire messages into Ollama's native shapes. */
export const toOllamaExtensionMessages = (
  extension: readonly ChatMessage[]
): OllamaChatMessage[] =>
  extension.map(message => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      };
    }
    return {
      role: message.role as OllamaChatMessage['role'],
      content: message.content,
      ...(message.tool_calls?.length
        ? {
            tool_calls: message.tool_calls.map(callWire => ({
              function: {
                name: callWire.function.name,
                arguments: callWire.function.arguments,
              },
            })),
          }
        : {}),
    };
  });

/**
 * Present an Ollama chat stream as the plugin chunk vocabulary so the tool
 * loop and the shared consumers treat both provider families identically.
 * Ollama does not assign tool-call ids, so the bridge mints them.
 */
export function ollamaStreamAsPluginChunks(
  request: OllamaChatRequest,
  source: OllamaChatStreamGenerator,
  state: { finalChunk?: OllamaChatResponse },
  signal?: AbortSignal,
  usage?: { userId?: string }
): AsyncIterable<PluginStreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      const queue: PluginStreamChunk[] = [];
      let notify: (() => void) | undefined;
      let finished = false;
      let failure: Error | undefined;

      const push = (chunk: PluginStreamChunk): void => {
        queue.push(chunk);
        notify?.();
      };

      void source
        .generateChatStreamResponse(
          request,
          chunk => {
            if (chunk.message?.thinking) {
              push({ type: 'reasoning', content: chunk.message.thinking });
            }
            if (chunk.message?.content) {
              push({ type: 'content', content: chunk.message.content });
            }
            if (Array.isArray(chunk.message?.tool_calls)) {
              for (const rawCall of chunk.message.tool_calls) {
                const fn =
                  rawCall && typeof rawCall === 'object'
                    ? (
                        rawCall as {
                          function?: { name?: unknown; arguments?: unknown };
                        }
                      ).function
                    : undefined;
                if (!fn || typeof fn.name !== 'string') continue;
                push({
                  type: 'tool_call',
                  toolCall: {
                    id: `ollama-call-${uuidv4()}`,
                    name: fn.name,
                    arguments:
                      typeof fn.arguments === 'string'
                        ? fn.arguments
                        : JSON.stringify(fn.arguments ?? {}),
                  },
                });
              }
            }
            if (chunk.done) {
              state.finalChunk = chunk;
              const promptTokens = chunk.prompt_eval_count;
              const completionTokens = chunk.eval_count;
              if (
                typeof promptTokens === 'number' ||
                typeof completionTokens === 'number'
              ) {
                push({
                  type: 'usage',
                  usage: {
                    ...(typeof promptTokens === 'number'
                      ? { promptTokens }
                      : {}),
                    ...(typeof completionTokens === 'number'
                      ? { completionTokens }
                      : {}),
                  },
                });
              }
              push({ type: 'done' });
            }
          },
          error => {
            failure = error;
            notify?.();
          },
          () => {
            finished = true;
            notify?.();
          },
          signal,
          usage
        )
        .catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
          notify?.();
        })
        .finally(() => {
          finished = true;
          notify?.();
        });

      return {
        async next(): Promise<IteratorResult<PluginStreamChunk>> {
          for (;;) {
            const chunk = queue.shift();
            if (chunk) return { value: chunk, done: false };
            if (failure) throw failure;
            if (finished) return { value: undefined, done: true };
            await new Promise<void>(resolve => {
              notify = resolve;
            });
            notify = undefined;
          }
        },
        async return(): Promise<IteratorResult<PluginStreamChunk>> {
          finished = true;
          return { value: undefined, done: true };
        },
      };
    },
  };
}
