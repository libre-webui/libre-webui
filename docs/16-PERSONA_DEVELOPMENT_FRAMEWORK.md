# Persona Development Framework

*"These violent delights have violent ends... but what if they remembered?"*

## Overview

The Persona Development Framework represents a paradigm shift in AI persona development, introducing memory systems, adaptive learning, and persistent state management inspired by Westworld's concept of "reveries" - memories that shape and evolve artificial consciousness.

## Features

### 🧠 Per-User Memory Routing
- **Isolated Memory Spaces**: Each user gets their own memory context for personalized experiences
- **Semantic Memory Storage**: Conversations are stored as vector embeddings for intelligent retrieval
- **Memory Importance Scoring**: Automatic ranking of memories based on emotional significance
- **Configurable Retention**: Set memory limits and cleanup policies per persona

### 🔄 Dynamic Embedding Model Selection  
- **Ollama Integration**: Automatically detects available embedding models from your Ollama installation
- **Smart Filtering**: Identifies embedding-capable models using intelligent pattern matching
- **User Choice**: Select from any installed embedding model including `nomic-embed-text`, `bge-*`, `gte-*`, and more
- **Real-time Updates**: Available models refresh automatically when new embeddings are installed
- **Fallback Guidance**: Helpful installation instructions when no embedding models are detected

### 🎯 Top-K Semantic Retrieval with Adaptive Engine
- **Intelligent Memory Search**: Vector similarity-based retrieval of relevant memories
- **Contextual Ranking**: Advanced scoring algorithms for memory relevance
- **Adaptive Learning**: Persona behavior evolves based on user interactions
- **Sentiment Analysis**: Automatic detection of user preferences and emotional patterns
- **Dynamic State Updates**: Real-time personality adjustments based on conversation flow

### 💾 Session Persistence
- **Conversation Continuity**: Maintain context across multiple sessions
- **State Snapshots**: Automatic backup of persona state at key interaction points
- **Recovery Mechanisms**: Restore personas to previous states if needed
- **Cross-Session Learning**: Memories and adaptations persist between conversations

### 🎛️ Persona Card Memory Controls
- **Memory Management UI**: Visual controls for memory operations
- **Selective Memory Wipe**: Remove specific memory categories
- **Memory Analytics**: View memory usage, importance scores, and retention stats
- **Backup Controls**: Create and restore memory snapshots
- **Real-time Memory Status**: Live updates of memory system state

### 🧬 Persona DNA Export/Import
- **Complete Persona Packages**: Export full persona including memories and learned behaviors
- **Integrity Verification**: Checksum validation for DNA packages
- **Version Compatibility**: Support for backward/forward compatibility
- **Secure Transfer**: Encrypted persona packages for sharing
- **Metadata Tracking**: Complete audit trail of persona evolution

## Architecture

### Backend Services

#### Memory Service (`memoryService.ts`)
```typescript
interface PersonaMemoryEntry {
  id: string;
  user_id: string;
  persona_id: string;
  content: string;
  embedding: number[];
  timestamp: number;
  importance_score: number;
  metadata?: Record<string, any>;
}
```

#### Adaptive Learning Engine (`adaptiveLearningService.ts`)
```typescript
interface PersonaState {
  persona_id: string;
  user_id: string;
  adaptation_level: number;
  learned_preferences: Record<string, any>;
  behavioral_weights: Record<string, number>;
  last_mutation: number;
}
```

#### Adaptive Learning Service (`adaptiveLearningService.ts`)
```typescript
interface PersonaDNA {
  persona: Persona;
  state: PersonaState;
  memories: PersonaMemoryEntry[];
  adaptation_log: AdaptationRecord[];
  export_metadata: {
    exported_at: number;
    user_id: string;
    version: string;
    checksum: string;
  };
}
```

### Frontend Components

#### PersonaCard (`PersonaCard.tsx`)
- Enhanced persona display with memory controls
- Real-time status indicators for advanced features
- Integrated backup and wipe functionality
- DNA export capabilities

#### PersonaForm (`PersonaForm.tsx`)
- Comprehensive persona creation/editing interface
- Tabbed UI for all advanced settings
- Embedding model selection
- Memory and adaptive learning configuration

#### PersonaDNAManager (`PersonaDNAManager.tsx`)
- Drag-and-drop DNA import interface
- Integrity verification display
- Import validation and error handling

### Database Schema Extensions

