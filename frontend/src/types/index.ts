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

export interface Artifact {
  id: string;
  type:
    | 'html'
    | 'react'
    | 'svg'
    | 'mermaid'
    | 'chart'
    | 'code'
    | 'text'
    | 'json';
  title: string;
  content: string;
  language?: string; // For code artifacts
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
  images?: string[]; // Base64 encoded images for multimodal support
  statistics?: GenerationStatistics; // Generation statistics from Ollama
  artifacts?: Artifact[]; // Artifacts associated with this message
  // Branching support
  parentId?: string; // ID of the original message this is a variant of
  branchIndex?: number; // Index within branch group (0 = original)
  isActive?: boolean; // Whether this is the active variant
  siblingCount?: number; // Total number of variants (including this one)
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  model: string;
  createdAt: number;
  updatedAt: number;
  personaId?: string;
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
  // Persona-specific fields
  isPersona?: boolean;
  personaName?: string;
  personaDescription?: string;
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
  mode: 'light' | 'dark' | 'ophelia';
}

export interface TTSSettings {
  enabled: boolean;
  autoPlay: boolean;
  model: string;
  voice: string;
  speed: number;
  pluginId?: string;
}

export interface ImageGenSettings {
  enabled: boolean;
  model: string;
  size: string;
  quality: string;
  style: string;
  pluginId?: string;
}

export interface TitleSettings {
  autoTitle: boolean;
  taskModel: string;
}

export interface UserPreferences {
  theme: Theme;
  defaultModel: string;
  systemMessage: string;
  generationOptions: GenerationOptions;
  embeddingSettings: {
    enabled: boolean;
    model: string;
    chunkSize: number;
    chunkOverlap: number;
    similarityThreshold: number;
  };
  ttsSettings?: TTSSettings;
  imageGenSettings?: ImageGenSettings;
  titleSettings?: TitleSettings;
  showUsername: boolean; // If true, show username in chat; if false, show "you"
  backgroundSettings?: {
    enabled: boolean;
    imageUrl: string;
    blurAmount: number;
    opacity: number;
  };
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
  type: 'completion' | 'embedding' | 'chat' | 'tts' | 'image';
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

// Document and RAG types
export interface DocumentSummary {
  id: string;
  filename: string;
  fileType: 'pdf' | 'txt';
  size: number;
  sessionId?: string;
  uploadedAt: number;
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  filename?: string; // Added for context in search results
  embedding?: number[]; // Vector embedding for semantic search
}

// User and Authentication types
export interface User {
  id: string;
  username: string;
  email: string | null;
  role: 'admin' | 'user';
  avatar?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserCreateRequest {
  username: string;
  email: string;
  password: string;
  role: 'admin' | 'user';
  avatar?: string | null;
}

export interface UserUpdateRequest {
  username?: string;
  email?: string | null;
  password?: string;
  role?: 'admin' | 'user';
  avatar?: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: User;
  token: string;
  systemInfo: SystemInfo;
}

export interface SystemInfo {
  requiresAuth: boolean;
  singleUserMode: boolean;
  hasUsers: boolean;
  version?: string;
}

// Embedding system types
export interface EmbeddingStatus {
  available: boolean;
  model: string;
  chunksWithEmbeddings: number;
  totalChunks: number;
}

// === Persona Types ===

export interface PersonaParameters {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  context_window?: number;
  max_tokens?: number;
  system_prompt?: string;
  repeat_penalty?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
}

// Shared type for advanced persona features to reduce duplication
export interface AdvancedFeatures {
  embedding_model?: string;
  memory_settings?: {
    enabled: boolean;
    max_memories: number;
    auto_cleanup: boolean;
    retention_days: number;
  };
  mutation_settings?: {
    enabled: boolean;
    sensitivity: 'low' | 'medium' | 'high';
    auto_adapt: boolean;
  };
}

export interface Persona extends AdvancedFeatures {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  model: string;
  parameters: PersonaParameters;
  avatar?: string;
  background?: string;
  created_at: number;
  updated_at: number;
  is_favorite?: boolean;
  category?: string;
  // Advanced features (unified from legacy system)
}

export interface CreatePersonaRequest extends AdvancedFeatures {
  name: string;
  description?: string;
  model: string;
  parameters: PersonaParameters;
  avatar?: string;
  background?: string;
  // Advanced features
}

export interface UpdatePersonaRequest extends Partial<AdvancedFeatures> {
  name?: string;
  description?: string;
  model?: string;
  parameters?: PersonaParameters;
  avatar?: string;
  background?: string;
  is_favorite?: boolean;
  category?: string;
  // Advanced features
}

export interface PersonaExport extends AdvancedFeatures {
  name: string;
  description?: string;
  model: string;
  params: PersonaParameters;
  avatar?: string;
  background?: string;
  exportedAt: number;
  version: string;
  // Advanced features (include in export/import)
}

// === Persona Development Framework - Advanced Types ===

export interface EmbeddingModel {
  id: string;
  name: string;
  description: string;
  provider: 'ollama' | 'openai' | 'sentence-transformers' | 'huggingface';
  dimensions: number;
}

export interface PersonaMemoryEntry {
  id: string;
  user_id: string;
  persona_id: string;
  content: string;
  embedding?: number[];
  timestamp: number;
  context?: string;
  importance_score?: number;
}

export interface MemorySearchResult {
  entry: PersonaMemoryEntry;
  similarity_score: number;
  relevance_rank: number;
}

export interface MemoryStatus {
  status: 'active' | 'wiped' | 'backed_up';
  memory_count: number;
  last_backup?: number;
  size_mb: number;
}

export interface PersonaDNA {
  persona: Persona;
  state: Record<string, unknown>;
  memories: PersonaMemoryEntry[];
  mutation_log: Record<string, unknown>[];
  export_metadata: {
    exported_at: number;
    user_id: string;
    version: string;
    checksum: string;
  };
}
