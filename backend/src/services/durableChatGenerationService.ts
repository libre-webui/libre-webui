/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { userModel } from '../models/userModel.js';
import { getDurableEventGateway } from '../platform/events/index.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import { durableEventId } from '../platform/jobs/durableEventIdentity.js';
import type { DurableJobExecutionContext } from '../platform/jobs/embeddedDurableJobWorker.js';
import { DurableJobExecutionError } from '../platform/jobs/durableJobTypes.js';
import { CHAT_GENERATE_JOB_TYPE } from '../platform/jobs/domainJobContracts.js';
import type { GenerationOptions } from '../types/index.js';
import type { OllamaChatResponse } from '../types/index.js';
import {
  buildChatDocumentContext,
  EMPTY_CHAT_DOCUMENT_CONTEXT,
} from '../utils/chatDocumentContext.js';
import { extractStatistics } from '../utils/generationUtils.js';
import { formatPluginStreamToolCalls } from '../utils/pluginStreaming.js';
import { createChatStreamCoalescer } from '../utils/chatStreamCoalescer.js';
import agentCliService from './agentCliService.js';
import chatGenerationService from './chatGenerationService.js';
import { ChatRequestService } from './chatRequestService.js';
import { assertDurableChatCompletionEvent } from './durableChatCompletion.js';
import chatService from './chatService.js';
import { personaService } from './personaService.js';
import preferencesService from './preferencesService.js';
import ollamaService from './ollamaService.js';
import pluginService from './pluginService.js';
import {
  buildWebSearchEnhancedContent,
  isWebSearchAvailable,
  userCanUseWebSearch,
  webSearch,
  type WebSearchResult,
} from './webSearchService.js';

export interface DurableChatGenerationInput {
  sessionId: string;
  actorUserId: string;
  userMessageId: string;
  assistantMessageId: string;
  message: string;
  hasImages: boolean;
  options: Record<string, unknown>;
  webSearch: boolean;
  regenerate: boolean;
  originalMessageId?: string;
}

const requestService = new ChatRequestService({
  chatGenerationService,
  personaService,
  preferencesService,
});

/**
 * A completion event has to fit the durable payload ceiling, and a long reply
 * with reasoning does not. The message itself is persisted in the same
 * transaction, so an oversized event drops the bulky fields and marks itself
 * truncated; a client that was not streaming reloads the session instead of
 * reading them off the event.
 */
const boundCompletionPayload = (value: {
  type: 'done';
  messageId: string;
  content: string;
  thinking?: string;
  statistics?: unknown;
  providerMetadata?: unknown;
}): Record<string, unknown> => {
  const BUDGET_BYTES = 48 * 1024;
  const size = (candidate: unknown): number =>
    Buffer.byteLength(JSON.stringify(candidate), 'utf8');
  if (size(value) <= BUDGET_BYTES) return value;

  // The payload must hold JSON values only, so bulky fields are removed
  // rather than blanked with undefined.
  const withoutThinking: Record<string, unknown> = {
    ...value,
    truncated: true,
  };
  delete withoutThinking.thinking;
  if (size(withoutThinking) <= BUDGET_BYTES) return withoutThinking;

  return { ...withoutThinking, content: '' };
};

/**
 * Split text into pieces that each fit a byte budget, never cutting a
 * character in half. A provider is free to emit one enormous delta, and a
 * single event that exceeds the durable payload ceiling would fail the whole
 * generation.
 */
const sliceByBytes = (text: string, maxBytes: number): string[] => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text ? [text] : [];
  const pieces: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, 'utf8');
    if (currentBytes + width > maxBytes) {
      pieces.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += width;
  }
  if (current) pieces.push(current);
  return pieces;
};

const streamId = (sessionId: string): string => `chat:${sessionId}`;

const append = async (
  input: DurableChatGenerationInput,
  eventType: string,
  payload: Record<string, unknown>,
  occurrenceId: string
): Promise<void> => {
  await getDurableEventGateway().append({
    eventId: durableEventId(
      'chat',
      input.sessionId,
      input.assistantMessageId,
      occurrenceId
    ),
    streamId: streamId(input.sessionId),
    eventType,
    subjectId: input.assistantMessageId,
    actorUserId: input.actorUserId,
    payload: { mode: 'encrypted', value: payload },
  });
};

const completionAlreadyPublished = async (
  input: DurableChatGenerationInput
): Promise<boolean> => {
  const expectedEventId = durableEventId(
    'chat',
    input.sessionId,
    input.assistantMessageId,
    'done'
  );
  const event = await getDurableJobRuntime().service.getEvent(expectedEventId);
  if (!event) return false;
  assertDurableChatCompletionEvent(event, {
    eventId: expectedEventId,
    sessionId: input.sessionId,
    assistantMessageId: input.assistantMessageId,
    actorUserId: input.actorUserId,
  });
  return true;
};

