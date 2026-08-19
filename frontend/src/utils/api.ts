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

export { default, api } from './api/client';
export { agentCliApi } from './api/agentCliApi';
export type { AgentCliModel } from './api/agentCliApi';
export { authApi, usersApi, API_TOKEN_SCOPES } from './api/authApi';
export type {
  ApiTokenCreateResponse,
  ApiTokenRecord,
  ApiTokenScope,
  AuthSession,
} from './api/authApi';
export { adminSecurityApi } from './api/adminSecurityApi';
export type {
  AuditEvent,
  AuditQuery,
  EffectiveAccess,
  EffectiveAccessGrant,
  UserGroup,
  UserGroupMember,
} from './api/adminSecurityApi';
export { chatApi } from './api/chatApi';
export type { CompactionConfig } from './api/chatApi';
export { documentsApi, embeddingApi } from './api/documentsApi';
export { notesApi } from './api/notesApi';
export { calendarApi } from './api/calendarApi';
export { searchApi } from './api/searchApi';
export type { WebSearchConfigResponse } from './api/searchApi';
export { huggingfaceHubApi } from './api/huggingfaceHubApi';
export type { GgufFileInfo, HuggingFaceModel } from './api/huggingfaceHubApi';
export {
  findImageGenModel,
  findPreferredImagePlugin,
  getImageGenImageFileExtension,
  getImageGenImageSource,
  getImageGenModelOptionValue,
  imageGenApi,
  resolveImageGenOption,
  resolveImageGenModel,
} from './api/imageGenApi';
export type {
  ImageGenImage,
  ImageGenModel,
  ImageGenPlugin,
  ImageGenRequest,
  ImageGenResponse,
} from './api/imageGenApi';
export { libreClawApi } from './api/libreClawApi';
export { mediaApi } from './api/mediaApi';
export type {
  AudioGenModel,
  MediaModelCatalog,
  VideoGenerationJob,
  VideoGenModel,
} from './api/mediaApi';
export type {
  LibreClawAutomation,
  LibreClawEvent,
  LibreClawPermissionResolution,
  LibreClawRun,
  LibreClawRunState,
  LibreClawStartRunPayload,
  LibreClawStatus,
} from './api/libreClawApi';
export { ollamaApi, MODELS_CHANGED_EVENT } from './api/modelApi';
export { personaApi } from './api/personaApi';
export { pluginApi } from './api/pluginApi';
export type {
  PluginUsageAnalytics,
  PluginVariableValue,
} from './api/pluginApi';
export { preferencesApi } from './api/preferencesApi';
export { systemApi } from './api/systemApi';
export type { SystemDiagnostics } from './api/systemApi';
export { workApi } from './api/workApi';
export { ttsApi } from './api/ttsApi';
export { sttApi } from './api/sttApi';
export type { STTModel, STTTranscription } from './api/sttApi';
export type {
  TTSGenerateBase64Response,
  TTSGenerateRequest,
  TTSModel,
  TTSPlugin,
  TTSResponseFormat,
  TTSVoiceProfile,
} from './api/ttsApi';
export {
  findTTSModel,
  getTTSModelOptionValue,
  resolveTTSModel,
} from './api/ttsApi';
