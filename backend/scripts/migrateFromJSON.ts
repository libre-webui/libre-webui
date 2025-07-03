#!/usr/bin/env node

/*
 * Libre WebUI - JSON to SQLite Migration Script
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
import { v4 as uuidv4 } from 'uuid';
import getDatabase from '../src/db.js';
import { ChatSession, ChatMessage, DocumentChunk } from '../src/types/index.js';

const rootDir = process.cwd();
const sessionsFile = path.join(rootDir, 'sessions.json');
const preferencesFile = path.join(rootDir, 'preferences.json');
const documentsFile = path.join(rootDir, 'documents.json');
const documentChunksFile = path.join(rootDir, 'document-chunks.json');

console.log('🔄 Starting migration from JSON to SQLite...');
console.log(`📁 Working directory: ${rootDir}`);

/**
 * Create default user if it doesn't exist
 */
async function createDefaultUser(): Promise<void> {
  console.log('\n👤 Creating default user...');
  
  const db = getDatabase();
  
  // Check if default user exists
  const existingUser = db.prepare('SELECT id FROM users WHERE id = ?').get('default');
  
  if (!existingUser) {
    const now = Date.now();
    const insertUserStmt = db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    insertUserStmt.run(
      'default',
      'default',
      null,
      'no-password', // Placeholder since we don't have authentication yet
      'user',
      now,
      now
    );
    
    console.log('✅ Created default user');
  } else {
    console.log('👤 Default user already exists');
  }
}

/**
 * Migrate sessions from sessions.json to SQLite
 */
