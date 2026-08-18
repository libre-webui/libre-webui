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

import {
  ChatSession,
  ChatMessage,
  ChatProviderSelection,
  Persona,
  MemorySearchResult,
  SessionFolder,
} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import storageService from '../storage.js';
import preferencesService from './preferencesService.js';
import { personaService } from './personaService.js';
import { memoryService } from './memoryService.js';
import { mutationEngineService } from './mutationEngineService.js';
import { createLogger } from '../utils/logger.js';
import { normalizeChatProviderSelection } from '../utils/chatProviderSelection.js';
import {
  sanitizeChatMessageProviderState,
  selectChatMessagesForContext,
} from '../utils/chatContext.js';
import {
  MAX_SESSION_FOLDER_NAME_LENGTH,
  ResourcePolicyError,
} from '../utils/resourceLimits.js';
import { getCoordinator } from '../platform/coordination/service.js';
import {
  COMPACTION_SUMMARY_PREFIX,
  getCompactionConfig,
  planCompaction,
  type CompactionPlan,
} from './contextCompactionService.js';
import { transactionalChatGenerationEnqueuer } from '../platform/jobs/chatGenerationEnqueuer.js';
import {
  CHAT_GENERATE_JOB_TYPE,
  chatEventStreamId,
  chatGenerationIdempotencyScope,
} from '../platform/jobs/domainJobContracts.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import type {
  DurableJobEventAppendInput,
  DurableJobLeaseIdentity,
} from '../platform/jobs/durableJobTypes.js';

const logger = createLogger('chat-service');

export interface ChatMessagePersistenceOptions {
  /**
   * Assert that the caller still owns this generation before its assistant
   * message becomes authoritative. The assertion runs while the session write
   * lease is held, immediately before and after persistence.
   */
  assertPersistenceAllowed?: () => void | Promise<void>;
}

export class ChatCancellationCompensationError extends Error {
  constructor(
    readonly cancellationError: unknown,
    readonly compensationError: unknown
  ) {
    super('Chat cancellation compensation failed');
    this.name = 'ChatCancellationCompensationError';
  }
}

class ChatService {
  private sessions: Map<string, ChatSession> = new Map();

