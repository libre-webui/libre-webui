---
sidebar_position: 1
title: 'Document Chat (RAG)'
description: 'Upload PDF and plain-text files, search them, and include relevant context in Libre WebUI chats.'
slug: /RAG_FEATURE
keywords:
  [libre webui rag, document chat, pdf chat, semantic search, vector embeddings]
image: /img/social/09.png
---

# Document Chat

Document Chat lets Libre WebUI search uploaded documents and pass relevant excerpts into chat context.

## Supported Files

Current upload support:

- PDF
- Plain text
- Maximum file size: 10 MB

Files are processed by the backend and stored with the rest of the application data.

## Search Modes

Libre WebUI supports two retrieval modes:

| Mode            | When used                      | Notes                                                        |
| --------------- | ------------------------------ | ------------------------------------------------------------ |
| Keyword search  | Always available               | No embedding model required                                  |
| Semantic search | Embeddings enabled in Settings | Uses the configured embedding model and similarity threshold |

If embeddings fail or are disabled, document search falls back to keyword matching.

## Enable Semantic Search

Install an embedding model:

```bash
ollama pull nomic-embed-text
```

Then open Settings and enable embeddings. You can use local Ollama embedding models or embedding-capable provider plugins.

Default embedding settings:

- Model: `nomic-embed-text`
- Chunk size: 1000 characters
- Chunk overlap: 200 characters
- Similarity threshold: 0.3

## Upload and Search

1. Upload a PDF or text file from the document controls.
2. Wait for processing to finish.
3. Ask a question in chat.
4. Libre WebUI retrieves relevant chunks for that session and includes them as context.

Example prompts:

```text
Summarize the uploaded document in five bullets.
What deadlines are mentioned in the PDF?
Find the section that talks about pricing.
Compare the uploaded policy with this proposed change.
```

## API Endpoints

| Endpoint                                    | Purpose                           |
| ------------------------------------------- | --------------------------------- |
| `POST /api/documents/upload`                | Upload a PDF or text file         |
| `GET /api/documents`                        | List uploaded documents           |
| `GET /api/documents/session/:sessionId`     | List documents for a chat session |
| `POST /api/documents/search`                | Search documents                  |
| `DELETE /api/documents/:documentId`         | Delete a document                 |
| `GET /api/documents/embeddings/status`      | View embedding status             |
| `POST /api/documents/embeddings/regenerate` | Regenerate embeddings             |

## Best Practices

- Keep uploads focused on the current task.
- Use text-based PDFs when possible; scanned PDFs may have little extractable text.
- Regenerate embeddings after changing the embedding model.
- Lower the similarity threshold if semantic search misses useful context.
- Raise the threshold if results feel noisy.

## Related Docs

- [Working with Models](./WORKING_WITH_MODELS)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Troubleshooting](./TROUBLESHOOTING)
