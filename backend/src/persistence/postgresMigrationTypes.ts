/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/**
 * Immutable PostgreSQL schema change. Published migration SQL and checksums
 * must never be edited; append a new descriptor instead.
 */
export interface PostgresMigration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
  rollbackPlan: string;
  minimumCompatibleVersion: number;
}

export type PostgresMigrationMode = 'apply' | 'validate';

export type PostgresSchemaCompatibilityStatus =
  'uninitialized' | 'migrating' | 'compatible' | 'incompatible';

export interface PostgresSchemaCompatibility {
  dialect: 'postgres';
  status: PostgresSchemaCompatibilityStatus;
  currentVersion: number;
  targetVersion: number;
  minimumSupportedVersion: number;
  mixedVersionPolicy: 'exact-schema-version';
  reason?: string;
}
