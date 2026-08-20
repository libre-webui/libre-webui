---
sidebar_position: 1
title: 'Document Chat (RAG)'
description: 'Upload PDF, Office, Markdown, HTML, code, and CSV files, search them, and include relevant context in Libre WebUI chats.'
slug: /RAG_FEATURE
keywords:
  [libre webui rag, document chat, pdf chat, semantic search, vector embeddings]
image: /img/social/09.png
---

# Document Chat

Document Chat lets Libre WebUI search uploaded documents and pass relevant excerpts into chat context.

## Supported Files

Current upload support:

- PDF (with per-page provenance)
- Plain text and logs
- Markdown (`.md`, `.markdown`, `.mdx`, with per-section provenance)
- HTML
- Word documents (`.docx`)
- Presentations (`.pptx`, with per-slide provenance)
- Spreadsheets (`.xlsx`, with per-sheet provenance) and CSV/TSV
- Source code (TypeScript, Python, Go, Rust, SQL, YAML, and other common languages)
- Maximum file size: 10 MB

Office formats are unpacked with a bounded in-repo parser — no third-party
document library runs in the server process. Re-uploading identical bytes
into the same scope is deduplicated instead of ingested twice. Scanned
images/OCR and audio transcription are not supported yet; they are planned
alongside the media phase of the roadmap.

Files are processed by the backend and stored with the rest of the application data.

## Search Modes

Libre WebUI supports two retrieval modes:

| Mode            | When used                      | Notes                                                                       |
| --------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Keyword search  | Always available               | BM25 ranking; no embedding model required                                   |
| Hybrid search   | Embeddings enabled in Settings | Fuses the vector ranking with BM25 through reciprocal-rank fusion           |

With embeddings enabled, every query runs both rankings and merges them:
an exact term match can outrank a semantically similar but vaguer chunk,
and chunks whose embeddings are still being generated stay reachable
through the lexical side. If embeddings fail or are disabled, document
search falls back to pure keyword matching.

Lexical scoring runs in-process over the chunks you can access. Libre
deliberately does not maintain an on-disk full-text index for document
chunks, because chunk text is stored encrypted and a token index would
persist plaintext next to the ciphertext. A chunk only qualifies for the
lexical ranking when it fully contains at least one word of the query, so
a compound identifier such as `ALPHA_BETA_GAMMA` never surfaces text that
merely shares one of its fragments.

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

## Citations and Full-Document Mode

Retrieved excerpts carry provenance: the source filename, the chunk index,
the retrieval score, and — for formats with a segment map — the page, slide,
sheet, or Markdown section the excerpt came from. The chat context labels
each excerpt with that location, and the conversation's Sources rail lists
the cited locations under each document.

Each chat can also switch to **full-document mode** from the Sources rail.
Instead of retrieved excerpts, the entire extracted content of every
in-scope document is sent with the message. A token guard
(`FULL_DOCUMENT_CONTEXT_MAX_TOKENS`, default 32000) protects the model's
context window: when the attached documents exceed it, the chat falls back
to retrieval and the Sources rail explains why.

## Upload and Search

1. Upload a supported file from the document controls.
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
| `POST /api/documents/upload`                | Upload a supported document       |
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