  private async withSessionWriteLease<T>(
    sessionId: string,
    userId: string,
    operation: (assertHeld: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const coordinator = getCoordinator();
    const deadline = Date.now() + 10_000;
    let lease = await coordinator.acquireLease(
      `chat-write:${userId}:${sessionId}`,
      30_000
    );
    while (!lease && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      lease = await coordinator.acquireLease(
        `chat-write:${userId}:${sessionId}`,
        30_000
      );
    }
    if (!lease) throw new Error('The chat is being updated; retry the request');

    let closed = false;
    let leaseLost = false;
    let renewalTimer: NodeJS.Timeout | undefined;
    const leaseLostError = (): Error =>
      new Error('The shared chat write lease was lost');
    const markLost = (): void => {
      leaseLost = true;
    };
    const assertHeld = async (): Promise<void> => {
      if (closed || leaseLost) throw leaseLostError();
      try {
        if (await lease.extend(30_000)) return;
      } catch {
        // Report expiry and coordination outages through one safe fence.
      }
      markLost();
      throw leaseLostError();
    };
    const renew = async (): Promise<void> => {
      if (closed) return;
      try {
        if (!(await lease.extend(30_000))) markLost();
      } catch {
        markLost();
      }
      if (!closed && !leaseLost) renewalTimer = setTimeout(renew, 10_000);
    };
    renewalTimer = setTimeout(renew, 10_000);
    try {
      await assertHeld();
      const result = await operation(assertHeld);
      return result;
    } finally {
      closed = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      await lease.release().catch(() => false);
    }
  }

  private async loadSessions(): Promise<void> {
    try {
      const sessionsArray = await storageService.getAllSessions();
      this.sessions = new Map(
        sessionsArray.map(session => [session.id, session])
      );
      logger.debug(`Loaded ${sessionsArray.length} sessions from storage`);
    } catch (error) {
      logger.error('Failed to load sessions:', error);
    }
  }

  async createSession(
    model: string,
    title?: string,
    userId: string = 'default',
    personaId?: string,
    providerSelection?: ChatProviderSelection
  ): Promise<ChatSession> {
    const sessionId = uuidv4();
    const now = Date.now();
    const normalizedProvider =
      normalizeChatProviderSelection(providerSelection);

    const session: ChatSession = {
      id: sessionId,
      title: title || 'New Chat',
      messages: [],
      model,
      createdAt: now,
      updatedAt: now,
      personaId,
      ...normalizedProvider,
    };

    // Add system message - prioritize persona system prompt over global preferences
    let systemMessage = '';

    // If model is a persona, try to get the persona's system prompt
    if (model.startsWith('persona:')) {
      try {
        const personaIdFromModel = model.replace('persona:', '');
        const { personaService } = await import('./personaService.js');

        // Get persona for the current user only (no fallback to maintain privacy)
        const persona = await personaService.getPersonaById(
          personaIdFromModel,
          userId
        );

        if (persona && persona.parameters?.system_prompt) {
          systemMessage = persona.parameters.system_prompt.trim();
        }
      } catch (error) {
        logger.error(`Error getting persona system prompt:`, error);
      }
    }

    // If no persona system prompt, fall back to global preferences
    if (!systemMessage) {
      const globalSystemMessage =
        await preferencesService.getSystemMessage(userId);
      if (globalSystemMessage && globalSystemMessage.trim()) {
        systemMessage = globalSystemMessage.trim();
      }
    }

    // Add the system message if we have one
    if (systemMessage) {
      const systemMsg: ChatMessage = {
        id: uuidv4(),
        role: 'system',
        content: systemMessage,
        timestamp: now,
      };
      session.messages.push(systemMsg);
      session.updatedAt = now;
    }

    this.sessions.set(sessionId, session);

    // Save to storage with user ID
    await storageService.saveSession(session, userId);
    return session;
  }

  async getSession(
    sessionId: string,
    userId: string = 'default'
  ): Promise<ChatSession | undefined> {
    // Persistence is authoritative. This prevents another replica's updates or
    // revocations from being hidden behind process-local state.
    const session = await storageService.getSession(sessionId, userId);
    if (session) this.sessions.set(sessionId, session);
    else this.sessions.delete(sessionId);
    return session;
  }

  async getAllSessions(userId: string = 'default'): Promise<ChatSession[]> {
    // Load fresh data from storage to ensure we have the latest
    const sessionsArray = await storageService.getAllSessions(userId);

    // Update memory cache with user-specific sessions
    // Note: We don't clear the entire cache since other users might be using it
    sessionsArray.forEach(session => {
      this.sessions.set(session.id, session);
    });

    return sessionsArray;
  }

  async updateSession(
    sessionId: string,
    updates: Partial<ChatSession>,
    userId: string = 'default'
  ): Promise<ChatSession | undefined> {
    return this.withSessionWriteLease(sessionId, userId, assertHeld =>
      this.updateSessionWithLeaseHeld(sessionId, updates, userId, assertHeld)
    );
  }

  private async updateSessionWithLeaseHeld(
    sessionId: string,
    updates: Partial<ChatSession>,
    userId: string,
    assertHeld: () => Promise<void>
  ): Promise<ChatSession | undefined> {
    // First verify the session belongs to the user
    const session = await this.getSession(sessionId, userId);
    if (!session) return undefined;

    // Aggregate identity and messages are immutable through the metadata PUT.
    // Accepting a stale client snapshot here can erase a worker response even
    // when every writer takes the same session lease.
    const {
      id: _ignoredId,
      messages: _ignoredMessages,
      createdAt: _ignoredCreatedAt,
      updatedAt: _ignoredUpdatedAt,
      ...sanitizedUpdates
    } = updates;
    const updatedSession = {
      ...session,
      ...sanitizedUpdates,
      updatedAt: Date.now(),
    };
    const hasProviderUpdate =
      Object.prototype.hasOwnProperty.call(updates, 'providerType') ||
      Object.prototype.hasOwnProperty.call(updates, 'providerId');
    const modelChanged = Boolean(
      updates.model && updates.model !== session.model
    );

    if (hasProviderUpdate || modelChanged) {
      const normalizedProvider = hasProviderUpdate
        ? normalizeChatProviderSelection(updates)
        : undefined;
      updatedSession.providerType = normalizedProvider?.providerType;
      updatedSession.providerId = normalizedProvider?.providerId;
    }

    // If the model is being updated and it's a persona, update the system message and personaId
    if (updates.model && updates.model !== session.model) {
      if (updates.model.startsWith('persona:')) {
        const personaId = updates.model.replace('persona:', '');

        // Update personaId
        updatedSession.personaId = personaId;

        // Update system message with persona's system prompt
        await this.updateSystemMessageForPersona(
          updatedSession,
          personaId,
          userId
        );
      } else {
        // If switching away from a persona to a regular model, clear personaId and use default system message
        updatedSession.personaId = undefined;
        await this.updateSystemMessageToDefault(updatedSession, userId);
      }
    }

    this.sessions.set(sessionId, updatedSession);
    await assertHeld();
    await storageService.saveSession(updatedSession, userId, assertHeld);
    return updatedSession;
  }

  async addMessage(
    sessionId: string,
    message: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string },
    userId: string = 'default',
    options: ChatMessagePersistenceOptions = {}
  ): Promise<ChatMessage | undefined> {
    return this.withSessionWriteLease(sessionId, userId, assertHeld =>
      this.addMessageWithLeaseHeld(sessionId, message, userId, {
        ...options,
        assertPersistenceAllowed: async () => {
          await options.assertPersistenceAllowed?.();
          await assertHeld();
        },
      })
    );
  }

