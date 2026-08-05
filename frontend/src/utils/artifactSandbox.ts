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

import { API_BASE_URL } from '@/utils/config';

/**
 * Backend document that hosts HTML artifact previews. Loading it over the
 * network is the point: an `srcdoc` frame inherits the application's Content
 * Security Policy, which forbids the inline scripts artifacts are made of,
 * while a fetched document carries the sandbox policy this route sets instead.
 *
 * Kept apart from `artifactHtml` so that module stays free of build-time
 * environment access and can be unit tested under plain Node.
 */
export const ARTIFACT_SANDBOX_URL = `${API_BASE_URL.replace(/\/+$/, '')}/artifacts/sandbox`;

/**
 * Origin serving the vendored artifact runtime. It ships with the frontend
 * build, so it is the page's own origin — except in the desktop build, which
 * loads the page from `file://` and reaches the runtime through the backend
 * that serves that same build.
 */
export const ARTIFACT_RUNTIME_ORIGIN =
  window.location.protocol === 'file:'
    ? new URL(ARTIFACT_SANDBOX_URL).origin
    : window.location.origin;