interface GeneratedAssistant {
  response: OllamaChatResponse;
  content: string;
  thinking?: string;
}

const streamGeneratedAssistant = async (
  input: DurableChatGenerationInput,
  prepared: Awaited<ReturnType<ChatRequestService['prepareGenerationRequest']>>,
  context: Pick<
    DurableJobExecutionContext,
    'signal' | 'attemptCount' | 'assertSideEffectAllowed'
  >
): Promise<GeneratedAssistant> => {
  let content = '';
  let thinking = '';
  let providerMetadata: Record<string, unknown> | undefined;
  let finalResponse: OllamaChatResponse | undefined;
  let streamEventSequence = 0;
  // Chunk events carry only their delta. Persisting the accumulated total in
  // every event made storage quadratic in message length; consumers rebuild
  // the message by replaying the generation's ordered deltas.
  // Leaves room for the event envelope inside the durable payload ceiling.
  const MAX_DELTA_BYTES = 32 * 1024;
  const publish = async (batch: {
    contentDelta: string;
    thinkingDelta: string;
  }): Promise<void> => {
    await context.assertSideEffectAllowed();
    const emit = async (content: string, thinking?: string): Promise<void> => {
      await append(
        input,
        'chat.stream.v1',
        {
          type: 'chunk',
          messageId: input.assistantMessageId,
          content,
          ...(thinking ? { thinking } : {}),
          done: false,
        },
        `attempt:${context.attemptCount}:stream:${++streamEventSequence}`
      );
    };

    const fitsInOneEvent =
      Buffer.byteLength(batch.contentDelta, 'utf8') +
        Buffer.byteLength(batch.thinkingDelta, 'utf8') <=
      MAX_DELTA_BYTES;
    if (fitsInOneEvent) {
      await emit(batch.contentDelta, batch.thinkingDelta || undefined);
      return;
    }

    // Ordered pieces: reasoning first, then the answer, exactly as a
    // consumer replaying the stream would rebuild them.
    for (const piece of sliceByBytes(batch.thinkingDelta, MAX_DELTA_BYTES)) {
      await emit('', piece);
    }
    for (const piece of sliceByBytes(batch.contentDelta, MAX_DELTA_BYTES)) {
      await emit(piece);
    }
  };
  const streamPublisher = createChatStreamCoalescer(publish);
  const queuePublish = (contentDelta = '', thinkingDelta = ''): void => {
    streamPublisher.queue({
      contentDelta,
      thinkingDelta,
    });
  };

  if (prepared.target.providerType === 'agent' && prepared.target.providerId) {
    try {
      for await (const chunk of agentCliService.executeAgentStreamRequest(
        prepared.target.providerId,
        prepared.pluginMessages,
        input.actorUserId,
        { model: prepared.target.actualModelName, signal: context.signal }
      )) {
        if (chunk.type === 'content' && chunk.content) {
          content += chunk.content;
          queuePublish(chunk.content);
        } else if (chunk.type === 'reasoning' && chunk.content) {
          thinking += chunk.content;
          queuePublish('', chunk.content);
        } else if (chunk.type === 'done' && chunk.providerMetadata) {
          providerMetadata = chunk.providerMetadata;
        }
      }
    } finally {
      await streamPublisher.drain();
    }
    return {
      response: chatGenerationService.createPluginChatResponse(
        prepared.target.actualModelName,
        content,
        thinking || undefined,
        providerMetadata
      ),
      content,
      ...(thinking ? { thinking } : {}),
    };
  }

  if (prepared.target.activePlugin && prepared.shouldStreamPlugin) {
    const toolCalls: Array<{
      id: string;
      name: string;
      arguments: string;
    }> = [];
    // Token counts the provider reported; without them the statistics strip
    // shows nothing for provider-backed replies.
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    let providerTimings:
      { promptMs?: number; predictedMs?: number } | undefined;
    try {
      for await (const chunk of pluginService.executePluginStreamRequest(
        prepared.target.actualModelName,
        prepared.pluginMessages,
        prepared.target.mergedOptions,
        input.actorUserId,
        prepared.target.activePlugin.id,
        context.signal
      )) {
        if (chunk.type === 'content' && chunk.content) {
          content += chunk.content;
          queuePublish(chunk.content);
        } else if (chunk.type === 'reasoning' && chunk.content) {
          thinking += chunk.content;
          queuePublish('', chunk.content);
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          toolCalls.push(chunk.toolCall);
        } else if (chunk.type === 'usage') {
          if (chunk.usage) usage = { ...usage, ...chunk.usage };
          if (chunk.timings)
            providerTimings = { ...providerTimings, ...chunk.timings };
        } else if (chunk.type === 'done') {
          if (chunk.doneReason?.startsWith('incomplete:')) {
            throw new Error(
              `Provider returned an incomplete response (${chunk.doneReason.slice('incomplete:'.length) || 'unknown'})`
            );
          }
          providerMetadata = chunk.providerMetadata;
        }
      }
    } finally {
      await streamPublisher.drain();
    }
    const toolContent = formatPluginStreamToolCalls(toolCalls);
    if (toolContent) {
      content += toolContent;
      queuePublish(toolContent);
      await streamPublisher.drain();
    }
    return {
      response: chatGenerationService.createPluginChatResponse(
        prepared.target.actualModelName,
        content,
        thinking || undefined,
        providerMetadata,
        {
          ...(usage?.promptTokens !== undefined
            ? { prompt_tokens: usage.promptTokens }
            : {}),
          ...(usage?.completionTokens !== undefined
            ? { completion_tokens: usage.completionTokens }
            : {}),
        },
        // The server reports milliseconds; the statistics contract is
        // nanoseconds, matching Ollama.
        providerTimings
          ? {
              ...(providerTimings.promptMs !== undefined
                ? { firstTokenNs: providerTimings.promptMs * 1e6 }
                : {}),
              ...(providerTimings.predictedMs !== undefined
                ? { generationNs: providerTimings.predictedMs * 1e6 }
                : {}),
              ...(providerTimings.promptMs !== undefined &&
              providerTimings.predictedMs !== undefined
                ? {
                    totalNs:
                      (providerTimings.promptMs + providerTimings.predictedMs) *
                      1e6,
                  }
                : {}),
            }
          : undefined
      ),
      content,
      ...(thinking ? { thinking } : {}),
    };
  }

  if (prepared.target.activePlugin) {
    const generated = await chatGenerationService.executeNonStreaming({
      target: prepared.target,
      ollamaMessages: prepared.ollamaMessages,
      pluginMessages: prepared.pluginMessages,
      userId: input.actorUserId,
      pluginFallbackPolicy: 'allow',
      signal: context.signal,
    });
    content = generated.assistantContent;
    thinking = generated.assistantThinking || '';
    await publish({
      contentDelta: content,
      thinkingDelta: thinking,
    });
    return {
      response: generated.response,
      content,
      ...(thinking ? { thinking } : {}),
    };
  }

  let streamError: Error | undefined;
  await ollamaService.generateChatStreamResponse(
    {
      model: prepared.target.actualModelName,
      messages: prepared.ollamaMessages,
      stream: true,
      options: prepared.target.mergedOptions as Record<string, unknown>,
    },
    chunk => {
      const contentDelta = chunk.message.content || '';
      const thinkingDelta = chunk.message.thinking || '';
      content += contentDelta;
      thinking += thinkingDelta;
      finalResponse = chunk;
      if (contentDelta || thinkingDelta) {
        queuePublish(contentDelta, thinkingDelta);
      }
    },
    error => {
      streamError = error;
    },
    () => undefined,
    context.signal,
    { userId: input.actorUserId }
  );
  await streamPublisher.drain();
  if (streamError) throw streamError;
  if (!finalResponse) throw new Error('Provider stream produced no response');
  return {
    response: {
      ...finalResponse,
      message: {
        ...finalResponse.message,
        content,
        ...(thinking ? { thinking } : {}),
      },
    },
    content,
    ...(thinking ? { thinking } : {}),
  };
};

