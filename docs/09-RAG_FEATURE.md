# RAG Document Upload Feature

## Overview

The RAG (Retrieval-Augmented Generation) feature allows users to upload PDF and TXT documents and have AI-powered conversations with their file content. This feature provides context-aware responses by automatically retrieving relevant document sections based on user queries.

## Features Implemented

### Backend Components

1. **Document Service** (`/backend/src/services/documentService.ts`)
   - PDF and TXT file processing using `pdf-parse`
   - Intelligent text chunking with overlap for better context
   - Simple keyword-based search (ready for vector embeddings upgrade)
   - Document storage and management per session

2. **Document Routes** (`/backend/src/routes/documents.ts`)
   - `POST /api/documents/upload` - Upload PDF/TXT files
   - `GET /api/documents/session/:sessionId` - Get documents for a session
   - `GET /api/documents/:documentId` - Get specific document details
   - `POST /api/documents/search` - Search within documents
   - `DELETE /api/documents/:documentId` - Delete documents

3. **RAG Integration** (in main WebSocket handler)
   - Automatic document context retrieval based on user queries
   - Context injection into chat messages before sending to AI models
   - Session-based document isolation

### Frontend Components

1. **Document Upload Component** (`/frontend/src/components/DocumentUpload.tsx`)
   - Drag-and-drop file upload interface
   - File type validation (PDF/TXT only)
   - File size validation (10MB limit)
   - Upload progress indication
   - Uploaded documents list with metadata

2. **Document Indicator** (`/frontend/src/components/DocumentIndicator.tsx`)
   - Visual indicator showing when documents are available
   - Document count and total size display
   - Session-specific document tracking

3. **API Integration** (`/frontend/src/utils/api.ts`)
   - Complete document API wrapper functions
   - Demo mode support for development
   - Error handling and response formatting

4. **Chat Integration** (integrated into `ChatInput.tsx`)
   - Document upload panel in advanced features
   - Session-aware document management
   - Visual indicators for active documents

## How It Works

### Upload Flow
1. User clicks advanced features in chat input
2. User uploads PDF or TXT file via drag-drop or file picker
3. Backend processes document:
   - Extracts text (PDF parsing or direct text reading)
   - Splits into chunks with overlapping content
   - Stores document metadata and chunks
4. Document becomes available for RAG queries

### Query Flow
1. User asks a question in chat
2. System searches uploaded documents for relevant content
3. Top matching chunks are retrieved and formatted
4. Document context is injected into the user's message
5. Enhanced message is sent to the AI model
6. AI responds with context-aware answer

### Context Injection Format
```
Context from uploaded documents:

[From: filename.pdf]
Relevant document content chunk 1...

---

[From: filename.txt]
Relevant document content chunk 2...

---

User question: What is the main topic discussed?
```

## Files Modified/Created

### Backend Files
- `src/services/documentService.ts` - NEW: Core document processing
- `src/routes/documents.ts` - NEW: Document API endpoints  
- `src/types/index.ts` - MODIFIED: Added Document and DocumentChunk types
- `src/index.ts` - MODIFIED: Added document routes and RAG integration
- `package.json` - MODIFIED: Added pdf-parse dependency

### Frontend Files
- `src/components/DocumentUpload.tsx` - NEW: Document upload interface
- `src/components/DocumentIndicator.tsx` - NEW: Visual document indicator
- `src/components/ChatInput.tsx` - MODIFIED: Integrated document upload
- `src/components/index.ts` - MODIFIED: Added new component exports
- `src/utils/api.ts` - MODIFIED: Added document API functions

### Documentation
- `README.md` - MODIFIED: Added RAG feature documentation

## Usage Instructions

1. **Start a chat session** - Create or open an existing chat
2. **Access advanced features** - Click the advanced features button in chat input
3. **Upload documents** - Use the document upload panel to add PDF or TXT files
4. **Ask questions** - Type questions related to your uploaded documents
5. **Get context-aware responses** - The AI will automatically use document content to provide informed answers

## Technical Notes

### Current Implementation
- **Search Method**: Simple keyword-based search with term frequency scoring
- **Chunking**: Paragraph-based chunking with 1000 character limit and 200 character overlap
- **Storage**: File-based JSON storage for documents and chunks
- **Session Isolation**: Documents are linked to specific chat sessions

### Future Enhancements
- **Vector Embeddings**: Upgrade to semantic search using Ollama embeddings
- **Advanced Chunking**: Implement recursive text splitting and semantic boundaries
- **Document Types**: Support for DOCX, HTML, and other formats
- **Database Storage**: Migrate from JSON files to proper database
- **Caching**: Implement chunk caching for faster retrieval

## Security Features

- **File Type Validation**: Only PDF and TXT files accepted
- **Size Limits**: 10MB maximum file size
- **Session Isolation**: Documents only accessible within their session
- **Local Processing**: All document processing happens on user's device
- **No Telemetry**: No document content or metadata sent to external services

## Error Handling

- Graceful handling of malformed PDF files
- Clear error messages for unsupported file types
- Automatic cleanup of failed uploads
- Fallback to normal chat when no documents available
- Toast notifications for all user-facing errors

This implementation provides a solid foundation for document-based RAG that can be enhanced with more sophisticated NLP techniques as needed.
