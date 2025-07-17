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
import getDatabase, { isDatabaseInitialized } from './db.js';
import { ChatSession, DocumentChunk, UserPreferences } from './types/index.js';
import { encryptionService } from './services/encryptionService.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Extended Document interface for SQLite storage
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

// Database row interfaces
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
  created_at: number;
  updated_at: number;
}

class StorageService {
  private useSQLite = false;
  private sessionsFile = path.join(__dirname, '..', 'sessions.json');
  private preferencesFile = path.join(__dirname, '..', 'preferences.json');
  private documentsFile = path.join(__dirname, '..', 'documents.json');
  private documentChunksFile = path.join(
    __dirname,
    '..',
    'document-chunks.json'
  );

  constructor() {
    // Check if SQLite should be used
    this.useSQLite = isDatabaseInitialized();
    console.log(`Storage mode: ${this.useSQLite ? 'SQLite' : 'JSON'}`);
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

    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare(`
        INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      // Encrypt sensitive user data
      const encryptedEmail = user.email
        ? encryptionService.encrypt(user.email)
        : null;

      stmt.run(
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

  getUser(userId: string): User | undefined {
    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
      const user = stmt.get(userId) as User | undefined;

      if (user && user.email) {
        // Decrypt email
        user.email = encryptionService.decrypt(user.email);
      }

      return user;
    }
    return undefined;
  }

  getUserByUsername(username: string): User | undefined {
    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
      const user = stmt.get(username) as User | undefined;

      if (user && user.email) {
        // Decrypt email
        user.email = encryptionService.decrypt(user.email);
      }

      return user;
    }
    return undefined;
  }

  // =================================
  // SESSION MANAGEMENT
  // =================================

  getAllSessions(userId = 'default'): ChatSession[] {
    if (this.useSQLite) {
      const db = getDatabase();

      // Get sessions
      const sessionsStmt = db.prepare(`
        SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC
      `);
      const sessions = sessionsStmt.all(userId) as SessionRow[];

      // Get messages for each session
      const messagesStmt = db.prepare(`
        SELECT * FROM session_messages WHERE session_id = ? ORDER BY message_index ASC
      `);

      return sessions.map(session => {
        const messages = messagesStmt.all(session.id) as MessageRow[];

        // Decrypt session data
        const decryptedTitle = encryptionService.decrypt(session.title);

        return {
          id: session.id,
          title: decryptedTitle,
          model: session.model,
          personaId: session.persona_id || undefined,
          createdAt: session.created_at,
          updatedAt: session.updated_at,
          messages: messages.map(msg => {
            // Decrypt message data
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

            return {
              id: msg.id,
              role: msg.role as 'user' | 'assistant' | 'system',
              content: decryptedContent,
              timestamp: msg.timestamp,
              model: msg.model,
              images: decryptedImages,
              statistics: decryptedStatistics,
              artifacts: decryptedArtifacts,
            };
          }),
        };
      });
    } else {
      // Fallback to JSON
      try {
        if (fs.existsSync(this.sessionsFile)) {
          const data = fs.readFileSync(this.sessionsFile, 'utf8');
          return JSON.parse(data) as ChatSession[];
        }
      } catch (error) {
        console.error('Failed to load sessions from JSON:', error);
      }
    }

    return [];
  }

  getSession(sessionId: string, userId = 'default'): ChatSession | undefined {
    if (this.useSQLite) {
      const db = getDatabase();

      // Get session
      const sessionStmt = db.prepare(`
        SELECT * FROM sessions WHERE id = ? AND user_id = ?
      `);
      const session = sessionStmt.get(sessionId, userId) as
        | SessionRow
        | undefined;

      if (!session) return undefined;

      // Get messages
      const messagesStmt = db.prepare(`
        SELECT * FROM session_messages WHERE session_id = ? ORDER BY message_index ASC
      `);
      const messages = messagesStmt.all(sessionId) as MessageRow[];

      // Decrypt session data
      const decryptedTitle = encryptionService.decrypt(session.title);

      return {
        id: session.id,
        title: decryptedTitle,
        model: session.model,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        messages: messages.map(msg => {
          // Decrypt message data
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

          return {
            id: msg.id,
            role: msg.role as 'user' | 'assistant' | 'system',
            content: decryptedContent,
            timestamp: msg.timestamp,
            model: msg.model,
            images: decryptedImages,
            statistics: decryptedStatistics,
            artifacts: decryptedArtifacts,
          };
        }),
      };
    } else {
      // Fallback to JSON
      const sessions = this.getAllSessions();
      return sessions.find(s => s.id === sessionId);
    }
  }

  saveSession(session: ChatSession, userId = 'default'): void {
    if (this.useSQLite) {
      const db = getDatabase();

      // Use transaction for consistency
      const transaction = db.transaction((session: ChatSession) => {
        // Insert or update session
        const sessionStmt = db.prepare(`
          INSERT OR REPLACE INTO sessions (id, user_id, title, model, persona_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        // Encrypt sensitive session data
        const encryptedTitle = encryptionService.encrypt(session.title);

        sessionStmt.run(
          session.id,
          userId,
          encryptedTitle,
          session.model,
          session.personaId || null,
          session.createdAt,
          session.updatedAt
        );

        // Delete existing messages
        const deleteMessagesStmt = db.prepare(
          'DELETE FROM session_messages WHERE session_id = ?'
        );
        deleteMessagesStmt.run(session.id);

        // Insert messages
        if (session.messages && session.messages.length > 0) {
          const insertMessageStmt = db.prepare(`
            INSERT INTO session_messages (id, session_id, role, content, timestamp, message_index, model, images, statistics, artifacts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          session.messages.forEach((message, index) => {
            // Encrypt sensitive data before storing
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

            insertMessageStmt.run(
              uuidv4(),
              session.id,
              message.role,
              encryptedContent,
              message.timestamp,
              index,
              message.model || null,
              encryptedImages,
              encryptedStatistics,
              encryptedArtifacts
            );
          });
        }
      });

      transaction(session);
    } else {
      // Fallback to JSON
      try {
        const sessions = this.getAllSessions();
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

  deleteSession(sessionId: string, userId = 'default'): boolean {
    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare(
        'DELETE FROM sessions WHERE id = ? AND user_id = ?'
      );
      const result = stmt.run(sessionId, userId);
      return result.changes > 0;
    } else {
      // Fallback to JSON
      try {
        const sessions = this.getAllSessions();
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
    }

    return false;
  }

  clearAllSessions(userId = 'default'): number {
    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
      const result = stmt.run(userId);
      return result.changes;
    } else {
      // Fallback to JSON
      try {
        const currentSessions = this.getAllSessions();
        const deletedCount = currentSessions.length;
        fs.writeFileSync(this.sessionsFile, JSON.stringify([], null, 2));
        return deletedCount;
      } catch (error) {
        console.error('Failed to clear all sessions from JSON:', error);
        return 0;
      }
    }
  }

  // =================================
  // PREFERENCES MANAGEMENT
  // =================================

  getPreferences(userId?: string): UserPreferences | null {
    if (this.useSQLite) {
      const db = getDatabase();

      // If no userId provided, get the first user (single-user mode)
      if (!userId) {
        const firstUser = db.prepare('SELECT id FROM users LIMIT 1').get() as
          | { id: string }
          | undefined;
        if (firstUser) {
          userId = firstUser.id;
        } else {
          return null; // No users found, return null
        }
      }

      const stmt = db.prepare(
        'SELECT key, value FROM user_preferences WHERE user_id = ?'
      );
      const rows = stmt.all(userId) as { key: string; value: string }[];

      if (rows.length === 0) return null;

      const preferences: Record<string, unknown> = {};
      rows.forEach(row => {
        try {
          // Decrypt the preference value before parsing
          const decryptedValue = encryptionService.decrypt(row.value);
          preferences[row.key] = JSON.parse(decryptedValue);
        } catch {
          // If decryption or parsing fails, use raw value
          preferences[row.key] = row.value;
        }
      });

      return preferences as unknown as UserPreferences;
    } else {
      // Fallback to JSON
      try {
        if (fs.existsSync(this.preferencesFile)) {
          const data = fs.readFileSync(this.preferencesFile, 'utf8');
          return JSON.parse(data) as UserPreferences;
        }
      } catch (error) {
        console.error('Failed to load preferences from JSON:', error);
      }
    }

    return null;
  }

  savePreferences(preferences: UserPreferences, userId?: string): void {
    if (this.useSQLite) {
      const db = getDatabase();
      const now = Date.now();

      // If no userId provided, get the first user (single-user mode)
      if (!userId) {
        const firstUser = db.prepare('SELECT id FROM users LIMIT 1').get() as
          | { id: string }
          | undefined;
        if (firstUser) {
          userId = firstUser.id;
        } else {
          throw new Error('No users found in database');
        }
      }

      const transaction = db.transaction((preferences: UserPreferences) => {
        // Delete existing preferences for this user
        const deleteStmt = db.prepare(
          'DELETE FROM user_preferences WHERE user_id = ?'
        );
        deleteStmt.run(userId);

        // Insert new preferences
        const insertStmt = db.prepare(`
          INSERT INTO user_preferences (id, user_id, key, value, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        Object.entries(preferences).forEach(([key, value]) => {
          // Encrypt the preference value before storing
          const encryptedValue = encryptionService.encrypt(
            JSON.stringify(value)
          );

          insertStmt.run(uuidv4(), userId, key, encryptedValue, now, now);
        });
      });

      transaction(preferences);
    } else {
      // Fallback to JSON
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

  getAllDocuments(userId = 'default'): Document[] {
    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare(`
        SELECT * FROM documents WHERE user_id = ? ORDER BY uploaded_at DESC
      `);
      const rows = stmt.all(userId) as DocumentRow[];

      return rows.map(row => {
        // Decrypt document data
        const decryptedTitle = row.title
          ? encryptionService.decrypt(row.title)
          : undefined;
        const decryptedContent = row.content
          ? encryptionService.decrypt(row.content)
          : undefined;
        const decryptedMetadata = row.metadata
          ? JSON.parse(encryptionService.decrypt(row.metadata))
          : undefined;

        return {
          id: row.id,
          filename: row.filename,
          title: decryptedTitle,
          content: decryptedContent,
          fileType: row.file_type as 'pdf' | 'txt' | undefined,
          size: row.size,
          sessionId: row.session_id,
          uploadedAt: row.uploaded_at,
          createdAt: row.created_at,
          metadata: decryptedMetadata,
        };
      });
    } else {
      // Fallback to JSON
      try {
        if (fs.existsSync(this.documentsFile)) {
          const data = fs.readFileSync(this.documentsFile, 'utf8');
          return JSON.parse(data) as Document[];
        }
      } catch (error) {
        console.error('Failed to load documents from JSON:', error);
      }
    }

    return [];
  }

  getDocument(documentId: string, userId = 'default'): Document | undefined {
    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare(
        'SELECT * FROM documents WHERE id = ? AND user_id = ?'
      );
      const row = stmt.get(documentId, userId) as DocumentRow | undefined;

      if (!row) return undefined;

      // Decrypt document data
      const decryptedTitle = row.title
        ? encryptionService.decrypt(row.title)
        : undefined;
      const decryptedContent = row.content
        ? encryptionService.decrypt(row.content)
        : undefined;
      const decryptedMetadata = row.metadata
        ? JSON.parse(encryptionService.decrypt(row.metadata))
        : undefined;

      return {
        id: row.id,
        filename: row.filename,
        title: decryptedTitle,
        content: decryptedContent,
        fileType: row.file_type as 'pdf' | 'txt' | undefined,
        size: row.size,
        sessionId: row.session_id,
        uploadedAt: row.uploaded_at,
        createdAt: row.created_at,
        metadata: decryptedMetadata,
      };
    } else {
      // Fallback to JSON
      const documents = this.getAllDocuments();
      return documents.find(d => d.id === documentId);
    }
  }

  saveDocument(document: Document, userId = 'default'): void {
    if (this.useSQLite) {
      const db = getDatabase();
      const now = Date.now();

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO documents 
        (id, user_id, filename, title, content, metadata, uploaded_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Encrypt sensitive document data
      const encryptedTitle = document.title
        ? encryptionService.encrypt(document.title)
        : null;
      const encryptedContent = document.content
        ? encryptionService.encrypt(document.content)
        : null;
      const encryptedMetadata = document.metadata
        ? encryptionService.encrypt(JSON.stringify(document.metadata))
        : null;

      stmt.run(
        document.id,
        userId,
        document.filename,
        encryptedTitle,
        encryptedContent,
        encryptedMetadata,
        document.uploadedAt,
        document.createdAt || now,
        now
      );
    } else {
      // Fallback to JSON
      try {
        const documents = this.getAllDocuments();
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

  deleteDocument(documentId: string, userId = 'default'): boolean {
    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare(
        'DELETE FROM documents WHERE id = ? AND user_id = ?'
      );
      const result = stmt.run(documentId, userId);
      return result.changes > 0;
    } else {
      // Fallback to JSON
      try {
        const documents = this.getAllDocuments();
        const filteredDocuments = documents.filter(d => d.id !== documentId);

        if (filteredDocuments.length !== documents.length) {
          fs.writeFileSync(
            this.documentsFile,
            JSON.stringify(filteredDocuments, null, 2)
          );
          return true;
        }
      } catch (error) {
        console.error('Failed to delete document from JSON:', error);
      }
    }

    return false;
  }

  // =================================
  // DOCUMENT CHUNKS MANAGEMENT
  // =================================

  getDocumentChunks(documentId: string): DocumentChunk[] {
    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare(`
        SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC
      `);
      const rows = stmt.all(documentId) as DocumentChunkRow[];

      return rows.map(row => {
        // Decrypt document chunk data
        const decryptedContent = encryptionService.decrypt(row.content);
        const decryptedEmbedding = row.embedding
          ? JSON.parse(encryptionService.decrypt(row.embedding))
          : undefined;
        const decryptedMetadata = row.metadata
          ? JSON.parse(encryptionService.decrypt(row.metadata))
          : undefined;

        return {
          id: row.id,
          documentId: row.document_id,
          content: decryptedContent,
          embedding: decryptedEmbedding,
          chunkIndex: row.chunk_index,
          startChar: row.start_char,
          endChar: row.end_char,
          metadata: decryptedMetadata,
        };
      });
    } else {
      // Fallback to JSON
      try {
        if (fs.existsSync(this.documentChunksFile)) {
          const data = fs.readFileSync(this.documentChunksFile, 'utf8');
          const chunksData = JSON.parse(data);
          return chunksData[documentId] || [];
        }
      } catch (error) {
        console.error('Failed to load document chunks from JSON:', error);
      }
    }

    return [];
  }

  saveDocumentChunks(documentId: string, chunks: DocumentChunk[]): void {
    if (this.useSQLite) {
      const db = getDatabase();
      const now = Date.now();

      const transaction = db.transaction(
        (documentId: string, chunks: DocumentChunk[]) => {
          // Delete existing chunks
          const deleteStmt = db.prepare(
            'DELETE FROM document_chunks WHERE document_id = ?'
          );
          deleteStmt.run(documentId);

          // Insert new chunks
          if (chunks.length > 0) {
            const insertStmt = db.prepare(`
            INSERT INTO document_chunks 
            (id, document_id, chunk_index, content, start_char, end_char, embedding, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);

            chunks.forEach(chunk => {
              // Encrypt chunk data
              const encryptedContent = encryptionService.encrypt(chunk.content);
              const encryptedEmbedding = chunk.embedding
                ? encryptionService.encrypt(JSON.stringify(chunk.embedding))
                : null;

              insertStmt.run(
                chunk.id,
                documentId,
                chunk.chunkIndex,
                encryptedContent,
                chunk.startChar || null,
                chunk.endChar || null,
                encryptedEmbedding,
                now
              );
            });
          }
        }
      );

      transaction(documentId, chunks);
    } else {
      // Fallback to JSON
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

  deleteDocumentChunks(documentId: string): boolean {
    if (this.useSQLite) {
      const db = getDatabase();
      const stmt = db.prepare(
        'DELETE FROM document_chunks WHERE document_id = ?'
      );
      const result = stmt.run(documentId);
      return result.changes > 0;
    } else {
      // Fallback to JSON
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
    }

    return false;
  }
}

// Export singleton instance
const storageService = new StorageService();
export default storageService;