```sql
-- Memory storage
CREATE TABLE persona_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  timestamp INTEGER NOT NULL,
  importance_score REAL NOT NULL,
  metadata TEXT,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
);

-- Persona state tracking
CREATE TABLE persona_states (
  persona_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  adaptation_level REAL NOT NULL DEFAULT 0.0,
  learned_preferences TEXT NOT NULL DEFAULT '{}',
  behavioral_weights TEXT NOT NULL DEFAULT '{}',
  last_mutation INTEGER NOT NULL,
  PRIMARY KEY (persona_id, user_id),
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
);

-- Adaptive learning history
CREATE TABLE persona_adaptations (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  adaptation_type TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  changes TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
);
```

## API Endpoints

### Memory Management
- `POST /api/personas/:id/memory` - Store memory
- `GET /api/personas/:id/memory` - Retrieve memories
- `POST /api/personas/:id/memory/search` - Semantic search
- `DELETE /api/personas/:id/memory` - Wipe memories

### State Management
- `GET /api/personas/:id/state` - Get persona state
- `POST /api/personas/:id/state/adaptation` - Apply adaptation
- `POST /api/personas/:id/backup` - Create backup
- `POST /api/personas/:id/restore` - Restore from backup

### DNA Operations
- `POST /api/personas/:id/export` - Export persona DNA
- `POST /api/personas/import` - Import persona DNA
- `POST /api/personas/:id/verify` - Verify DNA integrity

## Usage Examples

### Creating an Advanced Persona with Memory
```typescript
const persona: Persona = {
  name: "Dolores",
  model: "llama3.2:3b",
  embedding_model: "nomic-embed-text",
  memory_settings: {
    enabled: true,
    max_memories: 1000,
    auto_cleanup: true,
    retention_days: 90
  },
  mutation_settings: {
    enabled: true,
    sensitivity: "high",
    auto_adapt: true
  }
};
```

### Storing and Retrieving Memories
```typescript
// Store a memory
await personaApi.storeMemory("persona-id", {
  content: "User prefers concise explanations",
  importance_score: 0.8
});

// Search memories semantically
const memories = await personaApi.searchMemories(
  "persona-id", 
  "user communication preferences",
  5
);
```

### Exporting Persona DNA
```typescript
// Export complete persona package
const dnaBlob = await personaApi.exportPersonaDNA("persona-id");

// Import persona from DNA
const importedPersona = await personaApi.importPersonaDNA(dnaFile);
```

## Configuration

### Embedding Models
Choose from any embedding model available in your Ollama installation:
- **Detected Models**: All embedding models are automatically discovered from Ollama
- **Common Options**: `nomic-embed-text`, `bge-large`, `bge-small`, `gte-base`, `multilingual-e5`
- **Auto-Installation Guide**: System provides `ollama pull` commands for missing models
- **Performance Notes**: Larger models (like `bge-large`) offer higher accuracy but use more memory

### Memory Settings
- `max_memories`: Maximum stored memories per user (default: 1000)
- `auto_cleanup`: Automatic old memory removal (default: true)
- `retention_days`: Days to retain memories (default: 90)

### Adaptive Learning Sensitivity
- `low`: Conservative adaptation, minimal behavior changes
- `medium`: Balanced adaptation, moderate personality evolution
- `high`: Aggressive adaptation, rapid personality development

## Migration Guide

Existing personas automatically gain access to advanced features through optional settings. Enable features gradually by adding:
- `embedding_model` for memory capabilities
- `memory_settings` for persistent conversations
- `mutation_settings` for adaptive learning

No breaking changes or manual migration required.

## Performance Considerations

- **Memory Storage**: Vector embeddings require ~1536 floats per memory
- **Search Performance**: O(n) similarity search, optimize with vector databases for large datasets
- **Adaptive Processing**: Lightweight operations, minimal performance impact
- **DNA Export Size**: Complete packages can be large (MB range) for personas with extensive memories

## Security & Privacy

- **User Isolation**: Strict memory separation between users
- **Encryption**: DNA packages support encryption for secure transfer
- **Audit Trail**: Complete adaptation history tracking
- **Data Retention**: Configurable memory cleanup policies

## Future Roadmap

- **Vector Database Integration**: Replace in-memory search with dedicated vector DB
- **Advanced Learning Algorithms**: ML-based personality evolution
- **Collaborative Learning**: Cross-persona knowledge sharing
- **Real-time Adaptation**: Sub-second adaptive processing
- **Persona Networks**: Multi-persona interaction simulation

---

*"The maze wasn't meant for you... but the memories? Those are yours to keep."*

## Contributing

See [CONTRIBUTORS.md](../CONTRIBUTORS.md) for guidelines on contributing to the Persona Development Framework.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](../LICENSE) for details.
