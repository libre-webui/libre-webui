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

export interface GenerationStatistics {
  total_duration?: number; // Total time in nanoseconds
  load_duration?: number; // Model load time in nanoseconds
  prompt_eval_count?: number; // Number of tokens in the prompt
  prompt_eval_duration?: number; // Time spent evaluating prompt in nanoseconds
  eval_count?: number; // Number of tokens generated
  eval_duration?: number; // Time spent generating in nanoseconds
  tokens_per_second?: number; // Calculated tokens/second
  created_at?: string; // Timestamp from Ollama
  model?: string; // Model used for generation
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
  images?: string[]; // Base64 encoded images for multimodal support
  statistics?: GenerationStatistics; // Generation statistics from Ollama
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface GenerationOptions {
  // Core parameters
  temperature?: number; // 0.0-2.0, default 0.8
  top_p?: number; // 0.0-1.0, default 0.9
  top_k?: number; // 1-100, default 40
  min_p?: number; // 0.0-1.0, default 0.0
  typical_p?: number; // 0.0-1.0, default 0.7

  // Generation control
  num_predict?: number; // Number of tokens to predict, default 128
  seed?: number; // Random seed for reproducible outputs
  repeat_last_n?: number; // How far back to look for repetition, default 64
  repeat_penalty?: number; // Penalty for repetition, default 1.1
  presence_penalty?: number; // Penalty for token presence, default 0.0
  frequency_penalty?: number; // Penalty for token frequency, default 0.0
  penalize_newline?: boolean; // Penalize newlines, default true

  // Context and processing
  num_ctx?: number; // Context window size, default 2048
  num_batch?: number; // Batch size for processing, default 512
  num_keep?: number; // Number of tokens to keep from prompt

  // Advanced options
  stop?: string[]; // Stop sequences
  numa?: boolean; // Enable NUMA support
  num_thread?: number; // Number of threads to use
  num_gpu?: number; // Number of GPU layers
  main_gpu?: number; // Main GPU to use
  use_mmap?: boolean; // Use memory mapping

  // Model behavior
  format?: string | Record<string, unknown>; // Response format (json, etc.)
  raw?: boolean; // Skip prompt templating
  keep_alive?: string; // Keep model in memory duration
  stream?: boolean; // Enable streaming
}

export interface UserPreferences {
  defaultModel: string;
  theme: 'light' | 'dark';
  systemMessage: string;
  generationOptions: GenerationOptions;
  // Embedding settings for semantic search
  embeddingSettings: {
    enabled: boolean;
    model: string;
    chunkSize: number;
    chunkOverlap: number;
    similarityThreshold: number;
  };
}

// Ollama Chat Message format
export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  images?: string[];
  tool_calls?: Record<string, unknown>[];
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  tools?: Record<string, unknown>[];
  think?: boolean;
  format?: string | Record<string, unknown>;
  options?: Record<string, unknown>;
  stream?: boolean;
  keep_alive?: string;
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
    images?: string[] | null;
    tool_calls?: Record<string, unknown>[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaBlobRequest {
  digest: string;
}

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    num_predict?: number;
    stop?: string[];
  };
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaShowRequest {
  model: string;
  verbose?: boolean;
}

export interface OllamaCreateRequest {
  model: string;
  from?: string;
  files?: Record<string, string>;
  adapters?: Record<string, string>;
  template?: string;
  license?: string | string[];
  system?: string;
  parameters?: Record<string, unknown>;
  messages?: Record<string, unknown>[];
  stream?: boolean;
  quantize?: string;
}

export interface OllamaCopyRequest {
  source: string;
  destination: string;
}

export interface OllamaPushRequest {
  model: string;
  insecure?: boolean;
  stream?: boolean;
}

export interface OllamaEmbeddingsRequest {
  model: string;
  input: string | string[];
  truncate?: boolean;
  options?: Record<string, unknown>;
  keep_alive?: string;
}

export interface OllamaEmbeddingsResponse {
  embeddings: number[][];
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface OllamaLegacyEmbeddingsRequest {
  model: string;
  prompt: string;
  options?: Record<string, unknown>;
  keep_alive?: string;
}

export interface OllamaLegacyEmbeddingsResponse {
  embedding: number[];
}

// Document and RAG types
export interface Document {
  id: string;
  filename: string;
  content: string;
  fileType: 'pdf' | 'txt';
  size: number;
  sessionId?: string;
  uploadedAt: number;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  // Add embedding vector for semantic search
  embedding?: number[];
}

// Plugin system types
export interface PluginAuthConfig {
  header: string; // e.g., "x-api-key", "Authorization"
  prefix?: string; // e.g., "Bearer ", "Token "
  key_env: string; // Environment variable name
}

export interface Plugin {
  id: string;
  name: string;
  type: 'completion' | 'embedding' | 'chat';
  endpoint: string;
  auth: PluginAuthConfig;
  model_map: string[];
  active?: boolean;
  created_at?: number;
  updated_at?: number;
}

export interface PluginStatus {
  id: string;
  active: boolean;
  available: boolean;
  last_used?: number;
}

export interface PluginRequest {
  plugin_id: string;
  model: string;
  messages: ChatMessage[];
  options?: GenerationOptions;
}

export interface PluginResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Helper function to extract error message from unknown error
export const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = error as { response?: { data?: { error?: string } } };
    if (response.response?.data?.error) {
      return response.response.data.error;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
};
