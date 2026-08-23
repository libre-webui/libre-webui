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
  thinking_duration_ms?: number; // Wall-clock time of the reasoning phase
}

export interface Artifact {
  id: string;
  type:
    'html' | 'react' | 'svg' | 'mermaid' | 'chart' | 'code' | 'text' | 'json';
  title: string;
  content: string;
  language?: string; // For code artifacts
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinking?: string;
  timestamp: number;
  model?: string;
  providerMetadata?: Record<string, unknown>;
  images?: string[]; // Base64 encoded images for multimodal support
  statistics?: GenerationStatistics; // Generation statistics from Ollama
  artifacts?: Artifact[]; // Artifacts associated with this message
  // In-turn tool wire state used by the native tool loop. These fields are
  // never persisted as messages: a completed turn records its tool calls on
  // the final assistant message's providerMetadata instead.
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  // Branching support
  parentId?: string; // ID of the original message this is a variant of
  branchIndex?: number; // Index within branch group (0 = original)
  isActive?: boolean; // Whether this is the active variant
  siblingCount?: number; // Total number of variants (including this one)
  rating?: number; // User feedback: 1 = liked, -1 = disliked
}

/**
 * A provider-neutral tool definition offered to the model for one turn. Each
 * provider boundary lifts these out of the options and formats them the way
 * that provider expects.
 */
export interface ProviderToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type ChatProviderType = 'ollama' | 'plugin' | 'agent';

export interface ChatProviderSelection {
  providerType?: ChatProviderType | null;
  providerId?: string | null;
}

export interface ChatSession extends ChatProviderSelection {
  id: string;
  title: string;
  messages: ChatMessage[];
  model: string;
  createdAt: number;
  updatedAt: number;
  personaId?: string;
  archived?: boolean; // Hidden from the sidebar until unarchived
  settings?: ChatSessionSettings; // Per-chat overrides applied over global defaults
  folderId?: string | null; // Optional folder this chat lives in
  pinned?: boolean; // Kept in the sidebar's Pinned group
  /** Present when the session reaches the actor through a grant. */
  shared?: { ownerUserId: string; permission: 'read' | 'write' };
}