class DurableChatGenerationService {
  async execute(
    input: DurableChatGenerationInput,
    context: Pick<
      DurableJobExecutionContext,
      'signal' | 'attemptCount' | 'assertSideEffectAllowed' | 'sideEffectLease'
    >
  ): Promise<void> {
    const session = await chatService.getSession(
      input.sessionId,
      input.actorUserId
    );
    if (!session) throw new Error('Chat session no longer exists');
    const existing = session.messages.find(
      message => message.id === input.assistantMessageId
    );
    const completionPublished = await completionAlreadyPublished(input);
    if (completionPublished) {
      if (!existing) {
        throw new DurableJobExecutionError(
          false,
          'chat-completion-inconsistent',
          'The chat completion event has no assistant message'
        );
      }
      return;
    }
    if (existing) {
      throw new DurableJobExecutionError(
        false,
        'chat-message-conflict',
        'The assistant message identity is already in use'
      );
    }

    let assistant;
    {
      let documentContext = EMPTY_CHAT_DOCUMENT_CONTEXT(input.message);
      try {
        documentContext = await buildChatDocumentContext(
          input.message,
          input.sessionId,
          input.actorUserId,
          context.signal
        );
      } catch (error) {
        if (context.signal.aborted) throw error;
      }
      let enhancedContent = documentContext.enhancedContent;
      let hasRelevantContext = documentContext.hasRelevantContext;
      let webSearchSources: Array<{ title: string; url: string }> | undefined;
      if (
        input.webSearch &&
        (await isWebSearchAvailable()) &&
        (await userCanUseWebSearch(
          await userModel.getUserById(input.actorUserId)
        ))
      ) {
        await context.assertSideEffectAllowed();
        try {
          const results: WebSearchResult[] = await webSearch(
            input.message,
            undefined,
            context.signal
          );
          if (results.length > 0) {
            enhancedContent = buildWebSearchEnhancedContent(
              enhancedContent,
              results,
              input.message
            );
            hasRelevantContext = true;
            webSearchSources = results.map(({ title, url }) => ({
              title,
              url,
            }));
          }
        } catch (error) {
          if (context.signal.aborted) throw error;
        }
      }
      // getMessagesForContext may compact the session — a real side effect,
      // so it must run fenced like the generation below it.
      await context.assertSideEffectAllowed();
      const prepared = await requestService.prepareGenerationRequest({
        session,
        userId: input.actorUserId,
        options: input.options as GenerationOptions,
        persistedMessages: (
          await chatService.getMessagesForContext(
            input.sessionId,
            input.actorUserId,
            undefined,
            context.signal
          )
        ).filter(message => {
          if (!input.regenerate || !input.originalMessageId) return true;
          const original = session.messages.find(
            candidate => candidate.id === input.originalMessageId
          );
          const parentId = original?.parentId || input.originalMessageId;
          return message.id !== parentId && message.parentId !== parentId;
        }),
        regenerate: input.regenerate,
        content: input.message,
        hasRelevantContext,
        enhancedContent,
        signal: context.signal,
      });
      await context.assertSideEffectAllowed();
      // Provider calls are at-least-once across a worker crash. Application
      // effects below are keyed by assistantMessageId and remain idempotent.
      const generated = await streamGeneratedAssistant(
        input,
        prepared,
        context
      );
      await context.assertSideEffectAllowed();
      const authoritative = await chatService.getSession(
        input.sessionId,
        input.actorUserId
      );
      if (!authoritative) {
        throw new Error('Chat session disappeared during generation');
      }
      const conflicting = authoritative.messages.find(
        message => message.id === input.assistantMessageId
      );
      if (conflicting) {
        throw new DurableJobExecutionError(
          false,
          'chat-message-conflict',
          'The assistant message identity is already in use'
        );
      }
      assistant = {
        id: input.assistantMessageId,
        role: 'assistant' as const,
        content: generated.content,
        thinking: generated.thinking,
        model: authoritative.model,
        timestamp: Date.now(),
        statistics: extractStatistics(generated.response),
        providerMetadata:
          webSearchSources?.length || documentContext.sources.length > 0
            ? {
                ...(generated.response.message.providerMetadata ?? {}),
                ...(webSearchSources?.length ? { webSearchSources } : {}),
                ...(documentContext.sources.length > 0
                  ? { ragSources: documentContext.sources }
                  : {}),
              }
            : generated.response.message.providerMetadata,
        ...(input.regenerate && input.originalMessageId
          ? (() => {
              const original = authoritative.messages.find(
                message => message.id === input.originalMessageId
              );
              return {
                parentId: original?.parentId || input.originalMessageId,
                isActive: true,
              };
            })()
          : {}),
      };
    }

    const cursor = await chatService.publishDurableChatCompletion({
      sessionId: input.sessionId,
      userId: input.actorUserId,
      message: assistant,
      lease: context.sideEffectLease,
      expectedJobType: CHAT_GENERATE_JOB_TYPE,
      event: {
        eventId: durableEventId(
          'chat',
          input.sessionId,
          input.assistantMessageId,
          'done'
        ),
        streamId: streamId(input.sessionId),
        eventType: 'chat.done.v1',
        subjectId: input.assistantMessageId,
        actorUserId: input.actorUserId,
        payload: {
          mode: 'encrypted',
          value: boundCompletionPayload({
            type: 'done',
            messageId: input.assistantMessageId,
            content: assistant.content,
            ...(assistant.thinking ? { thinking: assistant.thinking } : {}),
            ...(assistant.statistics
              ? { statistics: assistant.statistics }
              : {}),
            ...(assistant.providerMetadata
              ? { providerMetadata: assistant.providerMetadata }
              : {}),
          }),
        },
      },
    });
    await getDurableEventGateway().notify(cursor);
  }
}

export default new DurableChatGenerationService();
