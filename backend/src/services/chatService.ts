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
  Persona,
  MemorySearchResult,
} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import storageService from '../storage.js';
import preferencesService from './preferencesService.js';
import { personaService } from './personaService.js';
import { memoryService } from './memoryService.js';
import { mutationEngineService } from './mutationEngineService.js';
// Encryption service imported for future use
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { encryptionService } from './encryptionService.js';

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
      console.log(`Loaded ${sessionsArray.length} sessions from storage`);
    } catch (error) {
      console.error('Failed to load sessions:', error);
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
    personaId?: string
  ): Promise<ChatSession> {
    const sessionId = uuidv4();
    const now = Date.now();
    console.log(
      `🚀 ChatService.createSession: sessionId=%s, userId=%s, model=%s, personaId=%s`,
      sessionId,
      userId,
      model,
      personaId
    );

    const session: ChatSession = {
      id: sessionId,
      title: title || 'New Chat',
      messages: [],
      model,
      createdAt: now,
      updatedAt: now,
      personaId,
    };

    // Add system message - prioritize persona system prompt over global preferences
    let systemMessage = '';
    let systemMessageSource = 'none';

    console.log(
      `[DEBUG] createSession model: "${model}", starts with persona: ${model.startsWith('persona:')}`
    );

    // If model is a persona, try to get the persona's system prompt
    if (model.startsWith('persona:')) {
      try {
        const personaIdFromModel = model.replace('persona:', '');
        console.log(
          `[DEBUG] Extracting persona ID: "%s" for user: "%s"`,
          personaIdFromModel,
          userId
        );
        const { personaService } = await import('./personaService.js');

        // Try to get persona for the current user first, then fallback to 'default'
        let persona = await personaService.getPersonaById(
          personaIdFromModel,
          userId
        );
        console.log(
          `[DEBUG] Persona lookup for user ${userId}:`,
          persona ? `Found: ${persona.name}` : 'Not found'
        );

        if (!persona && userId !== 'default') {
          console.log(
            `[DEBUG] Trying fallback to default user for persona %s`,
            personaIdFromModel
          );
          persona = await personaService.getPersonaById(
            personaIdFromModel,
            'default'
          );
          console.log(
            `[DEBUG] Persona lookup for default user:`,
            persona ? `Found: ${persona.name}` : 'Not found'
          );
        }

        if (persona && persona.parameters?.system_prompt) {
          systemMessage = persona.parameters.system_prompt.trim();
          systemMessageSource = `persona:${persona.name}`;
          console.log(
            `[DEBUG] Using persona system prompt from ${persona.name}: "${systemMessage.substring(0, 100)}..."`
          );
        } else {
          console.log(
            `[DEBUG] No system prompt found in persona or persona not found`
          );
        }
      } catch (error) {
        console.error(`❌ Error getting persona system prompt:`, error);
      }
    }

    // If no persona system prompt, fall back to global preferences
    if (!systemMessage) {
      const globalSystemMessage = preferencesService.getSystemMessage(userId);
      if (globalSystemMessage && globalSystemMessage.trim()) {
        systemMessage = globalSystemMessage.trim();
        systemMessageSource = 'preferences';
        console.log(
          `[DEBUG] Using global system message: "${systemMessage.substring(0, 100)}..."`
        );
      }
    }

    // Add the system message if we have one
    if (systemMessage) {
      console.log(
        `✅ Adding system message to session: ${sessionId} (source: ${systemMessageSource})`
      );
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
    console.log(`📝 Session stored in cache: ${sessionId}`);

    // Save to storage with user ID
    storageService.saveSession(session, userId);
    console.log(`💾 Session saved to storage: ${sessionId} for user ${userId}`);
    return session;
  }

  getSession(
    sessionId: string,
    userId: string = 'default'
  ): ChatSession | undefined {
    console.log(
      `🔍 ChatService.getSession: sessionId=${sessionId}, userId=${userId}`
    );

    // First try to get from memory cache
    let session = this.sessions.get(sessionId);
    console.log(`📝 Session in cache: ${session ? 'YES' : 'NO'}`);

    // If not in cache, try to load from storage (with user verification)
    if (!session) {
      session = storageService.getSession(sessionId, userId);
      console.log(`💾 Session in storage: ${session ? 'YES' : 'NO'}`);
      if (session) {
        this.sessions.set(sessionId, session);
      }
    } else {
      // If found in cache, we should still verify it belongs to this user
      // by checking the storage service (which has the user verification logic)
      const verifiedSession = storageService.getSession(sessionId, userId);
      console.log(
        `✅ Session verification: ${verifiedSession ? 'PASSED' : 'FAILED'}`
      );
      if (!verifiedSession) {
        // Session doesn't belong to this user, remove from cache and return undefined
        console.log(
          `❌ Removing session ${sessionId} from cache - verification failed`
        );
        this.sessions.delete(sessionId);
        return undefined;
      }
    }

    console.log(`🎯 Returning session: ${session ? session.id : 'undefined'}`);
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

    const updatedSession = {
      ...session,
      ...updates,
      updatedAt: Date.now(),
    };

    // If the model is being updated and it's a persona, update the system message and personaId
    if (updates.model && updates.model !== session.model) {
      console.log(
        `[DEBUG] updateSession: Model changed from "${session.model}" to "${updates.model}"`
      );

      if (updates.model.startsWith('persona:')) {
        const personaId = updates.model.replace('persona:', '');
        console.log(
          `[DEBUG] updateSession: Extracting persona ID: %s`,
          personaId
        );

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
    if (!session) return undefined;

    const messageId = message.id || uuidv4();

    // Check if message with this ID already exists to prevent duplicates
    const existingMessage = session.messages.find(msg => msg.id === messageId);
    if (existingMessage) {
      console.log(
        'Message with ID already exists, skipping duplicate:',
        messageId
      );
      return existingMessage;
    }

    const newMessage: ChatMessage = {
      ...message,
      id: messageId,
      timestamp: Date.now(),
    };

    session.messages.push(newMessage);
    session.updatedAt = Date.now();

    // Process advanced persona features if applicable
    console.log(
      `[DEBUG] addMessage: Checking advanced processing - personaId: ${session.personaId}, messageRole: ${message.role}, content length: ${message.content.length}`
    );
    if (session.personaId) {
      console.log(
        `[DEBUG] addMessage: PersonaId exists, processing message role: ${message.role}`
      );
      if (message.role === 'user') {
        console.log(
          `[DEBUG] addMessage: Starting advanced user interaction processing for persona ${session.personaId}`
        );
        this.processAdvancedPersonaInteraction(
          session.personaId,
          userId,
          message.content,
          session
        ).catch((error: unknown) =>
          console.error('Advanced persona processing error:', error)
        );
      } else if (message.role === 'assistant') {
        console.log(
          `[DEBUG] addMessage: Starting advanced assistant response processing for persona ${session.personaId}`
        );
        this.processAdvancedPersonaResponse(
          session.personaId,
          userId,
          message.content
        ).catch((error: unknown) =>
          console.error('Advanced persona response processing error:', error)
        );
      }
    } else {
      console.log(
        `[DEBUG] addMessage: No personaId found, skipping advanced processing`
      );
    }

    // Auto-generate title from first user message
    const userMessages = session.messages.filter(msg => msg.role === 'user');
    if (
      userMessages.length === 1 &&
      message.role === 'user' &&
      session.title === 'New Chat'
    ) {
      session.title = this.generateTitle(message.content);
    }

    this.sessions.set(sessionId, session);
    storageService.saveSession(session, userId);
    return newMessage;
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

  private generateTitle(content: string): string {
    // Generate a concise title from the first message
    const words = content.trim().split(/\s+/).slice(0, 6);
    let title = words.join(' ');

    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    return title || 'New Chat';
  }

  getMessagesForContext(sessionId: string, maxMessages = 10): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    // Separate system messages from conversation messages
    const systemMessages = session.messages.filter(
      msg => msg.role === 'system'
    );
    const conversationMessages = session.messages.filter(
      msg => msg.role !== 'system'
    );

    // Take the last N conversation messages, but always include all system messages first
    const recentConversation = conversationMessages.slice(-maxMessages);

    // Return system messages first, then conversation messages
    return [...systemMessages, ...recentConversation];
  }

  private async updateSystemMessageForPersona(
    session: ChatSession,
    personaId: string,
    userId: string
  ): Promise<void> {
    try {
      console.log(
        `[DEBUG] updateSystemMessageForPersona: Starting for persona %s, user %s`,
        personaId,
        userId
      );

      // Try to get persona for the current user first, then fallback to 'default'
      let persona = await personaService.getPersonaById(personaId, userId);
      if (!persona && userId !== 'default') {
        console.log(
          `[DEBUG] updateSystemMessageForPersona: Persona not found for user ${userId}, trying default user`
        );
        persona = await personaService.getPersonaById(personaId, 'default');
      }

      if (persona && persona.parameters?.system_prompt) {
        const newSystemMessage = persona.parameters.system_prompt.trim();
        console.log(
          `[DEBUG] updateSystemMessageForPersona: Found persona system prompt: "${newSystemMessage.substring(0, 100)}..."`
        );

        // Update or replace the system message
        this.replaceSystemMessage(session, newSystemMessage);
        console.log(
          `[DEBUG] updateSystemMessageForPersona: Successfully updated system message for session ${session.id}`
        );
      } else {
        console.log(
          `[DEBUG] updateSystemMessageForPersona: No system prompt found for persona %s, using default`,
          personaId
        );
        // Fallback to default system message
        this.updateSystemMessageToDefault(session, userId);
      }
    } catch (error) {
      console.error(
        `[ERROR] updateSystemMessageForPersona: Error getting persona %s:`,
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
    console.log(
      `[DEBUG] updateSystemMessageToDefault: Using default system message: "${defaultSystemMessage.substring(0, 100)}..."`
    );
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
      console.log(
        `[DEBUG] replaceSystemMessage: Updated existing system message`
      );
    } else {
      // Add new system message at the beginning
      const systemMessage: ChatMessage = {
        id: uuidv4(),
        role: 'system',
        content: newSystemMessage,
        timestamp: Date.now(),
      };
      session.messages.unshift(systemMessage);
      console.log(`[DEBUG] replaceSystemMessage: Added new system message`);
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
      console.log(
        `[ADVANCED-DEBUG] processAdvancedPersonaInteraction called - personaId: ${personaId}, userId: ${userId}`
      );

      // Check if persona has advanced features enabled - try current user first, then fallback to 'default'
      let persona = await personaService.getPersonaById(personaId, userId);
      console.log(
        `[ADVANCED-DEBUG] Persona lookup for user ${userId}:`,
        persona ? `Found: ${persona.name}` : 'Not found'
      );

      if (!persona && userId !== 'default') {
        console.log(
          `[ADVANCED-DEBUG] Trying fallback to default user for persona ${personaId}`
        );
        persona = await personaService.getPersonaById(personaId, 'default');
        console.log(
          `[ADVANCED-DEBUG] Persona lookup for default user:`,
          persona ? `Found: ${persona.name}` : 'Not found'
        );
      }

      if (!persona) {
        console.log(
          `[ADVANCED-DEBUG] No persona found in either user or default, exiting`
        );
        return;
      }

      // Check if this persona has advanced features (memory or adaptive learning)
      const hasAdvancedFeatures =
        persona.embedding_model || persona.memory_settings;

      console.log(`[ADVANCED-DEBUG] Advanced features check:`, {
        embedding_model: persona.embedding_model,
        memory_settings: persona.memory_settings,
        hasAdvancedFeatures,
      });

      if (!hasAdvancedFeatures) {
        console.log(`[ADVANCED-DEBUG] No advanced features, exiting`);
        return;
      }

      console.log(
        `[ADVANCED] Processing interaction for persona ${persona.name} (${personaId})`
      );

      // Get advanced settings
      const embeddingModel = persona.embedding_model || 'nomic-embed-text';

      console.log(`[ADVANCED] Using embedding model: ${embeddingModel}`);
      console.log(`[ADVANCED] Advanced features enabled`);

      // 1. Store the user message as a memory
      console.log(`[ADVANCED] Storing user message as memory...`);
      await memoryService.storeMemory(
        userId,
        personaId,
        userMessage,
        embeddingModel,
        undefined, // context
        0.7 // importance score
      );
      console.log(`[ADVANCED] ✅ User message stored successfully`);

      // 2. Search for relevant memories
      console.log(`[ADVANCED] Searching for relevant memories...`);
      const relevantMemories = await memoryService.searchMemories(
        userId,
        personaId,
        userMessage,
        embeddingModel,
        5, // topK
        0.3 // similarity threshold
      );

      console.log(
        `[ADVANCED] Found ${relevantMemories.length} relevant memories`
      );
      if (relevantMemories.length > 0) {
        console.log(
          `[ADVANCED] Memory details:`,
          relevantMemories.map(m => ({
            content: m.entry.content.substring(0, 100) + '...',
            similarity: (m.similarity_score * 100).toFixed(1) + '%',
          }))
        );
      }

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
      console.error(`[ADVANCED] Error processing persona interaction:`, error);
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

      if (memories.length === 0) return;

      // Build memory context
      const memoryContext = memories
        .slice(0, 3) // Use top 3 most relevant memories
        .map(
          (memory, index) =>
            `Memory ${index + 1} (relevance: ${(memory.similarity_score * 100).toFixed(1)}%): ${memory.entry.content}`
        )
        .join('\n');

      const enhancedSystemPrompt = `${baseSystemPrompt}

[PERSONA MEMORY CONTEXT]
You have access to the following relevant memories from past interactions with this user:

${memoryContext}

Use these memories to provide more personalized and contextually aware responses. Reference these memories naturally when relevant to the conversation.
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

      console.log(
        `[ADVANCED] Updated system message with ${memories.length} memories`
      );
    } catch (error) {
      console.error(
        `[ADVANCED] Error updating system message with memories:`,
        error
      );
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
      console.log(
        `[ADVANCED-DEBUG] processAdvancedPersonaResponse called - personaId: ${personaId}, userId: ${userId}`
      );

      // Check if persona has advanced features enabled - try current user first, then fallback to 'default'
      let persona = await personaService.getPersonaById(personaId, userId);
      console.log(
        `[ADVANCED-DEBUG] Persona lookup for user ${userId}:`,
        persona ? `Found: ${persona.name}` : 'Not found'
      );

      if (!persona && userId !== 'default') {
        console.log(
          `[ADVANCED-DEBUG] Trying fallback to default user for persona ${personaId}`
        );
        persona = await personaService.getPersonaById(personaId, 'default');
        console.log(
          `[ADVANCED-DEBUG] Persona lookup for default user:`,
          persona ? `Found: ${persona.name}` : 'Not found'
        );
      }

      if (!persona) {
        console.log(
          `[ADVANCED-DEBUG] No persona found in either user or default, exiting`
        );
        return;
      }

      const hasAdvancedFeatures =
        persona.embedding_model || persona.memory_settings;

      console.log(`[ADVANCED-DEBUG] Advanced detection check:`, {
        embedding_model: persona.embedding_model,
        memory_settings: persona.memory_settings,
        hasAdvancedFeatures,
      });

      if (!hasAdvancedFeatures) {
        console.log(`[ADVANCED-DEBUG] Not an advanced persona, exiting`);
        return;
      }

      console.log(
        `[ADVANCED] Storing assistant response as memory for persona ${persona.name}`
      );

      // Get advanced settings
      const embeddingModel = persona.embedding_model || 'nomic-embed-text';

      // Store the assistant response as a memory for future context
      await memoryService.storeMemory(
        userId,
        personaId,
        `Assistant response: ${assistantMessage}`,
        embeddingModel,
        undefined, // context
        0.6 // slightly lower importance than user messages
      );

      console.log(`[ADVANCED] ✅ Assistant response stored successfully`);
    } catch (error) {
      console.error(`[ADVANCED] Error processing persona response:`, error);
    }
  }
}

export default new ChatService();