  private async addMessageWithLeaseHeld(
    sessionId: string,
    message: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string },
    userId: string,
    options: ChatMessagePersistenceOptions
  ): Promise<ChatMessage | undefined> {
    // First verify the session belongs to the user
    const session = await this.getSession(sessionId, userId);
    if (!session) {
      return undefined;
    }

    const messageId = message.id || uuidv4();

    await options.assertPersistenceAllowed?.();

    // Check if message with this ID already exists to prevent duplicates
    const existingMessage = session.messages.find(msg => msg.id === messageId);
    if (existingMessage) {
      return existingMessage;
    }

    const newMessage = sanitizeChatMessageProviderState<ChatMessage>({
      ...message,
      id: messageId,
      timestamp: Date.now(),
    });
    const previousSessionUpdatedAt = session.updatedAt;
    const previousActiveMessageId = newMessage.parentId
      ? session.messages.find(
          candidate =>
            (candidate.id === newMessage.parentId ||
              candidate.parentId === newMessage.parentId) &&
            candidate.isActive !== false
        )?.id
      : undefined;

    // If this is a branch message (has parentId), update sibling messages
    if (newMessage.parentId) {
      const parentId = newMessage.parentId;
      if (newMessage.branchIndex === undefined) {
        newMessage.branchIndex = session.messages.filter(
          msg => msg.id === parentId || msg.parentId === parentId
        ).length;
      }

      // Mark all sibling messages (including the parent) as inactive
      for (const msg of session.messages) {
        const isSibling = msg.id === parentId || msg.parentId === parentId;
        if (isSibling) {
          msg.isActive = false;
          // Ensure the parent has branchIndex 0 if it doesn't have one
          if (msg.branchIndex === undefined) {
            msg.branchIndex = 0;
          }
          // Update siblingCount for all siblings
          msg.siblingCount = (newMessage.branchIndex || 0) + 1;
        }
      }
    }

    session.messages.push(newMessage);
    session.updatedAt = Date.now();
    const persistedSessionUpdatedAt = session.updatedAt;

    this.sessions.set(sessionId, session);
    let persistenceError: unknown;
    try {
      await options.assertPersistenceAllowed?.();
      await storageService.saveSession(
        session,
        userId,
        options.assertPersistenceAllowed
      );
    } catch (error) {
      persistenceError = error;
    }

    try {
      // This is the critical post-COMMIT fence. A transport may ignore Abort,
      // or a PostgreSQL acknowledgement may arrive after Stop. In either case
      // the assistant response is not allowed to survive as a ghost message.
      await options.assertPersistenceAllowed?.();
    } catch (cancellationError) {
      try {
        await storageService.removeSessionMessageIfCurrent({
          sessionId,
          userId,
          messageId: newMessage.id,
          expectedTimestamp: newMessage.timestamp,
          expectedSessionUpdatedAt: persistedSessionUpdatedAt,
          previousSessionUpdatedAt,
          previousActiveMessageId,
        });
        // Persistence is authoritative; discard the mutated process snapshot
        // instead of replacing a possibly newer cross-replica aggregate.
        this.sessions.delete(sessionId);
      } catch (compensationError) {
        this.sessions.delete(sessionId);
        // The aggregate's durable state is unknown, so do not pretend this was
        // an ordinary cancellation that callers may silently swallow.
        throw new ChatCancellationCompensationError(
          cancellationError,
          compensationError
        );
      }
      throw cancellationError;
    }
    if (persistenceError) throw persistenceError;

    // Persona-derived side effects must not run for a response rolled back by
    // Stop. Start them only after the post-persistence cancellation fence.
    if (session.personaId) {
      if (message.role === 'user') {
        this.processAdvancedPersonaInteraction(
          session.personaId,
          userId,
          message.content,
          session
        ).catch((error: unknown) =>
          logger.error('Advanced persona processing error:', error)
        );
      } else if (message.role === 'assistant') {
        this.processAdvancedPersonaResponse(
          session.personaId,
          userId,
          message.content
        ).catch((error: unknown) =>
          logger.error('Advanced persona response processing error:', error)
        );
      }
    }

    return newMessage;
  }

  /** Atomically persists a user turn and its durable generation job. */
  async queueDurableGeneration(input: {
    sessionId: string;
    userId: string;
    userMessageId: string;
    assistantMessageId: string;
    message: string;
    images?: string[];
    options?: Record<string, unknown>;
    webSearch?: boolean;
    regenerate?: boolean;
    originalMessageId?: string;
  }): Promise<{ userMessage: ChatMessage; jobId: string } | undefined> {
    return this.withSessionWriteLease(
      input.sessionId,
      input.userId,
      async assertHeld => {
        const session = await this.getSession(input.sessionId, input.userId);
        if (!session) return undefined;
        const existingJob =
          await getDurableJobRuntime().service.getByIdempotency(
            input.userId,
            chatGenerationIdempotencyScope(input.sessionId),
            input.assistantMessageId
          );
        if (input.userMessageId === input.assistantMessageId) {
          throw new Error('Chat message identifiers must be distinct');
        }
        if (
          !existingJob &&
          session.messages.some(
            message => message.id === input.assistantMessageId
          )
        ) {
          throw new Error('The assistant message identity is already in use');
        }
        let userMessage = session.messages.find(
          message => message.id === input.userMessageId
        );
        if (existingJob) {
          if (!userMessage) {
            throw new Error(
              'Chat generation idempotency state is inconsistent'
            );
          }
          return { userMessage, jobId: existingJob.id };
        }
        if (input.regenerate) {
          const original = session.messages.find(
            message => message.id === input.originalMessageId
          );
          if (!original || original.role !== 'assistant') {
            throw new Error(
              'The assistant message to regenerate was not found'
            );
          }
          if (
            !userMessage ||
            userMessage.role !== 'user' ||
            userMessage.content !== input.message ||
            JSON.stringify(userMessage.images ?? []) !==
              JSON.stringify(input.images ?? [])
          ) {
            throw new Error('The regeneration source message is inconsistent');
          }
        } else if (!userMessage) {
          userMessage = sanitizeChatMessageProviderState<ChatMessage>({
            id: input.userMessageId,
            role: 'user',
            content: input.message,
            images: input.images,
            timestamp: Date.now(),
          });
          session.messages.push(userMessage);
          session.updatedAt = Date.now();
        } else if (
          userMessage.role !== 'user' ||
          userMessage.content !== input.message ||
          JSON.stringify(userMessage.images ?? []) !==
            JSON.stringify(input.images ?? [])
        ) {
          throw new Error('Chat generation idempotency key was reused');
        }
        const enqueueInput = {
          sessionId: input.sessionId,
          actorUserId: input.userId,
          userMessageId: input.userMessageId,
          assistantMessageId: input.assistantMessageId,
          message: input.message,
          hasImages: (input.images?.length ?? 0) > 0,
          options: input.options ?? {},
          webSearch: input.webSearch === true,
          regenerate: input.regenerate === true,
          ...(input.regenerate && input.originalMessageId
            ? { originalMessageId: input.originalMessageId }
            : {}),
        };
        const persistAndEnqueue = (): Promise<void> =>
          storageService.saveSessionAndEnqueueGeneration(
            session,
            input.userId,
            transactionalChatGenerationEnqueuer,
            enqueueInput,
            assertHeld
          );
        try {
          await assertHeld();
          await persistAndEnqueue();
        } catch {
          // This SQL transaction can commit while the client loses only its
          // acknowledgement. Repeating the exact aggregate + durable payload
          // is safe: the durable idempotency fingerprint either returns the
          // committed job or rejects an inconsistent reuse. It also completes
          // a transaction that genuinely rolled back, so the caller never gets
          // a false conflict for a user turn already persisted by PostgreSQL.
          const committedJob =
            await getDurableJobRuntime().service.getByIdempotency(
              input.userId,
              chatGenerationIdempotencyScope(input.sessionId),
              input.assistantMessageId
            );
          const committedSession = await storageService.getSession(
            input.sessionId,
            input.userId
          );
          const committedMessage = committedSession?.messages.find(
            candidate => candidate.id === input.userMessageId
          );
          if (
            committedJob?.jobType === CHAT_GENERATE_JOB_TYPE &&
            committedJob.actorUserId === input.userId &&
            committedMessage?.role === 'user' &&
            committedMessage.content === input.message &&
            JSON.stringify(committedMessage.images ?? []) ===
              JSON.stringify(input.images ?? [])
          ) {
            this.sessions.delete(input.sessionId);
            return { userMessage: committedMessage, jobId: committedJob.id };
          }
          await assertHeld();
          await persistAndEnqueue();
        }
        this.sessions.set(input.sessionId, session);
        const job = await getDurableJobRuntime().service.getByIdempotency(
          input.userId,
          chatGenerationIdempotencyScope(input.sessionId),
          input.assistantMessageId
        );
        if (!job) {
          throw new Error(
            'Chat generation transaction did not publish its job'
          );
        }
        const persistedSession = await storageService.getSession(
          input.sessionId,
          input.userId
        );
        const persistedUserMessage = persistedSession?.messages.find(
          message => message.id === input.userMessageId
        );
        if (
          job.jobType !== CHAT_GENERATE_JOB_TYPE ||
          job.actorUserId !== input.userId ||
          !persistedUserMessage ||
          persistedUserMessage.role !== 'user' ||
          persistedUserMessage.content !== input.message ||
          JSON.stringify(persistedUserMessage.images ?? []) !==
            JSON.stringify(input.images ?? [])
        ) {
          throw new Error(
            'Chat generation transaction outcome is inconsistent'
          );
        }
        if (session.personaId) {
          void this.processAdvancedPersonaInteraction(
            session.personaId,
            input.userId,
            input.message,
            session
          ).catch(error =>
            logger.error('Advanced persona processing error:', error)
          );
        }
        return { userMessage, jobId: job.id };
      }
    );
  }

  /**
   * Publish the final assistant row while holding the same distributed write
   * lease as ordinary read/modify/replace chat mutations. The SQL operation
   * then applies the durable job fence and commits the row plus terminal event.
   */
  async publishDurableChatCompletion(input: {
    sessionId: string;
    userId: string;
    message: ChatMessage & { role: 'assistant' };
    lease: DurableJobLeaseIdentity;
    expectedJobType: string;
    event: DurableJobEventAppendInput;
  }): Promise<number> {
    return this.withSessionWriteLease(
      input.sessionId,
      input.userId,
      async assertHeld => {
        const authoritative = await storageService.getSession(
          input.sessionId,
          input.userId
        );
        if (!authoritative) {
          throw new Error('Chat completion session is unavailable');
        }
        if (
          authoritative.messages.some(
            message => message.id === input.message.id
          )
        ) {
          throw new Error('The assistant message identity is already in use');
        }
        if (
          input.message.parentId &&
          !authoritative.messages.some(
            message =>
              message.id === input.message.parentId &&
              message.role === 'assistant'
          )
        ) {
          throw new Error('Chat completion branch root is unavailable');
        }

        await assertHeld();
        const cursor = await storageService.publishDurableChatCompletion({
          ...input,
          beforeCommit: assertHeld,
        });
        // Force every later mutation on this process to reread the atomically
        // published assistant instead of retaining a pre-publication aggregate.
        this.sessions.delete(input.sessionId);
        return cursor;
      }
    );
  }

  async updateMessage(
    sessionId: string,
    messageId: string,
    updates: Partial<ChatMessage>,
    userId: string = 'default'
  ): Promise<ChatMessage | undefined> {
    return this.withSessionWriteLease(sessionId, userId, assertHeld =>
      this.updateMessageWithLeaseHeld(
        sessionId,
        messageId,
        updates,
        userId,
        assertHeld
      )
    );
  }

  private async updateMessageWithLeaseHeld(
    sessionId: string,
    messageId: string,
    updates: Partial<ChatMessage>,
    userId: string,
    assertHeld: () => Promise<void>
  ): Promise<ChatMessage | undefined> {
    // First verify the session belongs to the user
    const session = await this.getSession(sessionId, userId);
    if (!session) {
      logger.error('Session not found or access denied:', sessionId, userId);
      return undefined;
    }

    // Find the message to update
    const messageIndex = session.messages.findIndex(
      msg => msg.id === messageId
    );
    if (messageIndex === -1) {
      logger.error('Message not found:', messageId);
      return undefined;
    }

    // Update the message
    const updatedMessage = sanitizeChatMessageProviderState<ChatMessage>({
      ...session.messages[messageIndex],
      ...updates,
      // Only content edits move the timestamp; metadata updates (e.g. rating)
      // keep the message's place in time.
      timestamp:
        updates.content !== undefined
          ? Date.now()
          : session.messages[messageIndex].timestamp,
    });

    session.messages[messageIndex] = updatedMessage;
    session.updatedAt = Date.now();

    // Save updated session
    this.sessions.set(sessionId, session);
    await assertHeld();
    await storageService.saveSession(session, userId, assertHeld);

    return updatedMessage;
  }

  async deleteSession(
    sessionId: string,
    userId: string = 'default'
  ): Promise<boolean> {
    return this.withSessionWriteLease(sessionId, userId, async assertHeld => {
      await getDurableJobRuntime().service.cancelAllForActor(
        userId,
        'superseded',
        {
          jobTypes: [CHAT_GENERATE_JOB_TYPE],
          idempotencyScopes: [chatGenerationIdempotencyScope(sessionId)],
        }
      );
      return this.deleteSessionWithLeaseHeld(sessionId, userId, assertHeld);
    });
  }

  private async deleteSessionWithLeaseHeld(
    sessionId: string,
    userId: string,
    assertHeld: () => Promise<void>
  ): Promise<boolean> {
    // First verify the session belongs to the user
    const session = await this.getSession(sessionId, userId);
    if (!session) return false;

    await assertHeld();
    const deleted = await storageService.deleteSession(
      sessionId,
      userId,
      assertHeld
    );
    if (deleted) {
      this.sessions.delete(sessionId);
      try {
        // The session is gone; its durable event stream is dead transport.
        // A failure here leaves rows for the retention sweep, not the user.
        await getDurableJobRuntime().service.deleteEventStream(
          chatEventStreamId(sessionId)
        );
      } catch {
        // Retention prunes anything this best-effort cleanup missed.
      }
    }
    return deleted;
  }

  async getSessionFolders(
    userId: string = 'default'
  ): Promise<SessionFolder[]> {
    return storageService.getSessionFolders(userId);
  }

  async createSessionFolder(
    name: unknown,
    userId: string = 'default'
  ): Promise<SessionFolder> {
    const normalizedName = this.normalizeSessionFolderName(name);
    const now = Date.now();
    const folder: SessionFolder = {
      id: uuidv4(),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
    };
    await storageService.saveSessionFolder(folder, userId);
    return folder;
  }

  async renameSessionFolder(
    folderId: string,
    name: unknown,
    userId: string = 'default'
  ): Promise<SessionFolder | undefined> {
    const normalizedName = this.normalizeSessionFolderName(name);
    const folder = (await storageService.getSessionFolders(userId)).find(
      item => item.id === folderId
    );
    if (!folder) return undefined;
    const updated = { ...folder, name: normalizedName, updatedAt: Date.now() };
    await storageService.saveSessionFolder(updated, userId);
    return updated;
  }

  private normalizeSessionFolderName(name: unknown): string {
    if (typeof name !== 'string' || !name.trim()) {
      throw new ResourcePolicyError('Name is required', 400);
    }
    const normalizedName = name.trim();
    if (normalizedName.length > MAX_SESSION_FOLDER_NAME_LENGTH) {
      throw new ResourcePolicyError(
        `Name exceeds the maximum length of ${MAX_SESSION_FOLDER_NAME_LENGTH} characters`,
        400
      );
    }
    return normalizedName;
  }

  async deleteSessionFolder(
    folderId: string,
    userId: string = 'default'
  ): Promise<boolean> {
    const deleted = await storageService.deleteSessionFolder(folderId, userId);
    if (deleted) {
      // Keep the in-memory cache consistent with the cleared folder links.
      for (const session of await this.getAllSessions(userId)) {
        if (session.folderId === folderId) {
          this.sessions.set(session.id, { ...session, folderId: undefined });
        }
      }
    }
    return deleted;
  }

  async clearAllSessions(userId: string = 'default'): Promise<void> {
    await getDurableJobRuntime().service.cancelAllForActor(
      userId,
      'superseded',
      { jobTypes: [CHAT_GENERATE_JOB_TYPE] }
    );
    const userSessions = await this.getAllSessions(userId);
    for (const session of userSessions) {
      await this.withSessionWriteLease(session.id, userId, async assertHeld => {
        // A generation may have committed after the actor-wide cancellation
        // but before this session lease was acquired. Cancel the exact scope
        // under the same serialization boundary immediately before deletion.
        await getDurableJobRuntime().service.cancelAllForActor(
          userId,
          'superseded',
          {
            jobTypes: [CHAT_GENERATE_JOB_TYPE],
            idempotencyScopes: [chatGenerationIdempotencyScope(session.id)],
          }
        );
        await this.deleteSessionWithLeaseHeld(session.id, userId, assertHeld);
      });
    }
  }

  async getMessagesForContext(
    sessionId: string,
    userId: string,
    maxMessages = 10,
    signal?: AbortSignal
  ): Promise<ChatMessage[]> {
    const session = await this.getSession(sessionId, userId);
    if (!session) return [];

    // Context compaction (admin-configured, default off): summarize older
    // history into a system message so it keeps informing the model instead
    // of silently falling out of the context window. Fails open.
    let messages = session.messages;
    let contextWindow = maxMessages;
    const compactionConfig = await getCompactionConfig();
    if (compactionConfig.enabled) {
      // With compaction on, the admin's keep-recent count is the context
      // window: compaction bounds the active history, so a keep-recent
      // above the default window must not be silently truncated back down.
      contextWindow = Math.max(
        maxMessages,
        compactionConfig.keepRecentMessages
      );
      const plan = await planCompaction(session, userId, {
        config: compactionConfig,
        signal,
      });
      if (plan) {
        try {
          messages = await this.applyContextCompaction(sessionId, userId, plan);
        } catch (error) {
          logger.warn(
            `Applying context compaction failed for session ${sessionId}:`,
            error
          );
        }
      }
    }

    return selectChatMessagesForContext(messages, contextWindow).map(
      sanitizeChatMessageProviderState
    );
  }

  /**
   * Persist a compaction plan under the session write lease: deactivate the
   * summarized messages and insert the summary after the last of them.
   * Returns the updated message list.
   */
  private async applyContextCompaction(
    sessionId: string,
    userId: string,
    plan: CompactionPlan
  ): Promise<ChatMessage[]> {
    return this.withSessionWriteLease(sessionId, userId, async assertHeld => {
      const session = await this.getSession(sessionId, userId);
      if (!session) throw new Error('The session disappeared mid-compaction');

      const deactivate = new Set(plan.deactivateIds);
      // Another replica compacted first: a live summary we did not plan to
      // replace means our plan is stale — keep theirs.
      const foreignSummary = session.messages.some(
        message =>
          message.isActive !== false &&
          message.role === 'system' &&
          message.content.startsWith(COMPACTION_SUMMARY_PREFIX) &&
          !deactivate.has(message.id)
      );
      if (foreignSummary) return session.messages;

      const updated: ChatMessage[] = session.messages.map(message =>
        deactivate.has(message.id) ? { ...message, isActive: false } : message
      );
      let insertAt = 0;
      for (let index = 0; index < session.messages.length; index += 1) {
        if (deactivate.has(session.messages[index].id)) insertAt = index + 1;
      }
      updated.splice(insertAt, 0, plan.summaryMessage);

      const updatedSession = {
        ...session,
        messages: updated,
        updatedAt: Date.now(),
      };
      this.sessions.set(sessionId, updatedSession);
      await storageService.saveSession(updatedSession, userId, assertHeld);
      return updated;
    });
  }

  private async updateSystemMessageForPersona(
    session: ChatSession,
    personaId: string,
    userId: string
  ): Promise<void> {
    try {
      // Get persona for the current user only (no fallback to maintain privacy)
      const persona = await personaService.getPersonaById(personaId, userId);

      if (persona && persona.parameters?.system_prompt) {
        const newSystemMessage = persona.parameters.system_prompt.trim();

        // Update or replace the system message
        this.replaceSystemMessage(session, newSystemMessage);
      } else {
        // Fallback to default system message
        await this.updateSystemMessageToDefault(session, userId);
      }
    } catch (error) {
      logger.error(
        `updateSystemMessageForPersona: Error getting persona %s:`,
        personaId,
        error
      );
      // Fallback to default system message
      await this.updateSystemMessageToDefault(session, userId);
    }
  }

  private async updateSystemMessageToDefault(
    session: ChatSession,
    userId: string
  ): Promise<void> {
    const defaultSystemMessage =
      await preferencesService.getSystemMessage(userId);
    this.replaceSystemMessage(session, defaultSystemMessage);
  }

  private replaceSystemMessage(
    session: ChatSession,
    newSystemMessage: string
  ): void {
    // Find the existing system message — never a compaction summary, which
    // also has role 'system' and may sit first in a session that had no
    // system message of its own.
    const systemMessageIndex = session.messages.findIndex(
      msg =>
        msg.role === 'system' &&
        !msg.content.startsWith(COMPACTION_SUMMARY_PREFIX)
    );

    if (systemMessageIndex !== -1) {
      // Update existing system message
      session.messages[systemMessageIndex] = {
        ...session.messages[systemMessageIndex],
        content: newSystemMessage,
        timestamp: Date.now(),
      };
    } else {
      // Add new system message at the beginning
      const systemMessage: ChatMessage = {
        id: uuidv4(),
        role: 'system',
        content: newSystemMessage,
        timestamp: Date.now(),
      };
      session.messages.unshift(systemMessage);
    }
  }

  /**
   * Process advanced persona interactions: memory storage, retrieval, and mutations
   */
  private async processAdvancedPersonaInteraction(
    personaId: string,
    userId: string,
    userMessage: string,
    session: ChatSession
  ): Promise<void> {
    try {
      // Check if persona has advanced features enabled for current user only (no fallback to maintain privacy)
      const persona = await personaService.getPersonaById(personaId, userId);

      if (!persona) {
        return;
      }

      // Check if this persona has advanced features (memory or adaptive learning)
      const hasAdvancedFeatures =
        persona.embedding_model || persona.memory_settings;

      if (!hasAdvancedFeatures) {
        return;
      }

      // Get advanced settings
      const embeddingModel =
        persona.embedding_model ||
        (await preferencesService.getDefaultEmbeddingModel(userId));

      // 1. Store the user message as a memory
      await memoryService.storeMemory(
        userId,
        personaId,
        userMessage,
        embeddingModel,
        undefined, // context
        0.7 // importance score
      );

      // 2. Search for relevant memories
      const relevantMemories = await memoryService.searchMemories(
        userId,
        personaId,
        userMessage,
        embeddingModel,
        5, // topK
        0.3 // similarity threshold
      );

      // 3. Process potential mutations based on the interaction
      if (relevantMemories.length > 0) {
        await mutationEngineService.processMutation(
          userMessage,
          persona as Persona, // Cast to Persona for mutation engine
          userId,
          relevantMemories
        );
      }

      // 4. Update system message with relevant memories if any found
      if (relevantMemories.length > 0) {
        await this.updateSystemMessageWithMemories(
          session,
          persona as Persona,
          relevantMemories,
          userId
        );
      }
    } catch (error) {
      logger.error(`Error processing persona interaction:`, error);
    }
  }

  /**
   * Update system message to include relevant memories
   */
  private async updateSystemMessageWithMemories(
    session: ChatSession,
    persona: Persona,
    memories: MemorySearchResult[],
    userId: string
  ): Promise<void> {
    try {
      const baseSystemPrompt = persona.parameters?.system_prompt || '';

      // Get core memories (always-include important facts, preferences, instructions)
      const coreMemories = await memoryService.getCoreMemories(
        userId,
        persona.id,
        3
      );

      // Combine core memories with contextual memories, avoiding duplicates
      const coreIds = new Set(coreMemories.map(m => m.id));
      const contextualMemories = memories
        .filter(m => !coreIds.has(m.entry.id))
        .slice(0, 3);

      if (coreMemories.length === 0 && contextualMemories.length === 0) return;

      // Build memory context sections
      let memoryContext = '';

      // Core memories section (always relevant)
      if (coreMemories.length > 0) {
        memoryContext += '=== Core Knowledge ===\n';
        memoryContext += coreMemories
          .map(memory => {
            const type =
              (memory as { memory_type?: string }).memory_type || 'general';
            const typeLabel =
              type === 'fact'
                ? 'Fact'
                : type === 'preference'
                  ? 'Preference'
                  : type === 'instruction'
                    ? 'Instruction'
                    : 'Info';
            return `[${typeLabel}] ${memory.content}`;
          })
          .join('\n');
        memoryContext += '\n\n';
      }

      // Contextual memories section (relevant to current query)
      if (contextualMemories.length > 0) {
        memoryContext += '=== Relevant Context ===\n';
        memoryContext += contextualMemories
          .map(memory => {
            const relevance = (memory.similarity_score * 100).toFixed(0);
            return `[${relevance}% match] ${memory.entry.content}`;
          })
          .join('\n');
      }

      const enhancedSystemPrompt = `${baseSystemPrompt}

[PERSONA MEMORY CONTEXT]
You have access to the following memories from past interactions with this user:

${memoryContext.trim()}

Guidelines:
- Use Core Knowledge naturally in your responses - these are established facts about the user
- Reference Relevant Context when it helps answer the current question
- Don't explicitly mention having "memories" - integrate knowledge seamlessly
- If memories conflict with current information, prioritize the most recent
[END MEMORY CONTEXT]`;

      await this.withSessionWriteLease(session.id, userId, async assertHeld => {
        const authoritative = await this.getSession(session.id, userId);
        if (!authoritative) return;
        const systemMessageIndex = authoritative.messages.findIndex(
          msg =>
            msg.role === 'system' &&
            !msg.content.startsWith(COMPACTION_SUMMARY_PREFIX)
        );
        if (systemMessageIndex !== -1) {
          authoritative.messages[systemMessageIndex] = {
            ...authoritative.messages[systemMessageIndex],
            content: enhancedSystemPrompt,
            timestamp: Date.now(),
          };
        } else {
          authoritative.messages.unshift({
            id: uuidv4(),
            role: 'system',
            content: enhancedSystemPrompt,
            timestamp: Date.now(),
          });
        }
        authoritative.updatedAt = Date.now();
        this.sessions.set(authoritative.id, authoritative);
        await assertHeld();
        await storageService.saveSession(authoritative, userId, assertHeld);
      });
    } catch (error) {
      logger.error(`Error updating system message with memories:`, error);
    }
  }

  /**
   * Process advanced persona response - store AI responses as memories for future reference
   */
  private async processAdvancedPersonaResponse(
    personaId: string,
    userId: string,
    assistantMessage: string
  ): Promise<void> {
    try {
      // Check if persona has advanced features enabled for current user only (no fallback to maintain privacy)
      const persona = await personaService.getPersonaById(personaId, userId);

      if (!persona) {
        return;
      }

      const hasAdvancedFeatures =
        persona.embedding_model || persona.memory_settings;

      if (!hasAdvancedFeatures) {
        return;
      }

      // Get advanced settings
      const embeddingModel =
        persona.embedding_model ||
        (await preferencesService.getDefaultEmbeddingModel(userId));

      // Store the assistant response as a memory for future context
      await memoryService.storeMemory(
        userId,
        personaId,
        `Assistant response: ${assistantMessage}`,
        embeddingModel,
        undefined, // context
        0.6 // slightly lower importance than user messages
      );
    } catch (error) {
      logger.error(`Error processing persona response:`, error);
    }
  }

  /**
   * Create a new branch for a message (used for regeneration)
   * This marks the original message as inactive and creates a new active variant
   */
  async createMessageBranch(
    sessionId: string,
    originalMessageId: string,
    newMessage: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string },
    userId: string = 'default'
  ): Promise<ChatMessage | undefined> {
    return this.withSessionWriteLease(sessionId, userId, assertHeld =>
      this.createMessageBranchWithLeaseHeld(
        sessionId,
        originalMessageId,
        newMessage,
        userId,
        assertHeld
      )
    );
  }

  private async createMessageBranchWithLeaseHeld(
    sessionId: string,
    originalMessageId: string,
    newMessage: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string },
    userId: string,
    assertHeld: () => Promise<void>
  ): Promise<ChatMessage | undefined> {
    const session = await this.getSession(sessionId, userId);
    if (!session) return undefined;

    const originalMessage = session.messages.find(
      msg => msg.id === originalMessageId
    );
    if (!originalMessage) return undefined;

    // The parent is either the original's parent (if it's already a variant) or the original itself
    const parentId = originalMessage.parentId || originalMessageId;

    // Find all siblings to determine the new branch index
    const siblings = session.messages.filter(
      msg => msg.id === parentId || msg.parentId === parentId
    );
    const newBranchIndex = siblings.length;

    // Mark all current siblings as inactive
    for (const sibling of siblings) {
      sibling.isActive = false;
    }

    const messageId = newMessage.id || uuidv4();
    const newBranchMessage = sanitizeChatMessageProviderState<ChatMessage>({
      ...newMessage,
      id: messageId,
      timestamp: Date.now(),
      parentId: parentId,
      branchIndex: newBranchIndex,
      isActive: true,
      siblingCount: newBranchIndex + 1,
    });

    // Update sibling counts for all related messages
    for (const sibling of siblings) {
      sibling.siblingCount = newBranchIndex + 1;
    }

    session.messages.push(newBranchMessage);
    session.updatedAt = Date.now();

    this.sessions.set(sessionId, session);
    await assertHeld();
    await storageService.saveSession(session, userId, assertHeld);

    return newBranchMessage;
  }

  /**
   * Switch to a different branch of a message
   */
  async switchMessageBranch(
    sessionId: string,
    messageId: string,
    targetBranchIndex: number,
    userId: string = 'default'
  ): Promise<ChatMessage | undefined> {
    return this.withSessionWriteLease(sessionId, userId, assertHeld =>
      this.switchMessageBranchWithLeaseHeld(
        sessionId,
        messageId,
        targetBranchIndex,
        userId,
        assertHeld
      )
    );
  }

  private async switchMessageBranchWithLeaseHeld(
    sessionId: string,
    messageId: string,
    targetBranchIndex: number,
    userId: string,
    assertHeld: () => Promise<void>
  ): Promise<ChatMessage | undefined> {
    const session = await this.getSession(sessionId, userId);
    if (!session) return undefined;

    // Find the target message directly by ID
    const targetMessage = session.messages.find(msg => msg.id === messageId);
    if (!targetMessage) return undefined;

    // Find the parent ID (the original message that spawned branches)
    const parentId = targetMessage.parentId || messageId;

    // Find all siblings (including the original parent message)
    const siblings = session.messages.filter(
      msg => msg.id === parentId || msg.parentId === parentId
    );

    // Mark all siblings as inactive, then mark the target as active
    for (const sibling of siblings) {
      sibling.isActive = false;
    }
    targetMessage.isActive = true;

    session.updatedAt = Date.now();
    this.sessions.set(sessionId, session);
    await assertHeld();
    await storageService.saveSession(session, userId, assertHeld);

    return targetMessage;
  }

  /**
   * Get all branches for a message
   */
  async getMessageBranches(
    sessionId: string,
    messageId: string,
    userId: string = 'default'
  ): Promise<ChatMessage[]> {
    const session = await this.getSession(sessionId, userId);
    if (!session) return [];

    const message = session.messages.find(msg => msg.id === messageId);
    if (!message) return [];

    const parentId = message.parentId || messageId;

    // Find all siblings (including the original parent message)
    return session.messages
      .filter(msg => msg.id === parentId || msg.parentId === parentId)
      .sort((a, b) => (a.branchIndex ?? 0) - (b.branchIndex ?? 0));
  }
}

export default new ChatService();
