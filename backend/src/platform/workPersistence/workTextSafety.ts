/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/** PostgreSQL text cannot contain U+0000. Keep lossy substitutions visible. */
export const replaceWorkTextNul = (value: string): string =>
  value.split('\u0000').join('\uFFFD');
