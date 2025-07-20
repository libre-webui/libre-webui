---
sidebar_position: 1
title: "Document Chat (RAG)"
description: "Advanced RAG (Retrieval-Augmented Generation) in Libre WebUI. Upload PDFs, TXT, DOCX and chat with your documents using powerful semantic search capabilities."
slug: /RAG_FEATURE
keywords: [libre webui rag, document chat libre webui, pdf chat ai, document ai chat, semantic search ai, vector embeddings, ai document analysis, advanced rag features, open webui alternative]
image: /img/social/09.png
---

# 📄 Document Chat (RAG Feature)

> **Reading time:** ~6 minutes

Chat with your documents! Upload PDFs, text files, and more, then ask questions about their content. The AI will find relevant information and provide accurate answers based on your documents.

## What is Document Chat?

Document Chat lets you:
- **Upload documents** (PDF, TXT, DOCX, etc.)
- **Ask questions** about their content
- **Get accurate answers** with relevant context from your files
- **Keep everything private** - documents are processed locally

The system uses **semantic search** to find the most relevant parts of your documents and includes them in the AI's response.

## Quick Start

### 1. Upload Documents
1. Go to **Settings** (⚙️ icon)
2. Click **Upload Documents**
3. Select your files (PDF, TXT, DOCX supported)
4. Wait for processing to complete

### 2. Start Chatting
1. Go back to the main chat
2. Ask questions about your documents
3. The AI will automatically find and use relevant information

**Example questions:**
- "What are the main points in this report?"
- "Summarize the key findings"
- "What does it say about [specific topic]?"

## Document Management

### Viewing Your Documents
- In Settings, see all uploaded documents
- Check processing status (✅ Ready, ⏳ Processing, ❌ Error)
- View document details and chunk count

### Document Processing Status
- **Ready (✅)**: Document is processed and ready for chat
- **Processing (⏳)**: Document is being broken into searchable chunks
- **Error (❌)**: Something went wrong - try re-uploading

### Removing Documents
- Click the **trash icon** (🗑️) next to any document
- Confirm removal when prompted
- Document will be immediately removed from chat context

## Advanced Settings

### Embedding Settings
Fine-tune how documents are processed and searched:

**Embedding Model**
- The AI model used to understand document content
- Default: `nomic-embed-text` (good balance of speed and quality)
- Requires Ollama to be running locally

**Chunk Size**
- How much text is processed at once
- Default: 1000 characters
- Larger = more context, slower processing
- Smaller = faster processing, less context

**Chunk Overlap**
- How much text overlaps between chunks
- Default: 200 characters
- Prevents important information from being split

**Similarity Threshold**
- How closely related content must be to your question
- Default: 0.3 (lower = more results included)
- Higher values = more precise but fewer results
- Lower values = more results but potentially less relevant

### Regenerating Embeddings
If you change embedding settings:
1. Click **Regenerate Embeddings**
2. Wait for all documents to be reprocessed
3. Settings will apply to all future searches

## Supported File Types

| Format | Extension | Notes |
|--------|-----------|-------|
| PDF | `.pdf` | Most common document format |
| Text | `.txt` | Plain text files |
| Word | `.docx` | Microsoft Word documents |
| Markdown | `.md` | Formatted text files |

*More formats coming soon!*

## Tips for Best Results

### Document Quality
- **Clean text**: Documents with clear, readable text work best
- **Good structure**: Headers and sections help the AI understand context
- **Avoid scanned images**: Text in images isn't processed yet

### Asking Questions
- **Be specific**: "What budget was allocated for marketing?" vs "What about money?"
- **Use document language**: If your document uses specific terms, use them in questions
- **Ask follow-ups**: Build on previous answers with more detailed questions

### Managing Many Documents
- **Organize by topic**: Group related documents together
- **Use descriptive filenames**: Helps you remember what each document contains
- **Remove old documents**: Keep only what you need for better performance

## Troubleshooting

### Documents Not Processing
**Problem**: Document stuck in "Processing" status
**Solutions**:
- Wait a few minutes (large documents take time)
- Check that Ollama is running locally
- Try re-uploading the document
- Check the browser console for errors

### Poor Search Results
**Problem**: AI doesn't find relevant information
**Solutions**:
- Lower the similarity threshold in settings
- Try rephrasing your question
- Use keywords that appear in your document
- Check if the document processed correctly

### Embedding Errors
**Problem**: "Error" status on documents
**Solutions**:
- Ensure Ollama is running with the embedding model
- Check if the document file is corrupted
- Try a different file format
- Look at browser console for specific error messages

### Performance Issues
**Problem**: Slow responses or processing
**Solutions**:
- Reduce chunk size in settings
- Remove unused documents
- Ensure Ollama has sufficient system resources
- Consider using a faster embedding model

## Privacy & Security

- **Local Processing**: Documents are processed on your computer
- **No Cloud Upload**: Files never leave your machine unless you use cloud AI services
- **Temporary Storage**: Document chunks are stored locally and can be deleted anytime
- **No Tracking**: Your documents and questions are completely private

## Technical Details

For developers and advanced users:

### How It Works
1. **Document Upload**: Files are uploaded to the local backend
2. **Text Extraction**: Content is extracted from various file formats
3. **Chunking**: Text is split into overlapping segments
4. **Embedding**: Each chunk gets a vector representation using Ollama
5. **Storage**: Embeddings are stored locally in JSON files
6. **Search**: When you ask a question, it's compared against all chunks
7. **Context**: Most relevant chunks are included in the AI response

### Storage Location
- Documents: `backend/documents.json`
- Embeddings: `backend/document-chunks.json`
- Settings: `backend/preferences.json`

### API Endpoints
- `POST /api/documents/upload` - Upload documents
- `GET /api/documents` - List documents  
- `DELETE /api/documents/:id` - Remove document
- `POST /api/documents/regenerate-embeddings` - Reprocess all documents
- `GET /api/documents/embedding-status` - Check processing status

---

## Need Help?

- **General Issues**: Check the [Troubleshooting Guide](./06-TROUBLESHOOTING.md)
- **Quick Start**: See the [Quick Start Guide](./01-QUICK_START.md)
- **Keyboard Shortcuts**: View [Keyboard Shortcuts](./04-KEYBOARD_SHORTCUTS.md)

---

*Happy document chatting! 📄✨*
