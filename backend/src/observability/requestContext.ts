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

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation identifiers carried across one unit of work. HTTP requests get
 * a request id at the edge; durable job executions get their job id. The
 * logger and the security audit trail read this store at call time, so
 * correlation never depends on threading identifiers through every function
 * signature.
 */
export interface LogContext {
  requestId?: string;
  jobId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const runWithLogContext = <T>(context: LogContext, fn: () => T): T =>
  storage.run(context, fn);

export const currentLogContext = (): LogContext | undefined =>
  storage.getStore();