export interface KnowledgeCollection {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SessionFolder {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export type AutomationTrigger =
  | { kind: 'once'; at: number }
  | { kind: 'hourly'; minute: number; startHour?: number; endHour?: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; dayOfWeek: number; hour: number; minute: number }
  | { kind: 'monthly'; dayOfMonth: number; hour: number; minute: number }
  | {
      kind: 'yearly';
      month: number;
      dayOfMonth: number;
      hour: number;
      minute: number;
    };

export interface CalendarEvent {
  id: string;
  title: string;
  notes?: string;
  startAt: number;
  endAt?: number;
  allDay: boolean;
  recurrence?: AutomationTrigger;
  /** Named calendar this event belongs to; absent = the default calendar. */
  calendarId?: string;
  /** Minutes before the start when an in-app reminder should fire. */
  reminderMinutes?: number;
  /** Internal: occurrence start the reminder sweep last notified for. */
  lastRemindedOccurrence?: number;
  createdAt: number;
  updatedAt: number;
  /** Present on expanded occurrences of a recurring event. */
  baseEventId?: string;
}

export interface Calendar {
  id: string;
  name: string;
  color?: string;
  createdAt: number;
  updatedAt: number;
  /** Present when the calendar reaches the actor through a grant. */
  shared?: { ownerUserId: string; permission: 'read' | 'write' };
}

export type ChannelType = 'public' | 'private' | 'dm';
export type ChannelRole = 'owner' | 'member';

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  description?: string;
  createdBy?: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface ChannelSummary extends Channel {
  role?: ChannelRole;
  isMember: boolean;
  memberCount?: number;
  unreadCount?: number;
  latestMessageAt?: number | null;
  lastReadAt?: number;
  /** The other participant of a direct-message channel. */
  dmPeer?: { userId: string; username: string };
}

export interface ChannelMemberView {
  userId: string;
  username: string;
  role: ChannelRole;
  joinedAt: number;
}

export interface ChannelReactionView {
  emoji: string;
  count: number;
  /** Whether the requesting user has this reaction on the message. */
  mine: boolean;
}

export interface ChannelAttachmentView {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ChannelMessageView {
  id: string;
  channelId: string;
  parentId?: string;
  authorKind: 'user' | 'model';
  model?: string;
  author?: { userId: string; username: string } | null;
  content: string;
  createdAt: number;
  updatedAt: number;
  editedAt?: number;
  deleted?: boolean;
  pinnedAt?: number;
  replyCount?: number;
  reactions?: ChannelReactionView[];
  attachments?: ChannelAttachmentView[];
  /** Model-reply lifecycle state for @model messages. */
  pending?: boolean;
  error?: string;
}

export type NotificationType =
  | 'channel-mention'
  | 'channel-dm'
  | 'channel-invite'
  | 'share'
  | 'automation-failed'
  | 'calendar-reminder'
  | 'media-ready'
  | 'media-failed'
  | 'budget-alert'
  | 'system';

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body?: string;
  href?: string;
  createdAt: number;
  readAt?: number;
}

export interface WebhookTargetView {
  id: string;
  name: string;
  url: string;
  hasSecret: boolean;
  events: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AutomationNotify = 'app' | 'off';
export type AutomationStatus = 'active' | 'paused';
export type AutomationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed';
/** 'chat' runs a scheduled chat session; 'work' launches an isolated Work task. */
export type AutomationTarget = 'chat' | 'work';

export interface Automation {
  id: string;
  name: string;
  instructions: string;
  triggers: AutomationTrigger[];
  /** Null provider/model means Auto: resolve the default model at run time. */
  provider?: string;
  model?: string;
  notify: AutomationNotify;
  status: AutomationStatus;
  target: AutomationTarget;
  /** Named Work policy applied when the target is 'work'. */
  workPolicyId?: string;
  /** Existing Work task (agent) each fire runs inside; absent = new task per fire. */
  workTaskId?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  scheduledFor: number;
  startedAt?: number;
  finishedAt?: number;
  status: AutomationRunStatus;
  sessionId?: string;
  /** The Work task a 'work'-target run created. */
  workTaskId?: string;
  error?: string;
  seen: boolean;
  createdAt: number;
}

export interface PromptQueueEntry {
  id: string;
  content: string;
}

export interface ChatSessionSettings {
  generationOptions?: Partial<GenerationOptions>;
  knowledgeCollectionIds?: string[]; // Collections whose documents join this chat's context
  /** False opts this chat out of server-wide context compaction. */
  compaction?: boolean;
  /**
   * True sends the full extracted content of in-scope documents instead of
   * retrieved chunks, guarded by a token estimate.
   */
  fullDocumentContext?: boolean;
  /** Prompts queued while a generation runs, sent in order afterwards. */
  promptQueue?: PromptQueueEntry[];
  /** Provenance of a whole-chat fork. */
  forkedFrom?: {
    sessionId: string;
    messageId?: string;
    title?: string;
    forkedAt: number;
  };
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

  /**
   * How hard the model should think before answering. Unset leaves the choice
   * to the provider, and `null` is how a stored setting says "no preference".
   * This is not a sampling parameter: it is lifted out of the options at each
   * provider boundary and sent the way that provider expects.
   */
  think?: boolean | 'low' | 'medium' | 'high' | null;

