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

const logger = createLogger('chat-service');

class ChatService {
  private sessions: Map<string, ChatSession> = new Map();

  constructor() {
    this.loadSessions();
  }

  private loadSessions() {
    try {
      const sessionsArray = storageService.getAllSessions();
      this.sessions = new Map(
        sessionsArray.map(session => [session.id, session])
      );
      logger.debug(`Loaded ${sessionsArray.length} sessions from storage`);
    } catch (error) {
      logger.error('Failed to load sessions:', error);
    }
  }

  private saveSessions() {
    // This method is kept for compatibility but individual session saving is now handled by storage service
    // The storage service handles both SQLite and JSON fallback
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
      const globalSystemMessage = preferencesService.getSystemMessage(userId);
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
    storageService.saveSession(session, userId);
    return session;
  }

  getSession(
    sessionId: string,
    userId: string = 'default'
  ): ChatSession | undefined {
    // First try to get from memory cache
    let session = this.sessions.get(sessionId);

    // If not in cache, try to load from storage (with user verification)
    if (!session) {
      session = storageService.getSession(sessionId, userId);
      if (session) {
        this.sessions.set(sessionId, session);
      }
    } else {
      // If found in cache, we should still verify it belongs to this user
      // by checking the storage service (which has the user verification logic)
      const verifiedSession = storageService.getSession(sessionId, userId);
      if (!verifiedSession) {
        // Session doesn't belong to this user, remove from cache and return undefined
        this.sessions.delete(sessionId);
        return undefined;
      }
    }

    return session;
  }

