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

/**
 * Get the API base URL using consistent logic across the application
 */
export const getApiBaseUrl = (): string => {
  return (
    import.meta.env.VITE_API_BASE_URL ||
    `${window.location.protocol}//${window.location.hostname}:3001/api`
  );
};

/**
 * API base URL constant - use this instead of duplicating the logic
 */
export const API_BASE_URL = getApiBaseUrl();

/**
 * Log configuration information for debugging
 */
export const logConfigInfo = (): void => {
  console.log('🚀 API_BASE_URL configured as:', API_BASE_URL);
  console.log('🌐 Window location:', window.location);
  console.log('🔧 Environment variables:', import.meta.env);
};
