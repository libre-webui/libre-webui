/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { POSTGRES_DURABLE_JOBS_EVENTS_MIGRATION } from '../platform/jobs/postgresDurableJobMigration.js';
import { POSTGRES_DURABLE_EVENT_IDEMPOTENCY_MIGRATION } from '../platform/jobs/postgresDurableEventIdempotencyMigration.js';
import { POSTGRES_DURABLE_EVENT_REPLAY_INDEX_MIGRATION } from '../platform/jobs/postgresDurableEventReplayIndexMigration.js';
import {
  POSTGRES_BLOB_MIGRATION,
  POSTGRES_VECTOR_MIGRATION,
} from '../platform/storage/storageSchemaContracts.js';
import { POSTGRES_RESOURCE_DELETION_LIFECYCLE_MIGRATION } from '../platform/storage/postgresResourceDeletionLifecycleMigration.js';
import { POSTGRES_WORK_PERSISTENCE_MIGRATION } from '../platform/workPersistence/postgresWorkMigration.js';
import { POSTGRES_WORK_LIFECYCLE_MIGRATION } from '../platform/workPersistence/postgresWorkLifecycleMigration.js';
import { POSTGRES_WORK_MESSAGE_CONTENT_MIGRATION } from '../platform/workPersistence/postgresWorkMessageContentMigration.js';
import { POSTGRES_CORE_MIGRATION } from './postgresCoreMigration.js';
import { POSTGRES_EXTENSION_MIGRATION } from './postgresExtensionMigration.js';
import { POSTGRES_PLUGIN_DEFINITION_MIGRATION } from './postgresPluginDefinitionMigration.js';
import { POSTGRES_TRUST_FOUNDATION_MIGRATION } from './postgresTrustFoundationMigration.js';
import { POSTGRES_PERSONAL_AUTOMATIONS_MIGRATION } from './postgresPersonalAutomationsMigration.js';
import { POSTGRES_AGENT_FOUNDATION_MIGRATION } from './postgresAgentFoundationMigration.js';
import { POSTGRES_SKILL_FILES_MIGRATION } from './postgresSkillFilesMigration.js';
import { POSTGRES_NOTES_V2_MIGRATION } from './postgresNotesV2Migration.js';
import type { PostgresMigration } from './postgresMigrationTypes.js';
import { validatePostgresMigrationRegistry } from './postgresMigrations.js';

/** Ordered, immutable schema contract consumed by every PostgreSQL replica. */
export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] =
  validatePostgresMigrationRegistry(
    Object.freeze(
      [
        POSTGRES_CORE_MIGRATION,
        POSTGRES_BLOB_MIGRATION,
        POSTGRES_VECTOR_MIGRATION,
        POSTGRES_DURABLE_JOBS_EVENTS_MIGRATION,
        POSTGRES_EXTENSION_MIGRATION,
        POSTGRES_WORK_PERSISTENCE_MIGRATION,
        POSTGRES_PLUGIN_DEFINITION_MIGRATION,
        POSTGRES_WORK_LIFECYCLE_MIGRATION,
        POSTGRES_DURABLE_EVENT_IDEMPOTENCY_MIGRATION,
        POSTGRES_RESOURCE_DELETION_LIFECYCLE_MIGRATION,
        POSTGRES_WORK_MESSAGE_CONTENT_MIGRATION,
        POSTGRES_DURABLE_EVENT_REPLAY_INDEX_MIGRATION,
        POSTGRES_TRUST_FOUNDATION_MIGRATION,
        POSTGRES_PERSONAL_AUTOMATIONS_MIGRATION,
        POSTGRES_AGENT_FOUNDATION_MIGRATION,
        POSTGRES_SKILL_FILES_MIGRATION,
        POSTGRES_NOTES_V2_MIGRATION,
      ].map(migration => Object.freeze({ ...migration }))
    )
  );
