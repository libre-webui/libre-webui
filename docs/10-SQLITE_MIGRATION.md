# SQLite Migration Guide

**Libre WebUI** has migrated from JSON file storage to **SQLite** for improved performance, data integrity, and scalability. This guide covers the migration process, benefits, and how to work with the new storage system.

## 🎯 Overview

The SQLite migration transforms Libre WebUI's storage from individual JSON files to a robust, ACID-compliant SQLite database while maintaining full backward compatibility.

### **Before Migration (JSON Storage):**
```
backend/
├── sessions.json           # All chat sessions
├── preferences.json        # User preferences
├── documents.json          # Document metadata
└── document-chunks.json    # Document chunks with embeddings
```

### **After Migration (SQLite Storage):**
```
backend/
├── data.sqlite            # Single SQLite database
├── backup-*/              # Automatic JSON backups
└── src/
    ├── db.ts              # Database connection & schema
    └── storage.ts         # Storage abstraction layer
```

## 🚀 Benefits of SQLite Migration

### **Performance Improvements**
- **⚡ Faster Queries:** Indexed database searches vs. linear JSON parsing
- **🔄 Concurrent Access:** Multiple operations without file locking issues
- **📊 Efficient Storage:** Normalized data structure reduces redundancy

### **Data Integrity**
- **🔒 ACID Transactions:** Atomicity, Consistency, Isolation, Durability
- **🔗 Foreign Key Constraints:** Referential integrity enforced
- **✅ Schema Validation:** Type safety at the database level

### **Scalability**
- **📈 Growing Data:** No performance degradation with large datasets
- **🔍 Complex Queries:** Advanced filtering and joining capabilities
- **💾 Memory Efficient:** Only loads required data, not entire files

## 🗄️ Database Schema

### **Tables Structure**

```sql
-- User management (for future multi-user support)
users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

-- Chat sessions (migrated from sessions.json)
sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default',
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
)

-- Chat messages (normalized from sessions)
session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  message_index INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
)

-- Documents (migrated from documents.json)
documents (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default',
  filename TEXT NOT NULL,
  title TEXT,
  content TEXT,
  metadata TEXT, -- JSON string
  uploaded_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
)

-- Document chunks (migrated from document-chunks.json)
document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  start_char INTEGER,
  end_char INTEGER,
  embedding TEXT, -- JSON string for vector
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id)
)

-- User preferences (migrated from preferences.json)
user_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default',
  key TEXT NOT NULL,
  value TEXT NOT NULL, -- JSON string
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, key)
)
```

## 🔄 Migration Process

### **Automatic Migration**

The migration happens automatically when you run:

```bash
cd backend
npm run migrate
```

### **Migration Steps:**

1. **📋 Pre-Migration Checks**
   - Validates JSON file existence
   - Creates SQLite database and tables
   - Sets up default user account

2. **💾 Backup Creation**
   - Automatically backs up all JSON files
   - Timestamped backup directory: `backup-YYYY-MM-DDTHH-mm-ss-sssZ`

3. **📊 Data Migration**
   - **Sessions:** 57 sessions with all messages migrated
   - **Preferences:** 5 preference keys migrated
   - **Documents:** 6 documents with metadata migrated
   - **Chunks:** 26 document chunks with embeddings migrated

4. **✅ Verification**
   - Confirms data integrity
   - Tests database connections
   - Validates foreign key relationships

### **Migration Output Example:**

```bash
🔄 Starting migration from JSON to SQLite...
📁 Working directory: /backend

👤 Creating default user...
✅ Created default user

💾 Creating backups of JSON files...
✅ Backed up: sessions.json
✅ Backed up: preferences.json
✅ Backed up: documents.json
✅ Backed up: document-chunks.json

📋 Migrating sessions...
📊 Found 57 sessions to migrate
✅ Migrated session: "Chat Title" (14 messages)
...
✨ Sessions migration completed: 57 migrated, 0 skipped

⚙️ Migrating preferences...
✅ Migrated preference: defaultModel
✅ Migrated preference: theme
✨ Preferences migration completed

🎉 Migration completed successfully!
```

