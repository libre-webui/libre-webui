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
 * Shared telemetry redaction, used by both structured logs and the
 * OpenTelemetry exporter. Any key that looks like it could carry a
 * credential is dropped outright, and prompt-sized strings are truncated so
 * conversational content cannot ride along in operational telemetry.
 */
const SECRET_KEY_PATTERN =
  /pass(word)?|secret|token|key|authorization|cookie|credential|bearer|jwt/i;
const MAX_FIELD_STRING = 512;
const MAX_FIELD_DEPTH = 6;
const MAX_FIELD_ARRAY = 64;

export const redactLogFields = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_FIELD_DEPTH) return '[depth]';
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_STRING
      ? `${value.slice(0, MAX_FIELD_STRING)}…[truncated]`
      : value;
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value === undefined) return undefined;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactLogFields(value.message, depth + 1),
    };
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_FIELD_ARRAY)
      .map(item => redactLogFields(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      const redacted = redactLogFields(item, depth + 1);
      if (redacted !== undefined) result[key] = redacted;
    }
    return result;
  }
  return String(value);
};
