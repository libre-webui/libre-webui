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

import dotenv from 'dotenv';
import path from 'node:path';
import { BACKEND_DIRECTORY } from './utils/dataDirectory.js';

// Development configuration lives at backend/.env regardless of launch cwd.
// A root .env remains a lower-priority compatibility source for root scripts;
// neither file overrides variables explicitly supplied by the operator.
dotenv.config({
  path: [
    path.join(BACKEND_DIRECTORY, '.env'),
    path.join(BACKEND_DIRECTORY, '..', '.env'),
  ],
  quiet: true,
});

// Export a flag to confirm env is loaded
export const ENV_LOADED = true;
