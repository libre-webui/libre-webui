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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
  images?: string[]; // Base64 encoded images for multimodal support
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserPreferences {
  defaultModel: string;
  theme: 'light' | 'dark';
  systemMessage: string;
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
