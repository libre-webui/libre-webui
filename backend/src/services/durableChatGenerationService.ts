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
import { toOpenAICompatibleTools } from '../utils/pluginChatAdapter.js';
import agentCliService from './agentCliService.js';
import chatGenerationService from './chatGenerationService.js';
import { ChatRequestService } from './chatRequestService.js';
import type { AuthzActor } from './authorizationService.js';
import {
  ollamaStreamAsPluginChunks,
  runPluginToolLoop,
  toOllamaExtensionMessages,
  type ToolLoopEventSink,
} from './chatToolRuntimeService.js';
import {
  actorCanUseTools,
  buildToolCatalog,
  intersectToolSelection,
  sanitizeRequestedToolSelection,
  type RequestedToolSelection,
  type ToolCatalog,
} from './toolGatewayService.js';
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
} from './webSearchService.js';
import { runPlannedWebSearch } from './webSearchPlanService.js';

export interface DurableChatGenerationInput {
  sessionId: string;
  actorUserId: string;
  userMessageId: string;
  assistantMessageId: string;
  message: string;
  hasImages: boolean;
  options: Record<string, unknown>;
  webSearch: boolean;
  tools: boolean;
  toolSelection?: RequestedToolSelection;
  regenerate: boolean;
  originalMessageId?: string;
  modelOverride?: {
    model: string;
    providerType?: string | null;
    providerId?: string | null;
  };
  compare?: boolean;
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

interface DurableToolContext {
  actor: AuthzActor;
  catalog: ToolCatalog;
}

const streamGeneratedAssistant = async (
  input: DurableChatGenerationInput,
  prepared: Awaited<ReturnType<ChatRequestService['prepareGenerationRequest']>>,
  context: Pick<
    DurableJobExecutionContext,
    'signal' | 'attemptCount' | 'assertSideEffectAllowed'
  >,
  toolContext?: DurableToolContext
): Promise<GeneratedAssistant> => {
  let content = '';
  let thinking = '';
  let providerMetadata: Record<string, unknown> | undefined;
  let finalResponse: OllamaChatResponse | undefined;
  let streamEventSequence = 0;
  let toolEventSequence = 0;
  const toolSink: ToolLoopEventSink = {
    toolEvent: async event => {
      await context.assertSideEffectAllowed();
      await append(
        input,
        'chat.tool.v1',
        event as unknown as Record<string, unknown>,
        `attempt:${context.attemptCount}:tool:${++toolEventSequence}`
      );
    },
  };
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

  if (
    prepared.target.activePlugin &&
    (prepared.shouldStreamPlugin || toolContext)
  ) {
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
    const activePluginId = prepared.target.activePlugin.id;
    const toolLoop = toolContext
      ? runPluginToolLoop({
          actor: toolContext.actor,
          sessionId: input.sessionId,
          assistantMessageId: input.assistantMessageId,
          catalog: toolContext.catalog,
          sink: toolSink,
          signal: context.signal,
          startRound: (extension, tools) =>
            pluginService.executePluginStreamRequest(
              prepared.target.actualModelName,
              [...prepared.pluginMessages, ...extension],
              { ...prepared.target.mergedOptions, tools: [...tools] },
              input.actorUserId,
              activePluginId,
              context.signal
            ),
        })
      : undefined;
    try {
      for await (const chunk of toolLoop
        ? toolLoop.chunks
        : pluginService.executePluginStreamRequest(
            prepared.target.actualModelName,
            prepared.pluginMessages,
            prepared.target.mergedOptions,
            input.actorUserId,
            activePluginId,
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
    if (toolLoop && toolLoop.state.toolCalls.length > 0) {
      providerMetadata = {
        ...(providerMetadata ?? {}),
        toolCalls: toolLoop.state.toolCalls,
      };
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

  if (toolContext) {
    const bridgeState: { finalChunk?: OllamaChatResponse } = {};
    const loop = runPluginToolLoop({
      actor: toolContext.actor,
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      catalog: toolContext.catalog,
      sink: toolSink,
      signal: context.signal,
      startRound: (extension, tools) =>
        ollamaStreamAsPluginChunks(
          {
            model: prepared.target.actualModelName,
            messages: [
              ...prepared.ollamaMessages,
              ...toOllamaExtensionMessages(extension),
            ],
            stream: true,
            options: prepared.target.mergedOptions as Record<string, unknown>,
            ...(tools.length > 0
              ? { tools: toOpenAICompatibleTools([...tools]) }
              : {}),
          },
          ollamaService,
          bridgeState,
          context.signal,
          { userId: input.actorUserId }
        ),
    });
    try {
      for await (const chunk of loop.chunks) {
        if (chunk.type === 'content' && chunk.content) {
          content += chunk.content;
          queuePublish(chunk.content);
        } else if (chunk.type === 'reasoning' && chunk.content) {
          thinking += chunk.content;
          queuePublish('', chunk.content);
        }
      }
    } finally {
      await streamPublisher.drain();
    }
    const finalChunk = bridgeState.finalChunk;
    if (!finalChunk) throw new Error('Provider stream produced no response');
    return {
      response: {
        ...finalChunk,
        message: {
          ...finalChunk.message,
          content,
          ...(thinking ? { thinking } : {}),
          ...(loop.state.toolCalls.length > 0
            ? {
                providerMetadata: {
                  ...(finalChunk.message.providerMetadata ?? {}),
                  toolCalls: loop.state.toolCalls,
                },
              }
            : {}),
        },
      },
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

    // The tool loop runs only when the turn asked for it, the actor passes
    // the tools feature gate, and the effective catalog is non-empty.
    let toolContext: DurableToolContext | undefined;
    if (input.tools) {
      const actorUser = await userModel.getUserById(input.actorUserId);
      const actor: AuthzActor = {
        userId: input.actorUserId,
        ...(actorUser?.role ? { role: actorUser.role } : {}),
      };
      if (await actorCanUseTools(actor)) {
        const bindings = session.personaId
          ? (
              await personaService.getPersonaById(
                session.personaId,
                input.actorUserId
              )
            )?.bindings
          : undefined;
        // The turn's picker can narrow the offered tools, never widen past
        // the profile binding.
        const requestedSelection = sanitizeRequestedToolSelection(
          input.toolSelection
        );
        const catalog = await buildToolCatalog(
          actor,
          { sessionId: input.sessionId },
          {
            builtinTools: intersectToolSelection(
              bindings?.builtin_tools,
              requestedSelection?.builtinTools
            ),
            serverIds: intersectToolSelection(
              bindings?.tool_server_ids,
              requestedSelection?.serverIds
            ),
            skillIds: bindings?.skill_ids,
            collectionIds: bindings?.knowledge_collection_ids,
          }
        );
        if (catalog.tools.length > 0) toolContext = { actor, catalog };
      }
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
          const { results } = await runPlannedWebSearch({
            message: input.message,
            session,
            userId: input.actorUserId,
            signal: context.signal,
          });
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
      // A comparison turn answers with a different model while the session
      // itself keeps its own binding.
      const generationSession = input.modelOverride
        ? {
            ...session,
            model: input.modelOverride.model,
            providerType: (input.modelOverride.providerType ??
              null) as typeof session.providerType,
            providerId: input.modelOverride.providerId ?? null,
          }
        : session;
      const prepared = await requestService.prepareGenerationRequest({
        session: generationSession,
        userId: input.actorUserId,
        options: input.options as GenerationOptions,
        persistedMessages: (
          await chatService.getMessagesForContext(
            input.sessionId,
            input.actorUserId,
            undefined,
            context.signal,
            // Compaction runs once, on the first attempt; a retry serves
            // whatever that attempt already persisted.
            context.attemptCount > 1
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
        context,
        toolContext
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
      const metadataExtras: Record<string, unknown> = {};
      if (webSearchSources?.length) {
        metadataExtras.webSearchSources = webSearchSources;
      }
      if (documentContext.sources.length > 0) {
        metadataExtras.ragSources = documentContext.sources;
        metadataExtras.ragContextMode = documentContext.mode;
      }
      if (documentContext.fullContextSkipped) {
        metadataExtras.ragFullContextSkipped =
          documentContext.fullContextSkipped;
      }
      if (input.compare) {
        metadataExtras.compareGroup = input.userMessageId;
      }
      assistant = {
        id: input.assistantMessageId,
        role: 'assistant' as const,
        content: generated.content,
        thinking: generated.thinking,
        model: input.modelOverride?.model ?? authoritative.model,
        timestamp: Date.now(),
        statistics: extractStatistics(generated.response),
        providerMetadata:
          Object.keys(metadataExtras).length > 0
            ? {
                ...(generated.response.message.providerMetadata ?? {}),
                ...metadataExtras,
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
