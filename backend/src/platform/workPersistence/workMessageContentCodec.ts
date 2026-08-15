/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/**
 * PostgreSQL schema v11 stores every logical Work message string as JSON text.
 * JSON escaping represents U+0000 exactly; the schema ledger is the storage
 * format marker, so no content prefix or metadata heuristic is required.
 */
export const encodePostgresWorkMessageContent = (content: string): string =>
  JSON.stringify(content);

export const decodePostgresWorkMessageContent = (stored: string): string => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stored);
  } catch {
    throw new Error('Invalid PostgreSQL Work message content encoding');
  }
  if (typeof decoded !== 'string') {
    throw new Error('Invalid PostgreSQL Work message content encoding');
  }
  return decoded;
};