## 🏗️ Storage Architecture

### **Storage Abstraction Layer**

The `storage.ts` module provides a unified interface that:

- **🔄 Auto-Detection:** Uses SQLite when available, falls back to JSON
- **🔧 API Compatibility:** No changes needed in existing services
- **🛡️ Error Handling:** Graceful degradation on database issues

```typescript
// Example: Storage service automatically handles both SQLite and JSON
const sessions = storageService.getAllSessions(); // Works with both storage types
storageService.saveSession(session); // Saves to SQLite or JSON fallback
```

### **Service Layer Updates**

All services have been updated to use the storage abstraction:

- **`ChatService`** - Session and message management
- **`PreferencesService`** - User settings and configuration
- **`DocumentService`** - File uploads and RAG functionality

## 🔧 Development & Maintenance

### **Database Operations**

```bash
# Run migration
npm run migrate

# Start backend (auto-detects SQLite)
npm run dev

# Build backend
npm run build
```

### **Accessing the Database**

```bash
# Direct SQLite access
sqlite3 backend/data.sqlite

# Example queries
.tables                          # List all tables
.schema sessions                 # Show table schema
SELECT COUNT(*) FROM sessions;   # Count sessions
```

### **Backup & Recovery**

**Automatic Backups:**
- JSON files are automatically backed up before migration
- Backup location: `backend/backup-{timestamp}/`

**Manual Backup:**
```bash
# Backup SQLite database
cp backend/data.sqlite backend/data.sqlite.backup

# Restore from backup
cp backend/data.sqlite.backup backend/data.sqlite
```

## 🔍 Troubleshooting

### **Common Issues**

**Migration Fails with Foreign Key Error:**
```bash
# Ensure you run the complete migration script
npm run migrate
# It creates the default user before migrating sessions
```

**Database Locked Error:**
```bash
# Stop all backend processes
pkill -f "tsx watch"
# Restart the backend
npm run dev
```

**Fallback to JSON Storage:**
```bash
# If SQLite is unavailable, the system automatically falls back to JSON
# Check logs for "Storage mode: JSON" vs "Storage mode: SQLite"
```

### **Performance Monitoring**

```sql
-- Check database size
SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size();

-- Index usage analysis
EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE user_id = 'default';

-- Table statistics
SELECT name, COUNT(*) FROM sessions UNION ALL
SELECT 'documents', COUNT(*) FROM documents UNION ALL
SELECT 'chunks', COUNT(*) FROM document_chunks;
```

## 🚧 Future Enhancements

### **Planned Features**

1. **👥 Multi-User Support**
   - User registration and authentication
   - Role-based access control
   - User-specific data isolation

2. **📊 Advanced Analytics**
   - Usage statistics and metrics
   - Query performance monitoring
   - Storage optimization recommendations

3. **🔄 Database Migrations**
   - Schema versioning system
   - Automatic database updates
   - Migration rollback capabilities

4. **☁️ Backup Automation**
   - Scheduled database backups
   - Cloud storage integration
   - Point-in-time recovery

## 🎯 Best Practices

### **For Developers**

1. **Always use the storage service** instead of direct database access
2. **Handle errors gracefully** - storage operations can fail
3. **Use transactions** for multi-step operations
4. **Test with both storage modes** (SQLite and JSON fallback)

### **For Deployment**

1. **Run migration before starting production**
2. **Monitor database size and performance**
3. **Set up regular backups**
4. **Keep JSON backups until confident in SQLite stability**

## 📝 Migration Log

| Date | Version | Change |
|------|---------|--------|
| 2025-07-02 | 0.1.0-rc | Initial SQLite migration |
| | | - Migrated 57 sessions, 6 documents, 26 chunks |
| | | - Added storage abstraction layer |
| | | - Implemented automatic JSON backups |

---

**🎉 The SQLite migration provides a solid foundation for Libre WebUI's future growth while maintaining complete backward compatibility!**