  getAllSessions(userId: string = 'default'): ChatSession[] {
    // Load fresh data from storage to ensure we have the latest
    const sessionsArray = storageService.getAllSessions(userId);

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
    // First verify the session belongs to the user
    const session = this.getSession(sessionId, userId);
    if (!session) return undefined;

    const sanitizedUpdates =
      updates.messages === undefined
        ? updates
        : {
            ...updates,
            messages: updates.messages.map(sanitizeChatMessageProviderState),
          };
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
        this.updateSystemMessageToDefault(updatedSession, userId);
      }
    }

    this.sessions.set(sessionId, updatedSession);
    storageService.saveSession(updatedSession, userId);
    return updatedSession;
  }

  addMessage(
    sessionId: string,
    message: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string },
    userId: string = 'default'
  ): ChatMessage | undefined {
    // First verify the session belongs to the user
    const session = this.getSession(sessionId, userId);
    if (!session) {
      return undefined;
    }

    const messageId = message.id || uuidv4();

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

    // If this is a branch message (has parentId), update sibling messages
    if (newMessage.parentId) {
      const parentId = newMessage.parentId;

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

    // Process advanced persona features if applicable
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

    this.sessions.set(sessionId, session);
    storageService.saveSession(session, userId);
    return newMessage;
  }

  updateMessage(
    sessionId: string,
    messageId: string,
    updates: Partial<ChatMessage>,
    userId: string = 'default'
  ): ChatMessage | undefined {
    // First verify the session belongs to the user
    const session = this.getSession(sessionId, userId);
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
    storageService.saveSession(session, userId);

    return updatedMessage;
  }

  deleteSession(sessionId: string, userId: string = 'default'): boolean {
    // First verify the session belongs to the user
    const session = this.getSession(sessionId, userId);
    if (!session) return false;

    const deleted = storageService.deleteSession(sessionId, userId);
    if (deleted) {
      this.sessions.delete(sessionId);
    }
    return deleted;
  }

  getSessionFolders(userId: string = 'default'): SessionFolder[] {
    return storageService.getSessionFolders(userId);
  }

  createSessionFolder(name: string, userId: string = 'default'): SessionFolder {
    const now = Date.now();
    const folder: SessionFolder = {
      id: uuidv4(),
      name: name.trim(),
      createdAt: now,
      updatedAt: now,
    };
    storageService.saveSessionFolder(folder, userId);
    return folder;
  }

  renameSessionFolder(
    folderId: string,
    name: string,
    userId: string = 'default'
  ): SessionFolder | undefined {
    const folder = storageService
      .getSessionFolders(userId)
      .find(item => item.id === folderId);
    if (!folder) return undefined;
    const updated = { ...folder, name: name.trim(), updatedAt: Date.now() };
    storageService.saveSessionFolder(updated, userId);
    return updated;
  }

  deleteSessionFolder(folderId: string, userId: string = 'default'): boolean {
    const deleted = storageService.deleteSessionFolder(folderId, userId);
    if (deleted) {
      // Keep the in-memory cache consistent with the cleared folder links.
      for (const session of this.getAllSessions(userId)) {
        if (session.folderId === folderId) {
          this.sessions.set(session.id, { ...session, folderId: undefined });
        }
      }
    }
    return deleted;
  }

  clearAllSessions(userId: string = 'default'): void {
    // Get all sessions for the user first
    const userSessions = this.getAllSessions(userId);

    // Remove them from memory cache
    userSessions.forEach(session => {
      this.sessions.delete(session.id);
    });

    // Clear them from storage
    userSessions.forEach(session => {
      storageService.deleteSession(session.id, userId);
    });
  }

  getMessagesForContext(sessionId: string, maxMessages = 10): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return selectChatMessagesForContext(session.messages, maxMessages).map(
      sanitizeChatMessageProviderState
    );
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
        this.updateSystemMessageToDefault(session, userId);
      }
    } catch (error) {
      logger.error(
        `updateSystemMessageForPersona: Error getting persona %s:`,
        personaId,
        error
      );
      // Fallback to default system message
      this.updateSystemMessageToDefault(session, userId);
    }
  }

  private updateSystemMessageToDefault(
    session: ChatSession,
    userId: string
  ): void {
    const defaultSystemMessage = preferencesService.getSystemMessage(userId);
    this.replaceSystemMessage(session, defaultSystemMessage);
  }

  private replaceSystemMessage(
    session: ChatSession,
    newSystemMessage: string
  ): void {
    // Find existing system message
    const systemMessageIndex = session.messages.findIndex(
      msg => msg.role === 'system'
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
        preferencesService.getDefaultEmbeddingModel(userId);

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

      // Update the system message
      const systemMessageIndex = session.messages.findIndex(
        msg => msg.role === 'system'
      );

      if (systemMessageIndex !== -1) {
        session.messages[systemMessageIndex] = {
          ...session.messages[systemMessageIndex],
          content: enhancedSystemPrompt,
          timestamp: Date.now(),
        };
      } else {
        // Add new system message
        const systemMessage: ChatMessage = {
          id: uuidv4(),
          role: 'system',
          content: enhancedSystemPrompt,
          timestamp: Date.now(),
        };
        session.messages.unshift(systemMessage);
      }

      // Save the updated session
      this.sessions.set(session.id, session);
      storageService.saveSession(session, userId);
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
        preferencesService.getDefaultEmbeddingModel(userId);

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
  createMessageBranch(
    sessionId: string,
    originalMessageId: string,
    newMessage: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string },
    userId: string = 'default'
  ): ChatMessage | undefined {
    const session = this.getSession(sessionId, userId);
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
    storageService.saveSession(session, userId);

    return newBranchMessage;
  }

  /**
   * Switch to a different branch of a message
   */
  switchMessageBranch(
    sessionId: string,
    messageId: string,
    targetBranchIndex: number,
    userId: string = 'default'
  ): ChatMessage | undefined {
    const session = this.getSession(sessionId, userId);
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
    storageService.saveSession(session, userId);

    return targetMessage;
  }

  /**
   * Get all branches for a message
   */
  getMessageBranches(
    sessionId: string,
    messageId: string,
    userId: string = 'default'
  ): ChatMessage[] {
    const session = this.getSession(sessionId, userId);
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