async function migrateSessions(): Promise<void> {
  console.log('\n📋 Migrating sessions...');
  
  if (!fs.existsSync(sessionsFile)) {
    console.log('⚠️  sessions.json not found, skipping sessions migration');
    return;
  }

  try {
    const data = fs.readFileSync(sessionsFile, 'utf8');
    const sessions: ChatSession[] = JSON.parse(data);
    
    console.log(`📊 Found ${sessions.length} sessions to migrate`);
    
    const db = getDatabase();
    let migratedCount = 0;
    let skippedCount = 0;

    // Check for existing sessions to avoid duplicates
    const existingSessionsStmt = db.prepare('SELECT id FROM sessions');
    const existingSessions = new Set(
      existingSessionsStmt.all().map((row: any) => row.id)
    );

    // Prepare statements
    const insertSessionStmt = db.prepare(`
      INSERT OR IGNORE INTO sessions (id, user_id, title, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertMessageStmt = db.prepare(`
      INSERT OR IGNORE INTO session_messages (id, session_id, role, content, timestamp, message_index)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Use transaction for better performance
    const transaction = db.transaction((sessions: ChatSession[]) => {
      for (const session of sessions) {
        if (existingSessions.has(session.id)) {
          console.log(`⏭️  Skipping existing session: ${session.title} (${session.id})`);
          skippedCount++;
          continue;
        }

        // Insert session
        insertSessionStmt.run(
          session.id,
          'default', // Default user for now
          session.title,
          session.model,
          session.createdAt,
          session.updatedAt
        );

        // Insert messages
        if (session.messages && session.messages.length > 0) {
          session.messages.forEach((message: ChatMessage, index: number) => {
            insertMessageStmt.run(
              uuidv4(),
              session.id,
              message.role,
              message.content,
              message.timestamp,
              index
            );
          });
        }

        console.log(`✅ Migrated session: ${session.title} (${session.messages?.length || 0} messages)`);
        migratedCount++;
      }
    });

    transaction(sessions);
    
    console.log(`✨ Sessions migration completed: ${migratedCount} migrated, ${skippedCount} skipped`);
  } catch (error) {
    console.error('❌ Failed to migrate sessions:', error);
    throw error;
  }
}

/**
 * Migrate preferences from preferences.json to SQLite
 */
async function migratePreferences(): Promise<void> {
  console.log('\n⚙️  Migrating preferences...');
  
  if (!fs.existsSync(preferencesFile)) {
    console.log('⚠️  preferences.json not found, skipping preferences migration');
    return;
  }

  try {
    const data = fs.readFileSync(preferencesFile, 'utf8');
    const preferences = JSON.parse(data);
    
    console.log(`📊 Found preferences to migrate: ${Object.keys(preferences).length} keys`);
    
    const db = getDatabase();
    const now = Date.now();

    // Clear existing preferences for default user
    const deleteStmt = db.prepare('DELETE FROM user_preferences WHERE user_id = ?');
    deleteStmt.run('default');

    // Insert new preferences
    const insertStmt = db.prepare(`
      INSERT INTO user_preferences (id, user_id, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction((preferences: Record<string, any>) => {
      Object.entries(preferences).forEach(([key, value]) => {
        insertStmt.run(
          uuidv4(),
          'default',
          key,
          JSON.stringify(value),
          now,
          now
        );
        console.log(`✅ Migrated preference: ${key}`);
      });
    });

    transaction(preferences);
    
    console.log('✨ Preferences migration completed');
  } catch (error) {
    console.error('❌ Failed to migrate preferences:', error);
    throw error;
  }
}

/**
 * Migrate documents from documents.json to SQLite
 */
async function migrateDocuments(): Promise<void> {
  console.log('\n📄 Migrating documents...');
  
  if (!fs.existsSync(documentsFile)) {
    console.log('⚠️  documents.json not found, skipping documents migration');
    return;
  }

  try {
    const data = fs.readFileSync(documentsFile, 'utf8');
    const documents: any[] = JSON.parse(data);
    
    console.log(`📊 Found ${documents.length} documents to migrate`);
    
    const db = getDatabase();
    const now = Date.now();
    let migratedCount = 0;
    let skippedCount = 0;

    // Check for existing documents to avoid duplicates
    const existingDocsStmt = db.prepare('SELECT id FROM documents');
    const existingDocs = new Set(
      existingDocsStmt.all().map((row: any) => row.id)
    );

    // Prepare statement
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO documents 
      (id, user_id, filename, title, content, metadata, uploaded_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction((documents: any[]) => {
      for (const doc of documents) {
        if (!doc.id) {
          doc.id = uuidv4(); // Generate ID if missing
        }

        if (existingDocs.has(doc.id)) {
          console.log(`⏭️  Skipping existing document: ${doc.filename} (${doc.id})`);
          skippedCount++;
          continue;
        }

        insertStmt.run(
          doc.id,
          'default', // Default user for now
          doc.filename,
          doc.title || null,
          doc.content || null,
          doc.metadata ? JSON.stringify(doc.metadata) : null,
          doc.uploadedAt,
          doc.createdAt || now,
          now
        );

        console.log(`✅ Migrated document: ${doc.filename}`);
        migratedCount++;
      }
    });

    transaction(documents);
    
    console.log(`✨ Documents migration completed: ${migratedCount} migrated, ${skippedCount} skipped`);
  } catch (error) {
    console.error('❌ Failed to migrate documents:', error);
    throw error;
  }
}

/**
 * Migrate document chunks from document-chunks.json to SQLite
 */
async function migrateDocumentChunks(): Promise<void> {
  console.log('\n🧩 Migrating document chunks...');
  
  if (!fs.existsSync(documentChunksFile)) {
    console.log('⚠️  document-chunks.json not found, skipping chunks migration');
    return;
  }

  try {
    const data = fs.readFileSync(documentChunksFile, 'utf8');
    const chunksData: Record<string, DocumentChunk[]> = JSON.parse(data);
    
    const documentIds = Object.keys(chunksData);
    console.log(`📊 Found chunks for ${documentIds.length} documents`);
    
    const db = getDatabase();
    const now = Date.now();
    let totalMigratedChunks = 0;
    let skippedDocuments = 0;

    // Check for existing chunks to avoid duplicates
    const existingChunksStmt = db.prepare('SELECT DISTINCT document_id FROM document_chunks');
    const existingChunkDocs = new Set(
      existingChunksStmt.all().map((row: any) => row.document_id)
    );

    // Prepare statement
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO document_chunks 
      (id, document_id, chunk_index, content, start_char, end_char, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction((chunksData: Record<string, DocumentChunk[]>) => {
      for (const [documentId, chunks] of Object.entries(chunksData)) {
        if (existingChunkDocs.has(documentId)) {
          console.log(`⏭️  Skipping existing chunks for document: ${documentId}`);
          skippedDocuments++;
          continue;
        }

        for (const chunk of chunks) {
          insertStmt.run(
            chunk.id,
            documentId,
            chunk.chunkIndex,
            chunk.content,
            chunk.startChar || null,
            chunk.endChar || null,
            chunk.embedding ? JSON.stringify(chunk.embedding) : null,
            now
          );
        }

        console.log(`✅ Migrated ${chunks.length} chunks for document: ${documentId}`);
        totalMigratedChunks += chunks.length;
      }
    });

    transaction(chunksData);
    
    console.log(`✨ Document chunks migration completed: ${totalMigratedChunks} chunks migrated, ${skippedDocuments} documents skipped`);
  } catch (error) {
    console.error('❌ Failed to migrate document chunks:', error);
    throw error;
  }
}

/**
 * Create backup of JSON files before migration
 */
function createBackups(): void {
  console.log('\n💾 Creating backups of JSON files...');
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(rootDir, `backup-${timestamp}`);
  
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
  }

  const filesToBackup = [
    sessionsFile,
    preferencesFile,
    documentsFile,
    documentChunksFile,
  ];

  for (const file of filesToBackup) {
    if (fs.existsSync(file)) {
      const filename = path.basename(file);
      const backupPath = path.join(backupDir, filename);
      fs.copyFileSync(file, backupPath);
      console.log(`✅ Backed up: ${filename}`);
    }
  }

  console.log(`📁 Backups created in: ${backupDir}`);
}

/**
 * Main migration function
 */
async function runMigration(): Promise<void> {
  try {
    console.log('🚀 Starting JSON to SQLite migration process...');
    
    // Initialize database (creates tables if they don't exist)
    getDatabase();
    
    // Create default user first
    await createDefaultUser();
    
    // Create backups
    createBackups();
    
    // Run migrations in order
    await migrateSessions();
    await migratePreferences();
    await migrateDocuments();
    await migrateDocumentChunks();
    
    console.log('\n🎉 Migration completed successfully!');
    console.log('');
    console.log('📋 Summary:');
    console.log('  - All JSON data has been migrated to SQLite');
    console.log('  - Original JSON files have been backed up');
    console.log('  - The application will now use SQLite as the primary storage');
    console.log('');
    console.log('💡 Next steps:');
    console.log('  - Test the application to ensure everything works correctly');
    console.log('  - The JSON files are kept as backup and can be removed later');
    console.log('  - Monitor the application logs for any issues');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    console.log('\n🔧 Recovery:');
    console.log('  - The original JSON files are still intact');
    console.log('  - You can continue using the JSON storage');
    console.log('  - Check the error message above and try again');
    
    process.exit(1);
  }
}

// Only run if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration().catch(console.error);
}

export { runMigration };
