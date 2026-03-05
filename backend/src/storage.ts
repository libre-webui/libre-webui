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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import { getDatabaseSafe, isDatabaseInitialized } from './db.js';
import type { DatabaseAdapter } from './database/types.js';
import { ChatSession, DocumentChunk, UserPreferences } from './types/index.js';
import { encryptionService } from './services/encryptionService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Document {
  id: string;
  filename: string;
  title?: string;
  content?: string;
  fileType?: 'pdf' | 'txt';
  size?: number;
  sessionId?: string;
  uploadedAt: number;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  model: string;
  persona_id?: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: number;
  message_index: number;
  model?: string;
  images?: string;
  statistics?: string;
  artifacts?: string;
  parent_id?: string;
  branch_index?: number;
  is_active?: number;
}

interface DocumentRow {
  id: string;
  user_id: string;
  filename: string;
  title?: string;
  content?: string;
  file_type?: string;
  size?: number;
  session_id?: string;
  uploaded_at: number;
  created_at?: number;
  metadata?: string;
}

interface DocumentChunkRow {
  id: string;
  document_id: string;
  user_id: string;
  content: string;
  embedding?: string;
  chunk_index: number;
  start_char: number;
  end_char: number;
  metadata?: string;
}

export interface User {
  id: string;
  username: string;
  email?: string;
  password_hash: string;
  role: string;
  avatar?: string | null;
  created_at: number;
  updated_at: number;
}

class StorageService {
  private useDatabase = false;
  private sessionsFile = path.join(__dirname, '..', 'sessions.json');
  private preferencesFile = path.join(__dirname, '..', 'preferences.json');
  private documentsFile = path.join(__dirname, '..', 'documents.json');
  private documentChunksFile = path.join(
    __dirname,
    '..',
    'document-chunks.json'
  );

  constructor() {
    this.useDatabase = isDatabaseInitialized();
    console.log(`Storage mode: ${this.useDatabase ? 'Database' : 'JSON'}`);
  }

  /** Re-check database availability (called after async init). */
  refreshDatabaseStatus(): void {
    this.useDatabase = isDatabaseInitialized();
  }

  private getDb(): DatabaseAdapter | null {
    return getDatabaseSafe();
  }

  // =================================
  // USER MANAGEMENT
  // =================================

  async createUser(
    username: string,
    email: string | undefined,
    password: string,
    role = 'user'
  ): Promise<User> {
    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);
    const now = Date.now();

    const user: User = {
      id: userId,
      username,
      email,
      password_hash: passwordHash,
      role,
      created_at: now,
      updated_at: now,
    };