  /**
   * Tools offered to the model for this call. Like `think`, this is not a
   * sampling parameter: it is lifted out at each provider boundary and never
   * forwarded inside provider option objects.
   */
  tools?: ProviderToolSpec[];
}

export interface EmbeddingSettings {
  enabled: boolean;
  model: string;
  chunkSize: number;
  chunkOverlap: number;
  similarityThreshold: number;
}

export interface TTSSettings {
  enabled: boolean;
  autoPlay: boolean;
  model: string;
  voice: string;
  voiceProfileId?: string;
  speed: number;
  pluginId?: string;
  streamSentences?: boolean; // Play sentence by sentence instead of full message
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
  taskProviderType?: ChatProviderType | null;
  taskProviderId?: string | null;
}

export interface UserPreferences {
  defaultModel: string;
  defaultProviderType?: ChatProviderType | null;
  defaultProviderId?: string | null;
  visionModel?: string;
  visionProviderType?: ChatProviderType | null;
  visionProviderId?: string | null;
  theme: {
    mode: 'light' | 'dark' | 'amoled' | 'ophelia';
    adaptToAccent?: boolean;
    accent?:
      | 'violet'
      | 'blue'
      | 'cyan'
      | 'teal'
      | 'emerald'
      | 'amber'
      | 'rose'
      | 'slate'
      | 'custom';
    customAccent?: string;
  };
  systemMessage: string;
  generationOptions: GenerationOptions;
  /**
   * Per-model overrides, keyed by model name. Anything set here wins over both
   * the global options above and what the model's own modelfile recommends.
   */
  modelGenerationOptions?: Record<string, Partial<GenerationOptions>>;
  // Embedding settings for semantic search
  embeddingSettings: EmbeddingSettings;
  // Text-to-speech settings
  ttsSettings?: TTSSettings;
  // Image-generation settings
  imageGenSettings?: ImageGenSettings;
  // Auto-title settings
  titleSettings?: TitleSettings;
  showUsername: boolean;
  showFollowUpSuggestions?: boolean; // Suggest follow-up messages after responses // If true, show username in chat; if false, show "you"
  autoOpenArtifactPanel?: boolean; // Open the artifact panel when a response generates one
  hapticFeedbackEnabled?: boolean; // Android Vibration API; unsupported platforms no-op
  workRemoteProviderDisclosureDismissed: boolean;
  backgroundSettings?: {
    enabled: boolean;
    imageUrl: string;
    blurAmount: number;
    opacity: number;
  };
}

// Ollama Chat Message format
export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  images?: string[];
  tool_calls?: Record<string, unknown>[];
  tool_name?: string;
  tool_call_id?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  tools?: Record<string, unknown>[];
  /** Ollama takes reasoning levels as strings for the models that name them. */
  think?: boolean | 'low' | 'medium' | 'high';
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
    thinking?: string;
    images?: string[] | null;
    tool_calls?: Record<string, unknown>[];
    providerMetadata?: Record<string, unknown>;
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
  think?: boolean | 'low' | 'medium' | 'high';
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
export type DocumentFileType =
  | 'pdf'
  | 'txt'
  | 'md'
  | 'html'
  | 'code'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'csv'
  | 'image'
  | 'audio';

export interface Document {
  id: string;
  filename: string;
  content: string;
  fileType: DocumentFileType;
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
  /** Source filename, attached on retrieval results. */
  filename?: string;
  /** Retrieval score (fused rank score or BM25), attached on results. */
  score?: number;
  /** Human-readable source location (page/slide/sheet/section). */
  location?: string;
}

// Plugin system types
export interface PluginAuthConfig {
  header: string; // e.g., "x-api-key", "Authorization"
  prefix?: string; // e.g., "Bearer ", "Token "
  key_env: string; // Environment variable name
}

// Unified plugin type supporting multiple capabilities
export type PluginType =
  | 'completion'
  | 'embedding'
  | 'chat'
  | 'tts'
  | 'stt'
  | 'image'
  | 'audio'
  | 'video';

// TTS-specific configuration
export interface TTSConfig {
  voices?: string[]; // Available voice options
  default_voice?: string; // Default voice to use
  formats?: string[]; // Supported audio formats (mp3, wav, opus, etc.)
  default_format?: string; // Default audio format
  max_characters?: number; // Maximum text length
  supports_streaming?: boolean; // Whether streaming is supported
  endpoint_variable?: string; // Capability-specific endpoint override variable
  models_endpoint_variable?: string; // Capability model-discovery endpoint override variable
  allows_custom_voice?: boolean; // Whether arbitrary provider voice IDs are accepted
  supports_voice_cloning?: boolean; // Whether reference-audio voice cloning is supported
  voice_clone_endpoint?: string; // Multipart voice-cloning endpoint
  voice_clone_endpoint_variable?: string; // Per-user voice-cloning endpoint override variable
  clone_requires_transcript?: boolean; // Whether reference_text must accompany the audio
  clone_audio_mime_types?: string[]; // Accepted reference-audio MIME types
  clone_max_audio_bytes?: number; // Maximum reference-audio upload size
  no_auth_required?: boolean; // Whether the capability can run without an API key
  request_variables?: string[]; // Allowlisted plugin variables forwarded to provider requests
}

// Image Generation-specific configuration
export interface ImageGenConfig {
  sizes?: string[]; // Available image sizes (e.g., "1024x1024", "1792x1024")
  default_size?: string; // Default size to use
  qualities?: string[]; // Available quality options (e.g., "standard", "hd")
  default_quality?: string; // Default quality
  styles?: string[]; // Available style options (e.g., "vivid", "natural")
  default_style?: string; // Default style
  max_prompt_length?: number; // Maximum prompt length
  supports_n?: boolean; // Whether multiple images can be requested
  max_n?: number; // Maximum number of images per request
  no_auth_required?: boolean; // Whether the capability can run without an API key
  endpoint_variable?: string; // Capability-specific endpoint override variable
  supports_response_format?: boolean; // Whether the API accepts response_format
  default_response_format?: 'url' | 'b64_json';
  size_parameter?: 'size' | 'aspect_ratio' | 'resolution';
  size_label?: string;
  omit_quality_when_empty?: boolean;
  /** OpenAI-compatible multipart edit/inpaint endpoint; presence enables editing. */
  edit_endpoint?: string;
  /** Whether the edit endpoint accepts a transparency mask for inpainting. */
  supports_mask?: boolean;
  /** Reference images accepted per edit request (compositing); default 1. */
  max_reference_images?: number;
  /** Accepted edit input MIME types; default PNG only. */
  edit_mime_types?: string[];
  /** Per-image input ceiling in bytes; capped by the global 10 MiB limit. */
  max_edit_image_bytes?: number;
}

export interface VideoGenConfig {
  resolutions?: string[];
  default_resolution?: string;
  aspect_ratios?: string[];
  default_aspect_ratio?: string;
  durations?: number[];
  default_duration?: number;
  supports_audio?: boolean;
  default_generate_audio?: boolean;
  max_prompt_length?: number;
  endpoint_variable?: string;
  poll_interval_ms?: number;
  timeout_ms?: number;
  /** Provider guarantees repeated Idempotency-Key submissions return one job. */
  supports_idempotency?: boolean;
  /** Optional provider operation for cancelling an accepted job. Use {job_id}. */
  cancel_endpoint?: string;
  cancel_method?: 'POST' | 'DELETE';
}

export interface AudioGenConfig {
  voices?: string[];
  default_voice?: string;
  formats?: string[];
  default_format?: string;
  max_prompt_length?: number;
  endpoint_variable?: string;
}

// Speech-to-text configuration. Providers either accept an OpenAI-compatible
// multipart upload or raw audio bytes at a model-qualified endpoint.
export interface STTConfig {
  formats?: string[];
  max_audio_bytes?: number;
  max_duration_seconds?: number;
  languages?: string[];
  supports_timestamps?: boolean;
  request_mode?: 'multipart' | 'raw';
  endpoint_variable?: string;
  models_endpoint_variable?: string;
  no_auth_required?: boolean;
}

// Embedding-specific configuration
export interface EmbeddingConfig {
  [key: string]: unknown;
  max_tokens?: number;
  dimensions?: Record<string, number>;
  no_auth_required?: boolean;
  endpoint_variable?: string; // Capability-specific endpoint override variable
}

// Plugin capabilities for multi-capability plugins
export interface PluginCapabilities {
  completion?: {
    endpoint: string;
    model_map: string[];
    models_endpoint?: string;
  };
  tts?: {
    endpoint: string;
    model_map: string[];
    models_endpoint?: string;
    config?: TTSConfig;
  };
  stt?: {
    endpoint: string;
    model_map: string[];
    models_endpoint?: string;
    config?: STTConfig;
  };
  embedding?: {
    endpoint: string;
    model_map: string[];
    config?: EmbeddingConfig;
  };
  image?: {
    endpoint: string;
    model_map: string[];
    models_endpoint?: string;
    config?: ImageGenConfig;
  };
  audio?: {
    endpoint: string;
    model_map: string[];
    models_endpoint?: string;
    config?: AudioGenConfig;
  };
  video?: {
    endpoint: string;
    model_map: string[];
    models_endpoint?: string;
    config?: VideoGenConfig;
  };
}

export type PluginApiMode = 'chat_completions' | 'responses';

export type PluginVariableType = 'string' | 'number' | 'boolean' | 'select';

export interface PluginVariableDefinition {
  name: string;
  type: PluginVariableType;
  label: string;
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  sensitive?: boolean;
  options?: string[]; // for 'select' type
  min?: number; // for 'number' type
  max?: number; // for 'number' type
}

export interface Plugin {
  id: string;
  name: string;
  type: PluginType; // Primary type for backward compatibility
  endpoint: string; // Primary endpoint for backward compatibility
  api_mode?: PluginApiMode; // Request/response protocol for OpenAI-compatible providers
  base_url?: string; // Optional API root combined with api_path
  api_path?: string; // Optional path relative to base_url
  auth: PluginAuthConfig;
  model_map: string[]; // Primary model map for backward compatibility
  /**
   * Context window per model, for the providers that publish one with their
   * model listing. Absent for models that report nothing, which is not the
   * same as a model with no context.
   */
  model_context?: Record<string, number>;
  /**
   * Whether each model reasons, where the listing said or the model's name
   * places it in a known family. Absent means unknown, never "no".
   */
  model_reasoning?: Record<string, boolean>;
  capabilities?: PluginCapabilities; // Multi-capability support
  variables?: PluginVariableDefinition[];
  active?: boolean;
  created_at?: number;
  updated_at?: number;
}

// TTS Request/Response types
export interface TTSRequest {
  model: string;
  pluginId?: string;
  input: string;
  voice?: string;
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number; // 0.25 to 4.0
}

export interface TTSResponse {
  audio: Buffer;
  format: string;
  model: string;
  voice: string;
}

// Image Generation Request/Response types
export interface ImageGenRequest {
  model: string;
  pluginId: string;
  prompt: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number; // Number of images to generate
  response_format?: 'url' | 'b64_json';
}

export interface ImageGenResponse {
  images: Array<{
    url?: string;
    b64_json?: string;
    mime_type?: string;
    revised_prompt?: string;
  }>;
  model: string;
  pluginId?: string;
}

export interface VideoGenRequest {
  model: string;
  pluginId: string;
  prompt: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  generate_audio?: boolean;
}

export interface VideoGenResponse {
  model: string;
  pluginId: string;
  jobId: string;
  video: Buffer;
  mimeType: string;
  usage?: Record<string, unknown>;
}

// Generated image for gallery
export interface GeneratedImage {
  id: string;
  userId: string;
  prompt: string;
  model: string;
  imageData: string; // base64 data URL
  size?: string;
  quality?: string;
  createdAt: number;
}

export type GeneratedMediaKind = 'image' | 'video' | 'audio';

export interface GeneratedMedia {
  id: string;
  userId: string;
  kind: GeneratedMediaKind;
  prompt: string;
  model: string;
  pluginId?: string;
  mediaData: string;
  mimeType: string;
  size?: string;
  quality?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
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
  providerMetadata?: Record<string, unknown>;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_details?: unknown[];
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
        providerMetadata?: Record<string, unknown>;
      }>;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// User management types
export interface User {
  id: string;
  username: string;
  email?: string;
  password_hash?: string; // Optional for responses (never sent to client)
  role: 'admin' | 'user';
  avatar?: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserCreateRequest {
  username: string;
  email?: string;
  password: string;
  role?: 'admin' | 'user';
  avatar?: string | null;
}

export interface UserUpdateRequest {
  username?: string;
  email?: string;
  role?: 'admin' | 'user';
  avatar?: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: Omit<User, 'password_hash'>;
  token: string;
  refreshToken?: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ResetPasswordRequest {
  userId: string;
  newPassword: string;
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
  bindings?: PersonaBindings;
}

/**
 * Assistant-profile bindings: the resources a persona composes beyond its
 * model and generation parameters. Every id is revalidated against the
 * invoking user's effective permissions when the persona is used, never at
 * bind time alone.
 */
export interface PersonaBindings {
  knowledge_collection_ids?: string[];
  tool_server_ids?: string[];
  builtin_tools?: string[];
  skill_ids?: string[];
  prompt_id?: string;
  voice?: {
    plugin_id: string;
    voice: string;
  };
  /** Monotonic revision counter, incremented on every binding change. */
  version?: number;
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
  /** Present when the persona reaches the actor through a grant. */
  shared?: { ownerUserId: string; permission: 'read' | 'write' };
  // Advanced features (optional for unified interface)
}

export interface CreatePersonaRequest extends AdvancedFeatures {
  name: string;
  description?: string;
  model: string;
  parameters: PersonaParameters;
  avatar?: string;
  background?: string;
  // Advanced features (optional)
}

export interface UpdatePersonaRequest extends Partial<AdvancedFeatures> {
  name?: string;
  description?: string;
  model?: string;
  parameters?: PersonaParameters;
  avatar?: string;
  background?: string;
  // Advanced features (optional)
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
  rawModel?: string;
  isDetectedEmbedding?: boolean;
  pluginId?: string;
  pluginName?: string;
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

export interface PersonaState {
  persona_id: string;
  user_id: string;
  runtime_state: Record<string, unknown>;
  mutation_log: PersonaMutation[];
  last_updated: number;
  version: number;
}

export interface PersonaMutation {
  id: string;
  timestamp: number;
  type: 'memory_add' | 'memory_update' | 'state_change' | 'parameter_adjust';
  description: string;
  changes: Record<string, unknown>;
  triggered_by?: string; // user input or system event
}

export interface MemorySearchResult {
  entry: PersonaMemoryEntry;
  similarity_score: number;
  relevance_rank: number;
}

export interface MutationEngineResult {
  state_deltas: Record<string, unknown>;
  new_memories: Omit<PersonaMemoryEntry, 'id' | 'timestamp'>[];
  updated_memories: { id: string; updates: Partial<PersonaMemoryEntry> }[];
  mutations: Omit<PersonaMutation, 'id' | 'timestamp'>[];
}

export interface PersonaBackup {
  persona: Persona;
  state: PersonaState;
  memories: PersonaMemoryEntry[];
  created_at: number;
  version: string;
}

export interface PersonaDNA {
  persona: Persona;
  state: PersonaState;
  memories: PersonaMemoryEntry[];
  mutation_log: PersonaMutation[];
  export_metadata: {
    exported_at: number;
    user_id: string;
    version: string;
    checksum: string;
  };
}

export interface MemoryStatus {
  status: 'active' | 'wiped' | 'backed_up';
  memory_count: number;
  last_backup?: number;
  size_mb: number;
}

// Note: Legacy interfaces have been merged into the main Persona interface with optional advanced features
