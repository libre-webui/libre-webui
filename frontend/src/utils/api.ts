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
export { authApi, usersApi } from './api/authApi';
export { chatApi } from './api/chatApi';
export { documentsApi, embeddingApi } from './api/documentsApi';
export { huggingfaceHubApi } from './api/huggingfaceHubApi';
export type { GgufFileInfo, HuggingFaceModel } from './api/huggingfaceHubApi';
export { imageGenApi } from './api/imageGenApi';
export type {
  ImageGenModel,
  ImageGenPlugin,
  ImageGenRequest,
  ImageGenResponse,
} from './api/imageGenApi';
export { ollamaApi } from './api/modelApi';
export { personaApi } from './api/personaApi';
export { pluginApi } from './api/pluginApi';
export type { PluginVariableValue } from './api/pluginApi';
export { preferencesApi } from './api/preferencesApi';
export { ttsApi } from './api/ttsApi';
export type {
  TTSGenerateBase64Response,
  TTSGenerateRequest,
  TTSModel,
  TTSPlugin,
} from './api/ttsApi';