    const db = this.getDb();
    if (db) {
      const encryptedEmail = user.email
        ? encryptionService.encrypt(user.email)
        : null;

      await db.run(
        `INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        user.id,
        user.username,
        encryptedEmail,
        user.password_hash,
        user.role,
        user.created_at,
        user.updated_at
      );
    }

    return user;
  }

  async getUser(userId: string): Promise<User | undefined> {
    const db = this.getDb();
    if (db) {
      const user = await db.get<User>(
        'SELECT * FROM users WHERE id = ?',
        userId
      );
      if (user && user.email) {
        user.email = encryptionService.decrypt(user.email);
      }
      return user;
    }
    return undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const db = this.getDb();
    if (db) {
      const user = await db.get<User>(
        'SELECT * FROM users WHERE username = ?',
        username
      );
      if (user && user.email) {
        user.email = encryptionService.decrypt(user.email);
      }
      return user;
    }
    return undefined;
  }

  // =================================
  // SESSION MANAGEMENT
  // =================================

  async getAllSessions(userId = 'default'): Promise<ChatSession[]> {
    const db = this.getDb();
    if (db) {
      const sessions = await db.all<SessionRow>(
        'SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC',
        userId
      );

      const result: ChatSession[] = [];
      for (const session of sessions) {
        const messages = await db.all<MessageRow>(
          `SELECT * FROM session_messages
           WHERE session_id = ?
           ORDER BY message_index ASC, branch_index ASC`,
          session.id
        );

        const siblingCounts = await db.all<{
          parent_id: string;
          count: number;
        }>(
          `SELECT parent_id, COUNT(*) as count FROM session_messages
           WHERE session_id = ? AND parent_id IS NOT NULL
           GROUP BY parent_id`,
          session.id
        );

        const siblingCountMap = new Map<string, number>();
        for (const sc of siblingCounts) {
          siblingCountMap.set(sc.parent_id, sc.count + 1);
        }

        const decryptedTitle = encryptionService.decrypt(session.title);

        result.push({
          id: session.id,
          title: decryptedTitle,
          model: session.model,
          personaId: session.persona_id || undefined,
          createdAt: session.created_at,
          updatedAt: session.updated_at,
          messages: messages.map(msg => {
            const decryptedContent = encryptionService.decrypt(msg.content);
            const decryptedImages = msg.images
              ? JSON.parse(encryptionService.decrypt(msg.images))
              : undefined;
            const decryptedStatistics = msg.statistics
              ? JSON.parse(encryptionService.decrypt(msg.statistics))
              : undefined;
            const decryptedArtifacts = msg.artifacts
              ? JSON.parse(encryptionService.decrypt(msg.artifacts))
              : undefined;

            const parentId = msg.parent_id || msg.id;
            const siblingCount = siblingCountMap.get(parentId) || 1;

            return {
              id: msg.id,
              role: msg.role as 'user' | 'assistant' | 'system',
              content: decryptedContent,
              timestamp: msg.timestamp,
              model: msg.model,
              images: decryptedImages,
              statistics: decryptedStatistics,
              artifacts: decryptedArtifacts,
              parentId: msg.parent_id,
              branchIndex: msg.branch_index ?? 0,
              isActive: msg.is_active !== 0,
              siblingCount: siblingCount > 1 ? siblingCount : undefined,
            };
          }),
        });
      }
      return result;
    }

    // Fallback to JSON
    try {
      if (fs.existsSync(this.sessionsFile)) {
        const data = fs.readFileSync(this.sessionsFile, 'utf8');
        return JSON.parse(data) as ChatSession[];
      }
    } catch (error) {
      console.error('Failed to load sessions from JSON:', error);
    }
    return [];
  }

  async getSession(
    sessionId: string,
    userId = 'default'
  ): Promise<ChatSession | undefined> {
    const db = this.getDb();
    if (db) {
      const session = await db.get<SessionRow>(
        'SELECT * FROM sessions WHERE id = ? AND user_id = ?',
        sessionId,
        userId
      );
      if (!session) return undefined;

      const messages = await db.all<MessageRow>(
        `SELECT * FROM session_messages
         WHERE session_id = ?
         ORDER BY message_index ASC, branch_index ASC`,
        sessionId
      );

      const siblingCounts = await db.all<{
        parent_id: string;
        count: number;
      }>(
        `SELECT parent_id, COUNT(*) as count FROM session_messages
         WHERE session_id = ? AND parent_id IS NOT NULL
         GROUP BY parent_id`,
        sessionId
      );

      const siblingCountMap = new Map<string, number>();
      for (const sc of siblingCounts) {
        siblingCountMap.set(sc.parent_id, sc.count + 1);
      }

      const decryptedTitle = encryptionService.decrypt(session.title);

      return {
        id: session.id,
        title: decryptedTitle,
        model: session.model,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        messages: messages.map(msg => {
          const decryptedContent = encryptionService.decrypt(msg.content);
          const decryptedImages = msg.images
            ? JSON.parse(encryptionService.decrypt(msg.images))
            : undefined;
          const decryptedStatistics = msg.statistics
            ? JSON.parse(encryptionService.decrypt(msg.statistics))
            : undefined;
          const decryptedArtifacts = msg.artifacts
            ? JSON.parse(encryptionService.decrypt(msg.artifacts))
            : undefined;

          const parentId = msg.parent_id || msg.id;
          const siblingCount = siblingCountMap.get(parentId) || 1;

          return {
            id: msg.id,
            role: msg.role as 'user' | 'assistant' | 'system',
            content: decryptedContent,
            timestamp: msg.timestamp,
            model: msg.model,
            images: decryptedImages,
            statistics: decryptedStatistics,
            artifacts: decryptedArtifacts,
            parentId: msg.parent_id,
            branchIndex: msg.branch_index ?? 0,
            isActive: msg.is_active !== 0,
            siblingCount: siblingCount > 1 ? siblingCount : undefined,
          };
        }),
      };
    }

    const sessions = await this.getAllSessions();
    return sessions.find(s => s.id === sessionId);
  }

  async saveSession(session: ChatSession, userId = 'default'): Promise<void> {
    const db = this.getDb();
    if (db) {
      await db.transaction(async tx => {
        const encryptedTitle = encryptionService.encrypt(session.title);

        await tx.run(
          `INSERT INTO sessions (id, user_id, title, model, persona_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             user_id = excluded.user_id,
             title = excluded.title,
             model = excluded.model,
             persona_id = excluded.persona_id,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
          session.id,
          userId,
          encryptedTitle,
          session.model,
          session.personaId || null,
          session.createdAt,
          session.updatedAt
        );

        await tx.run(
          'DELETE FROM session_messages WHERE session_id = ?',
          session.id
        );

        if (session.messages && session.messages.length > 0) {
          for (let index = 0; index < session.messages.length; index++) {
            const message = session.messages[index];
            const encryptedContent = encryptionService.encrypt(message.content);
            const encryptedImages = message.images
              ? encryptionService.encrypt(JSON.stringify(message.images))
              : null;
            const encryptedStatistics = message.statistics
              ? encryptionService.encrypt(JSON.stringify(message.statistics))
              : null;
            const encryptedArtifacts = message.artifacts
              ? encryptionService.encrypt(JSON.stringify(message.artifacts))
              : null;
            const messageId = message.id || uuidv4();

            await tx.run(
              `INSERT INTO session_messages
               (id, session_id, role, content, timestamp, message_index, model, images, statistics, artifacts, parent_id, branch_index, is_active)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              messageId,
              session.id,
              message.role,
              encryptedContent,
              message.timestamp,
              index,
              message.model || null,
              encryptedImages,
              encryptedStatistics,
              encryptedArtifacts,
              message.parentId || null,
              message.branchIndex ?? 0,
              message.isActive !== false ? 1 : 0
            );
          }
        }
      });
    } else {
      try {
        const sessions = await this.getAllSessions();
        const existingIndex = sessions.findIndex(s => s.id === session.id);
        if (existingIndex >= 0) {
          sessions[existingIndex] = session;
        } else {
          sessions.push(session);
        }
        fs.writeFileSync(this.sessionsFile, JSON.stringify(sessions, null, 2));
      } catch (error) {
        console.error('Failed to save session to JSON:', error);
      }
    }
  }

  async deleteSession(sessionId: string, userId = 'default'): Promise<boolean> {
    const db = this.getDb();
    if (db) {
      const result = await db.run(
        'DELETE FROM sessions WHERE id = ? AND user_id = ?',
        sessionId,
        userId
      );
      return result.changes > 0;
    }

    try {
      const sessions = await this.getAllSessions();
      const filteredSessions = sessions.filter(s => s.id !== sessionId);
      if (filteredSessions.length !== sessions.length) {
        fs.writeFileSync(
          this.sessionsFile,
          JSON.stringify(filteredSessions, null, 2)
        );
        return true;
      }
    } catch (error) {
      console.error('Failed to delete session from JSON:', error);
    }
    return false;
  }

  async clearAllSessions(userId = 'default'): Promise<number> {
    const db = this.getDb();
    if (db) {
      const result = await db.run(
        'DELETE FROM sessions WHERE user_id = ?',
        userId
      );
      return result.changes;
    }

    try {
      const currentSessions = await this.getAllSessions();
      const deletedCount = currentSessions.length;
      fs.writeFileSync(this.sessionsFile, JSON.stringify([], null, 2));
      return deletedCount;
    } catch (error) {
      console.error('Failed to clear all sessions from JSON:', error);
      return 0;
    }
  }

  // =================================
  // PREFERENCES MANAGEMENT
  // =================================

  private safeDecryptPreference(
    key: string,
    value: string,
    _userId?: string
  ): unknown | null {
    try {
      const decryptedValue = encryptionService.decrypt(value);
      try {
        return JSON.parse(decryptedValue);
      } catch {
        return null;
      }
    } catch {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  }

  private async deleteCorruptedPreference(
    userId: string,
    key: string
  ): Promise<void> {
    const db = this.getDb();
    if (db) {
      await db.run(
        'DELETE FROM user_preferences WHERE user_id = ? AND key = ?',
        userId,
        key
      );
      console.log(`Cleaned up corrupted preference: ${key}`);
    }
  }

  async getPreferences(userId?: string): Promise<UserPreferences | null> {
    const db = this.getDb();
    if (db) {
      if (!userId) {
        const firstUser = await db.get<{ id: string }>(
          'SELECT id FROM users LIMIT 1'
        );
        if (firstUser) {
          userId = firstUser.id;
        } else {
          return null;
        }
      }

      const rows = await db.all<{ key: string; value: string }>(
        'SELECT key, value FROM user_preferences WHERE user_id = ?',
        userId
      );
      if (rows.length === 0) return null;

      const preferences: Record<string, unknown> = {};
      const corruptedKeys: string[] = [];

      rows.forEach(row => {
        const value = this.safeDecryptPreference(row.key, row.value, userId);
        if (value === null) {
          corruptedKeys.push(row.key);
        } else {
          preferences[row.key] = value;
        }
      });

      if (corruptedKeys.length > 0 && userId) {
        for (const key of corruptedKeys) {
          await this.deleteCorruptedPreference(userId, key);
        }
      }

      return Object.keys(preferences).length > 0
        ? (preferences as unknown as UserPreferences)
        : null;
    }

    try {
      if (fs.existsSync(this.preferencesFile)) {
        const data = fs.readFileSync(this.preferencesFile, 'utf8');
        return JSON.parse(data) as UserPreferences;
      }
    } catch (error) {
      console.error('Failed to load preferences from JSON:', error);
    }
    return null;
  }

  async savePreferences(
    preferences: UserPreferences,
    userId?: string
  ): Promise<void> {
    const db = this.getDb();
    if (db) {
      const now = Date.now();

      if (!userId) {
        const firstUser = await db.get<{ id: string }>(
          'SELECT id FROM users LIMIT 1'
        );
        if (firstUser) {
          userId = firstUser.id;
        } else {
          throw new Error('No users found in database');
        }
      }

      const finalUserId = userId;
      await db.transaction(async tx => {
        await tx.run(
          'DELETE FROM user_preferences WHERE user_id = ?',
          finalUserId
        );
        for (const [key, value] of Object.entries(preferences)) {
          if (value === undefined) continue;
          const encryptedValue = encryptionService.encrypt(
            JSON.stringify(value)
          );
          await tx.run(
            `INSERT INTO user_preferences (id, user_id, key, value, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            uuidv4(),
            finalUserId,
            key,
            encryptedValue,
            now,
            now
          );
        }
      });
    } else {
      try {
        fs.writeFileSync(
          this.preferencesFile,
          JSON.stringify(preferences, null, 2)
        );
      } catch (error) {
        console.error('Failed to save preferences to JSON:', error);
      }
    }
  }

