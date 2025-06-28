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

export interface OllamaModel {
  name: string;
  model?: string;
  size: number;
  digest: string;
  modified_at: string;
  expires_at?: string;
  size_vram?: number;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  // Plugin-specific fields
  isPlugin?: boolean;
  pluginName?: string;
}

export interface GenerationOptions {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  num_predict?: number;
  stop?: string[];
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface WebSocketMessage {
  type:
    | 'connected'
    | 'user_message'
    | 'assistant_chunk'
    | 'assistant_complete'
    | 'error';
  data: unknown;
}

export interface Theme {
  mode: 'light' | 'dark';
}

export interface UserPreferences {
  theme: Theme;
  defaultModel: string;
  systemMessage: string;
  generationOptions: GenerationOptions;
}

// Additional types for API calls
export interface ChatGenerationOptions {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  num_predict?: number;
  stop?: string[];
  format?: string | Record<string, unknown>;
  tools?: Record<string, unknown>[];
  think?: boolean;
  keep_alive?: string;
}

export interface StreamingCallbacks {
  onMessage: (data: ChatMessage | { content: string; done?: boolean }) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

export interface SystemInfo {
  version?: string;
  models?: OllamaModel[];
  status?: string;
}

export interface ModelCreatePayload {
  name?: string; // For model name when creating
  model: string;
  modelfile?: string; // For Ollama modelfile content
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

export interface EmbeddingPayload {
  model: string;
  input?: string | string[];
  prompt?: string; // Legacy embedding API support
  truncate?: boolean;
  options?: Record<string, unknown>;
  keep_alive?: string;
}

export interface EmbeddingResponse {
  embeddings: number[][];
}

export interface RunningModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details?: Record<string, unknown>;
  expires_at?: string;
  size_vram?: number;
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
