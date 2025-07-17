#!/usr/bin/env tsx
/*
 * Clear encrypted data migration script
 * This script clears all existing encrypted data to resolve decryption errors
 * when switching to a new encryption key.
 */

import path from 'path';
import fs from 'fs';
import { getDatabaseSafe } from '../src/db.js';

async function clearEncryptedData() {
  console.log('🧹 Starting encrypted data cleanup...');

  try {
    // Clear SQLite database if it exists
    const db = getDatabaseSafe();
    if (db) {
      console.log('📦 Clearing SQLite database tables...');
      
      // Clear all encrypted tables
      const tables = [
        'sessions',
        'documents',
        'document_chunks', 
        'preferences',
        'users',
        'personas',
        'persona_memories',
        'persona_states'
      ];

      for (const table of tables) {
        try {
          const stmt = db.prepare(`DELETE FROM ${table}`);
          const result = stmt.run();
          console.log(`   ✅ Cleared ${table}: ${result.changes} rows deleted`);
        } catch (error) {
          console.log(`   ⚠️  Table ${table} doesn't exist or couldn't be cleared: ${error}`);
        }
      }

      // Reset SQLite sequences
      try {
        db.exec(`DELETE FROM sqlite_sequence`);
        console.log('   ✅ Reset SQLite sequences');
      } catch (error) {
        console.log('   ⚠️  No sequences to reset');
      }
    }

    // Clear JSON storage files
    console.log('📄 Clearing JSON storage files...');
    const dataDir = path.join(process.cwd(), 'backend', 'data');
    const jsonFiles = [
      'sessions.json',
      'documents.json', 
      'document_chunks.json',
      'preferences.json',
      'users.json'
    ];

    for (const file of jsonFiles) {
      const filePath = path.join(dataDir, file);
      if (fs.existsSync(filePath)) {
        try {
          fs.writeFileSync(filePath, '[]');
          console.log(`   ✅ Cleared ${file}`);
        } catch (error) {
          console.log(`   ⚠️  Could not clear ${file}: ${error}`);
        }
      } else {
        console.log(`   ℹ️  ${file} doesn't exist`);
      }
    }

    console.log('\n🎉 Encrypted data cleanup completed successfully!');
    console.log('📝 All existing data has been cleared to prevent decryption errors.');
    console.log('🔄 Please restart the application to begin with fresh encrypted data.');

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1);
  }
}

// Run the cleanup
clearEncryptedData();
