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
  const publish = async (batch: {
    contentDelta: string;
    thinkingDelta: string;
    contentTotal: string;
    thinkingTotal: string;
  }): Promise<void> => {
    await context.assertSideEffectAllowed();
    await append(
      input,
      'chat.stream.v1',
      {
        type: 'chunk',
        messageId: input.assistantMessageId,
        content: batch.contentDelta,
        total: batch.contentTotal,
        ...(batch.thinkingDelta
          ? {
              thinking: batch.thinkingDelta,
              thinkingTotal: batch.thinkingTotal,
            }
          : {}),
        done: false,
      },
      `attempt:${context.attemptCount}:stream:${++streamEventSequence}`
    );
  };
  const streamPublisher = createChatStreamCoalescer(publish);
  const queuePublish = (contentDelta = '', thinkingDelta = ''): void => {
    streamPublisher.queue({
      contentDelta,
      thinkingDelta,
      contentTotal: content,
      thinkingTotal: thinking,
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
        providerMetadata
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
      contentTotal: content,
      thinkingTotal: thinking,
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
      const prepared = await requestService.prepareGenerationRequest({
        session,
        userId: input.actorUserId,
        options: input.options as GenerationOptions,
        persistedMessages: (
          await chatService.getMessagesForContext(
            input.sessionId,
            input.actorUserId
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
          value: {
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
          },
        },
      },
    });
    await getDurableEventGateway().notify(cursor);
  }
}

export default new DurableChatGenerationService();
