/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** Public account registration is enabled unless explicitly disabled. */
export const isPublicRegistrationEnabled = (
  value: string | undefined = process.env.ENABLE_SIGNUP
): boolean => value?.trim().toLowerCase() !== 'false';

/** A fresh instance must always permit creation of its first administrator. */
export const canCreateLocalAccount = (
  userCount: number,
  registrationEnabled = isPublicRegistrationEnabled()
): boolean => userCount === 0 || registrationEnabled;