  // =================================
  // DOCUMENT MANAGEMENT
  // =================================

  async getAllDocuments(userId = 'default'): Promise<Document[]> {
    const db = this.getDb();
    if (db) {
      const rows = await db.all<DocumentRow>(
        'SELECT * FROM documents WHERE user_id = ? ORDER BY uploaded_at DESC',
        userId
      );
      return rows.map(row => ({
        id: row.id,
        filename: row.filename,
        title: row.title ? encryptionService.decrypt(row.title) : undefined,
        content: row.content
          ? encryptionService.decrypt(row.content)
          : undefined,
        fileType: row.file_type as 'pdf' | 'txt' | undefined,
        size: row.size,
        sessionId: row.session_id,
        uploadedAt: row.uploaded_at,
        createdAt: row.created_at,
        metadata: row.metadata
          ? JSON.parse(encryptionService.decrypt(row.metadata))
          : undefined,
      }));
    }

    try {
      if (fs.existsSync(this.documentsFile)) {
        const data = fs.readFileSync(this.documentsFile, 'utf8');
        return JSON.parse(data) as Document[];
      }
    } catch (error) {
      console.error('Failed to load documents from JSON:', error);
    }
    return [];
  }

  async getDocument(
    documentId: string,
    userId = 'default'
  ): Promise<Document | undefined> {
    const db = this.getDb();
    if (db) {
      const row = await db.get<DocumentRow>(
        'SELECT * FROM documents WHERE id = ? AND user_id = ?',
        documentId,
        userId
      );
      if (!row) return undefined;
      return {
        id: row.id,
        filename: row.filename,
        title: row.title ? encryptionService.decrypt(row.title) : undefined,
        content: row.content
          ? encryptionService.decrypt(row.content)
          : undefined,
        fileType: row.file_type as 'pdf' | 'txt' | undefined,
        size: row.size,
        sessionId: row.session_id,
        uploadedAt: row.uploaded_at,
        createdAt: row.created_at,
        metadata: row.metadata
          ? JSON.parse(encryptionService.decrypt(row.metadata))
          : undefined,
      };
    }

    const documents = await this.getAllDocuments();
    return documents.find(d => d.id === documentId);
  }

  async saveDocument(document: Document, userId = 'default'): Promise<void> {
    const db = this.getDb();
    if (db) {
      const now = Date.now();
      await db.run(
        `INSERT INTO documents
         (id, user_id, filename, title, content, metadata, uploaded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           user_id = excluded.user_id,
           filename = excluded.filename,
           title = excluded.title,
           content = excluded.content,
           metadata = excluded.metadata,
           uploaded_at = excluded.uploaded_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
        document.id,
        userId,
        document.filename,
        document.title ? encryptionService.encrypt(document.title) : null,
        document.content ? encryptionService.encrypt(document.content) : null,
        document.metadata
          ? encryptionService.encrypt(JSON.stringify(document.metadata))
          : null,
        document.uploadedAt,
        document.createdAt || now,
        now
      );
    } else {
      try {
        const documents = await this.getAllDocuments();
        const existingIndex = documents.findIndex(d => d.id === document.id);
        if (existingIndex >= 0) {
          documents[existingIndex] = document;
        } else {
          documents.push(document);
        }
        fs.writeFileSync(
          this.documentsFile,
          JSON.stringify(documents, null, 2)
        );
      } catch (error) {
        console.error('Failed to save document to JSON:', error);
      }
    }
  }

  async deleteDocument(
    documentId: string,
    userId = 'default'
  ): Promise<boolean> {
    const db = this.getDb();
    if (db) {
      const result = await db.run(
        'DELETE FROM documents WHERE id = ? AND user_id = ?',
        documentId,
        userId
      );
      return result.changes > 0;
    }

    try {
      const documents = await this.getAllDocuments();
      const filtered = documents.filter(d => d.id !== documentId);
      if (filtered.length !== documents.length) {
        fs.writeFileSync(this.documentsFile, JSON.stringify(filtered, null, 2));
        return true;
      }
    } catch (error) {
      console.error('Failed to delete document from JSON:', error);
    }
    return false;
  }

  // =================================
  // DOCUMENT CHUNKS MANAGEMENT
  // =================================

  async getDocumentChunks(documentId: string): Promise<DocumentChunk[]> {
    const db = this.getDb();
    if (db) {
      const rows = await db.all<DocumentChunkRow>(
        'SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC',
        documentId
      );
      return rows.map(row => ({
        id: row.id,
        documentId: row.document_id,
        content: encryptionService.decrypt(row.content),
        embedding: row.embedding
          ? JSON.parse(encryptionService.decrypt(row.embedding))
          : undefined,
        chunkIndex: row.chunk_index,
        startChar: row.start_char,
        endChar: row.end_char,
        metadata: row.metadata
          ? JSON.parse(encryptionService.decrypt(row.metadata))
          : undefined,
      }));
    }

    try {
      if (fs.existsSync(this.documentChunksFile)) {
        const data = fs.readFileSync(this.documentChunksFile, 'utf8');
        const chunksData = JSON.parse(data);
        return chunksData[documentId] || [];
      }
    } catch (error) {
      console.error('Failed to load document chunks from JSON:', error);
    }
    return [];
  }

  async saveDocumentChunks(
    documentId: string,
    chunks: DocumentChunk[]
  ): Promise<void> {
    const db = this.getDb();
    if (db) {
      const now = Date.now();
      await db.transaction(async tx => {
        await tx.run(
          'DELETE FROM document_chunks WHERE document_id = ?',
          documentId
        );
        for (const chunk of chunks) {
          await tx.run(
            `INSERT INTO document_chunks
             (id, document_id, chunk_index, content, start_char, end_char, embedding, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            chunk.id,
            documentId,
            chunk.chunkIndex,
            encryptionService.encrypt(chunk.content),
            chunk.startChar || null,
            chunk.endChar || null,
            chunk.embedding
              ? encryptionService.encrypt(JSON.stringify(chunk.embedding))
              : null,
            now
          );
        }
      });
    } else {
      try {
        let chunksData: Record<string, DocumentChunk[]> = {};
        if (fs.existsSync(this.documentChunksFile)) {
          const data = fs.readFileSync(this.documentChunksFile, 'utf8');
          chunksData = JSON.parse(data);
        }
        chunksData[documentId] = chunks;
        fs.writeFileSync(
          this.documentChunksFile,
          JSON.stringify(chunksData, null, 2)
        );
      } catch (error) {
        console.error('Failed to save document chunks to JSON:', error);
      }
    }
  }

  async deleteDocumentChunks(documentId: string): Promise<boolean> {
    const db = this.getDb();
    if (db) {
      const result = await db.run(
        'DELETE FROM document_chunks WHERE document_id = ?',
        documentId
      );
      return result.changes > 0;
    }

    try {
      if (fs.existsSync(this.documentChunksFile)) {
        const data = fs.readFileSync(this.documentChunksFile, 'utf8');
        const chunksData = JSON.parse(data);
        if (chunksData[documentId]) {
          delete chunksData[documentId];
          fs.writeFileSync(
            this.documentChunksFile,
            JSON.stringify(chunksData, null, 2)
          );
          return true;
        }
      }
    } catch (error) {
      console.error('Failed to delete document chunks from JSON:', error);
    }
    return false;
  }
}

const storageService = new StorageService();
export default storageService;
