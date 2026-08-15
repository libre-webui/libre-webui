/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { PostgresQueryExecutor } from './postgresDatabase.js';
import {
  POSTGRES_SQLITE_IMPORT_SCHEMA_SQL,
  SQLITE_IMPORT_TABLE,
  SQLITE_IMPORT_TABLE_STATE,
  SQLITE_STORAGE_IMPORT_TABLE,
} from './postgresImportState.js';
import type { PostgresMigration } from './postgresMigrationTypes.js';

/**
 * The migration ledger is application-owned schema too. Keep its DDL beside
 * the inspector so fresh creation and exact-shape validation cannot drift.
 */
export const POSTGRES_COORDINATOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS libre_schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL UNIQUE,
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  minimum_compatible_version integer NOT NULL,
  rollback_plan text NOT NULL,
  applied_at bigint NOT NULL,
  applied_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS libre_schema_compatibility (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  status text NOT NULL CHECK (status IN ('migrating', 'compatible', 'incompatible')),
  current_version integer NOT NULL CHECK (current_version >= 0),
  target_version integer NOT NULL CHECK (target_version >= 0),
  minimum_reader_version integer NOT NULL CHECK (minimum_reader_version >= 0),
  migration_owner text,
  failure_code text,
  schema_fingerprint char(64)
    CHECK (schema_fingerprint IS NULL OR schema_fingerprint ~ '^[0-9a-f]{64}$'),
  updated_at bigint NOT NULL
);

ALTER TABLE libre_schema_compatibility
  ADD COLUMN IF NOT EXISTS schema_fingerprint char(64)
  CHECK (schema_fingerprint IS NULL OR schema_fingerprint ~ '^[0-9a-f]{64}$');
`;

const POSTGRES_BOOTSTRAP_EXTENSIONS = ['plpgsql'] as const;

interface ExpectedColumn {
  table: string;
  name: string;
  type: string;
  notNull: boolean;
  defaultExpression: string | null;
  identityKind: string;
  generatedKind: string;
}

interface ExpectedKey {
  table: string;
  columns: string[];
}

interface ExpectedForeignKey extends ExpectedKey {
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
  matchType: string;
}

interface ExpectedCheck {
  table: string;
  expression: string;
}

interface ExpectedIndex {
  name: string;
  table: string;
  unique: boolean;
  accessMethod: string;
  columns: string;
  predicate: string | null;
}

interface ExpectedStructure {
  tables: string[];
  optionalTableGroups: string[][];
  columns: ExpectedColumn[];
  primaryKeys: ExpectedKey[];
  uniqueKeys: ExpectedKey[];
  foreignKeys: ExpectedForeignKey[];
  checks: ExpectedCheck[];
  indexes: ExpectedIndex[];
  triggers: Array<{ name: string; table: string }>;
  extensions: string[];
}

interface RelationRow extends QueryResultRow {
  table_name: string;
  relation_kind: string;
  persistence: string;
  row_security: boolean;
  force_row_security: boolean;
  extension_name: string | null;
  owned_table: string | null;
  owned_column: string | null;
  sequence_start: string | number | null;
  sequence_increment: string | number | null;
  sequence_minimum: string | number | null;
  sequence_maximum: string | number | null;
  sequence_cache: string | number | null;
  sequence_cycles: boolean | null;
}

interface ColumnRow extends QueryResultRow {
  table_name: string;
  column_name: string;
  data_type: string;
  not_null: boolean;
  default_expression: string | null;
  identity_kind: string;
  generated_kind: string;
  uses_default_collation: boolean;
}

interface ConstraintRow extends QueryResultRow {
  constraint_name: string;
  table_name: string;
  constraint_type: 'p' | 'u' | 'f' | 'c' | 'x';
  columns: string[] | null;
  referenced_schema: string | null;
  referenced_table: string | null;
  referenced_columns: string[] | null;
  delete_action: string | null;
  update_action: string | null;
  match_type: string | null;
  is_deferrable: boolean;
  is_initially_deferred: boolean;
  is_validated: boolean;
  check_expression: string | null;
}

interface IndexRow extends QueryResultRow {
  index_name: string;
  table_name: string;
  is_unique: boolean;
  is_valid: boolean;
  is_ready: boolean;
  is_clustered: boolean;
  is_replica_identity: boolean;
  nulls_not_distinct: boolean;
  access_method: string;
  definition: string;
  predicate: string | null;
  constraint_owned: boolean;
  extension_name: string | null;
}

interface TriggerRow extends QueryResultRow {
  trigger_name: string;
  table_name: string;
  definition: string;
}

export interface PostgresSchemaInspection {
  compatible: boolean;
  fingerprint: string;
  problems: string[];
}

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/["`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=<>])\s*/g, '$1')
    .trim();

const stripRedundantBooleanGrouping = (value: string): string => {
  let current = value;
  for (;;) {
    const stack: number[] = [];
    const pairs: Array<{ openAt: number; closeAt: number }> = [];
    let quoted = false;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] === "'") {
        if (quoted && current[index + 1] === "'") {
          index += 1;
        } else {
          quoted = !quoted;
        }
        continue;
      }
      if (quoted) continue;
      if (current[index] === '(') stack.push(index);
      else if (current[index] === ')') {
        const openAt = stack.pop();
        if (openAt !== undefined) pairs.push({ openAt, closeAt: index });
      }
    }

    const remove = new Set<number>();
    for (const { openAt, closeAt } of pairs) {
      const precedingWord = current
        .slice(0, openAt)
        .match(/([a-z0-9_]+)$/)?.[1];
      // Function calls, IN lists, casts, and type modifiers are structure.
      if (precedingWord && !['and', 'or', 'not'].includes(precedingWord)) {
        continue;
      }
      let depth = 0;
      let innerQuoted = false;
      let hasAnd = false;
      let hasOr = false;
      for (let index = openAt + 1; index < closeAt; index += 1) {
        if (current[index] === "'") {
          if (innerQuoted && current[index + 1] === "'") index += 1;
          else innerQuoted = !innerQuoted;
          continue;
        }
        if (innerQuoted) continue;
        if (current[index] === '(') {
          depth += 1;
          continue;
        }
        if (current[index] === ')') {
          depth -= 1;
          continue;
        }
        if (depth !== 0) continue;
        const remainder = current.slice(index);
        const operator = remainder.match(/^(and|or)\b/)?.[1];
        if (operator === 'and') hasAnd = true;
        if (operator === 'or') hasOr = true;
      }
      const wrapsExpression = openAt === 0 && closeAt === current.length - 1;
      // AND binds more tightly than OR, so a parenthesized AND chain is
      // redundant. An OR group nested in an AND chain is semantic and must be
      // preserved. PostgreSQL also sometimes wraps one atom after AND/OR.
      if (
        wrapsExpression ||
        (hasAnd && !hasOr) ||
        (!hasAnd &&
          !hasOr &&
          precedingWord !== undefined &&
          ['and', 'or', 'not'].includes(precedingWord))
      ) {
        remove.add(openAt);
        remove.add(closeAt);
      }
    }
    if (remove.size === 0) return current;
    const next = [...current]
      .map((character, index) => (remove.has(index) ? ' ' : character))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (next === current) return current;
    current = next;
  }
};

const normalizeExpression = (value: string): string => {
  const normalized = normalize(value)
    .replace(
      /::(?:double precision|text|character varying|character|bigint|integer)\b/g,
      ''
    )
    .replace(/'(-?[0-9]+(?:\.[0-9]+)?)'/g, '$1')
    .replace(/\s+asc\b/g, '')
    .replace(
      /\b([a-z0-9_.]+) between (-?[0-9]+(?:\.[0-9]+)?) and (-?[0-9]+(?:\.[0-9]+)?)/g,
      '$1>=$2 and $1<=$3'
    )
    .replace(/([a-z0-9_.]+)=any\(array\[([^\]]*)\]\)/g, '$1 in($2)');
  return stripRedundantBooleanGrouping(normalized);
};

const normalizeType = (value: string): string =>
  normalize(value)
    .replace(/ generated always as identity$/, '')
    .replace(/^char(?=\()/, 'character')
    .replace(/^varchar(?=\()/, 'character varying');

const splitTopLevel = (value: string): string[] => {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = value.slice(start).trim();
  if (final) parts.push(final);
  return parts;
};

const matchingParenthesis = (value: string, openAt: number): number => {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openAt; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index;
  }
  throw new Error('PostgreSQL migration contains an unbalanced definition');
};

const identifiers = (value: string): string[] =>
  splitTopLevel(value).map(identifier => normalize(identifier));

const deleteAction = (definition: string): string => {
  const match = definition.match(
    /\bon\s+delete\s+(cascade|set\s+null|set\s+default|restrict|no\s+action)\b/i
  );
  return normalize(match?.[1] ?? 'no action');
};

const updateAction = (definition: string): string => {
  const match = definition.match(
    /\bon\s+update\s+(cascade|set\s+null|set\s+default|restrict|no\s+action)\b/i
  );
  return normalize(match?.[1] ?? 'no action');
};

const foreignMatchType = (definition: string): string => {
  const match = definition.match(/\bmatch\s+(full|partial|simple)\b/i);
  return normalize(match?.[1] ?? 'simple');
};

const defaultExpression = (definition: string): string | null => {
  const match = definition.match(
    /\bdefault\s+([\s\S]*?)(?=\s+(?:not\s+null|null|primary\s+key|unique|references|check|constraint)\b|$)/i
  );
  return match ? normalizeExpression(match[1]!) : null;
};

const checkExpressions = (definition: string): string[] => {
  const expressions: string[] = [];
  const matcher = /\bcheck\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(definition))) {
    const openAt = definition.indexOf('(', match.index);
    const closeAt = matchingParenthesis(definition, openAt);
    expressions.push(
      normalizeExpression(definition.slice(openAt + 1, closeAt))
    );
    matcher.lastIndex = closeAt + 1;
  }
  return expressions;
};

const parseTableDefinition = (
  table: string,
  body: string,
  structure: ExpectedStructure
): void => {
  for (const item of splitTopLevel(body)) {
    const normalized = normalize(item);
    for (const expression of checkExpressions(item)) {
      structure.checks.push({ table, expression });
    }
    const primary = normalized.match(/^primary key\(([^)]+)\)/);
    if (primary) {
      structure.primaryKeys.push({ table, columns: identifiers(primary[1]!) });
      continue;
    }
    const unique = normalized.match(/^unique\(([^)]+)\)/);
    if (unique) {
      structure.uniqueKeys.push({ table, columns: identifiers(unique[1]!) });
      continue;
    }
    const foreign = normalized.match(
      /^foreign key\(([^)]+)\)references ([a-z0-9_]+)\(([^)]+)\)/
    );
    if (foreign) {
      structure.foreignKeys.push({
        table,
        columns: identifiers(foreign[1]!),
        referencedTable: foreign[2]!,
        referencedColumns: identifiers(foreign[3]!),
        onDelete: deleteAction(normalized),
        onUpdate: updateAction(normalized),
        matchType: foreignMatchType(normalized),
      });
      continue;
    }
    if (/^(constraint\s+\S+\s+)?check\(/.test(normalized)) continue;

    const column = item.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+([\s\S]+)$/);
    if (!column) throw new Error(`Unsupported PostgreSQL column in ${table}`);
    const name = normalize(column[1]!);
    const tail = column[2]!;
    const constraintAt = tail.search(
      /\s+(?:not\s+null|null|default|primary\s+key|unique|references|check)\b/i
    );
    const type = normalizeType(
      constraintAt === -1 ? tail : tail.slice(0, constraintAt)
    );
    const notNull = /\bnot\s+null\b|\bprimary\s+key\b/i.test(tail);
    structure.columns.push({
      table,
      name,
      type,
      notNull,
      defaultExpression: defaultExpression(tail),
      identityKind: /\bgenerated\s+always\s+as\s+identity\b/i.test(tail)
        ? 'a'
        : /\bgenerated\s+by\s+default\s+as\s+identity\b/i.test(tail)
          ? 'd'
          : '',
      generatedKind: /\bgenerated\s+always\s+as\s*\([\s\S]+\)\s+stored\b/i.test(
        tail
      )
        ? 's'
        : '',
    });
    if (/\bprimary\s+key\b/i.test(tail)) {
      structure.primaryKeys.push({ table, columns: [name] });
    }
    if (/\bunique\b/i.test(tail)) {
      structure.uniqueKeys.push({ table, columns: [name] });
    }
    const inlineForeign = normalize(tail).match(
      /\breferences ([a-z0-9_]+)\(([^)]+)\)/
    );
    if (inlineForeign) {
      structure.foreignKeys.push({
        table,
        columns: [name],
        referencedTable: inlineForeign[1]!,
        referencedColumns: identifiers(inlineForeign[2]!),
        onDelete: deleteAction(tail),
        onUpdate: updateAction(tail),
        matchType: foreignMatchType(tail),
      });
    }
  }
};

const extractBalancedStatements = (
  sql: string,
  expression: RegExp
): Array<{ match: RegExpExecArray; body: string; end: number }> => {
  const statements: Array<{
    match: RegExpExecArray;
    body: string;
    end: number;
  }> = [];
  expression.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(sql))) {
    const openAt = sql.indexOf('(', match.index + match[0].length - 1);
    const closeAt = matchingParenthesis(sql, openAt);
    statements.push({
      match,
      body: sql.slice(openAt + 1, closeAt),
      end: closeAt,
    });
    expression.lastIndex = closeAt + 1;
  }
  return statements;
};

const expectedStructure = (
  migrations: readonly PostgresMigration[]
): ExpectedStructure => {
  const structure: ExpectedStructure = {
    tables: [],
    optionalTableGroups: [
      [
        SQLITE_IMPORT_TABLE,
        SQLITE_IMPORT_TABLE_STATE,
        SQLITE_STORAGE_IMPORT_TABLE,
      ],
    ],
    columns: [],
    primaryKeys: [],
    uniqueKeys: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    triggers: [],
    extensions: [],
  };
  const schemaSources = [
    POSTGRES_COORDINATOR_SCHEMA_SQL,
    ...migrations.map(migration => migration.sql),
    POSTGRES_SQLITE_IMPORT_SCHEMA_SQL,
  ];
  for (const sql of schemaSources) {
    for (const statement of extractBalancedStatements(
      sql,
      /create\s+table(?:\s+if\s+not\s+exists)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi
    )) {
      const table = normalize(statement.match[1]!);
      if (structure.tables.includes(table)) continue;
      structure.tables.push(table);
      parseTableDefinition(table, statement.body, structure);
    }
    for (const statement of extractBalancedStatements(
      sql,
      /create\s+(unique\s+)?index(?:\s+if\s+not\s+exists)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+on\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+using\s+([a-zA-Z_][a-zA-Z0-9_]*))?\s*\(/gi
    )) {
      const suffix = sql.slice(statement.end + 1).match(/^\s*(where\s+[^;]+)/i);
      structure.indexes.push({
        name: normalize(statement.match[2]!),
        table: normalize(statement.match[3]!),
        unique: Boolean(statement.match[1]),
        accessMethod: normalize(statement.match[4] ?? 'btree'),
        columns: normalize(statement.body),
        predicate: suffix
          ? normalize(suffix[1]!.replace(/^where\s+/i, ''))
          : null,
      });
    }
    for (const match of sql.matchAll(
      /create\s+extension(?:\s+if\s+not\s+exists)?\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
    )) {
      structure.extensions.push(normalize(match[1]!));
    }
    for (const match of sql.matchAll(
      /create\s+(?:constraint\s+)?trigger\s+([a-zA-Z_][a-zA-Z0-9_]*)[\s\S]*?\bon\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
    )) {
      structure.triggers.push({
        name: normalize(match[1]!),
        table: normalize(match[2]!),
      });
    }

    // Later immutable migrations evolve existing tables. Apply their simple
    // ADD COLUMN / DROP CHECK / ADD CHECK declarations to the expected model
    // after parsing CREATE TABLE statements; otherwise exact inspection would
    // silently treat additive columns and replacement constraints as drift.
    for (const match of sql.matchAll(
      /alter\s+table\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+add\s+column\s+(?!if\s+not\s+exists)([a-zA-Z_][a-zA-Z0-9_]*)\s+([^;]+);/gi
    )) {
      const table = normalize(match[1]!);
      const before = structure.columns.length;
      parseTableDefinition(table, `${match[2]} ${match[3]}`, structure);
      if (structure.columns.length !== before + 1) {
        throw new Error(`Unsupported PostgreSQL ALTER COLUMN in ${table}`);
      }
    }
    for (const match of sql.matchAll(
      /alter\s+table\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+drop\s+constraint\s+([a-zA-Z_][a-zA-Z0-9_]*);/gi
    )) {
      const table = normalize(match[1]!);
      const constraint = normalize(match[2]!);
      // PostgreSQL names an unnamed inline column CHECK
      // <table>_<column>_check. Resolve that deterministic name so a later
      // migration can replace the constraint without mutating its origin.
      const prefix = `${table}_`;
      const suffix = '_check';
      if (constraint.startsWith(prefix) && constraint.endsWith(suffix)) {
        const column = constraint.slice(prefix.length, -suffix.length);
        structure.checks = structure.checks.filter(
          check =>
            check.table !== table ||
            !new RegExp(`\\b${column}\\b`).test(check.expression)
        );
      }
    }
    for (const statement of extractBalancedStatements(
      sql,
      /alter\s+table\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+add\s+constraint\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+check\s*\(/gi
    )) {
      structure.checks.push({
        table: normalize(statement.match[1]!),
        expression: normalizeExpression(statement.body),
      });
    }
  }
  const key = (value: ExpectedKey): string =>
    `${value.table}:${value.columns.join(',')}`;
  structure.tables.sort();
  structure.columns.sort((left, right) =>
    `${left.table}:${left.name}`.localeCompare(`${right.table}:${right.name}`)
  );
  structure.primaryKeys.sort((left, right) =>
    key(left).localeCompare(key(right))
  );
  structure.uniqueKeys.sort((left, right) =>
    key(left).localeCompare(key(right))
  );
  structure.foreignKeys.sort((left, right) =>
    key(left).localeCompare(key(right))
  );
  structure.checks.sort((left, right) =>
    `${left.table}:${left.expression}`.localeCompare(
      `${right.table}:${right.expression}`
    )
  );
  structure.indexes.sort((left, right) => left.name.localeCompare(right.name));
  structure.triggers.sort((left, right) => left.name.localeCompare(right.name));
  structure.extensions = [
    ...new Set([...POSTGRES_BOOTSTRAP_EXTENSIONS, ...structure.extensions]),
  ].sort();
  return structure;
};

const postgresDeleteAction = (action: string | null): string =>
  ({
    a: 'no action',
    r: 'restrict',
    c: 'cascade',
    n: 'set null',
    d: 'set default',
  })[action ?? 'a'] ?? 'unknown';

const indexColumns = (definition: string): string => {
  const usingAt = definition.toLowerCase().indexOf(' using ');
  const openAt = definition.indexOf('(', usingAt === -1 ? 0 : usingAt);
  return normalizeExpression(
    definition.slice(openAt + 1, matchingParenthesis(definition, openAt))
  );
};

const reportExactMultiset = (
  problems: string[],
  expected: readonly string[],
  actual: readonly string[],
  missingLabel: string,
  unexpectedLabel: string
): void => {
  const expectedCounts = new Map<string, number>();
  const actualCounts = new Map<string, number>();
  for (const value of expected) {
    expectedCounts.set(value, (expectedCounts.get(value) ?? 0) + 1);
  }
  for (const value of actual) {
    actualCounts.set(value, (actualCounts.get(value) ?? 0) + 1);
  }
  for (const [value, count] of expectedCounts) {
    for (let index = actualCounts.get(value) ?? 0; index < count; index += 1) {
      problems.push(`${missingLabel} ${value}`);
    }
  }
  for (const [value, count] of actualCounts) {
    for (
      let index = expectedCounts.get(value) ?? 0;
      index < count;
      index += 1
    ) {
      problems.push(`${unexpectedLabel} ${value}`);
    }
  }
};

const keyColumns = (value: ExpectedKey): string =>
  `${value.table}(${value.columns.join(',')})`;

const foreignKey = (
  value: ExpectedForeignKey,
  referencedSchema: string
): string =>
  `${keyColumns(value)}->${referencedSchema}.${value.referencedTable}(${value.referencedColumns.join(',')}):delete=${value.onDelete}:update=${value.onUpdate}:match=${value.matchType}`;

const actualKeyColumns = (value: ConstraintRow): string =>
  `${value.table_name}(${(value.columns ?? []).map(normalize).join(',')})`;

const actualForeignKey = (value: ConstraintRow): string =>
  `${actualKeyColumns(value)}->${value.referenced_schema}.${value.referenced_table}(${(value.referenced_columns ?? []).map(normalize).join(',')}):delete=${postgresDeleteAction(value.delete_action)}:update=${postgresDeleteAction(value.update_action)}:match=${({ f: 'full', p: 'partial', s: 'simple' } as const)[value.match_type ?? 's'] ?? 'unknown'}`;

export const inspectPostgresSchema = async (
  database: PostgresQueryExecutor,
  migrations: readonly PostgresMigration[]
): Promise<PostgresSchemaInspection> => {
  const expected = expectedStructure(migrations);
  const schemaResult = await database.query<{ schema_name: string }>(
    'SELECT current_schema() AS schema_name'
  );
  const schema = schemaResult.rows[0]?.schema_name;
  if (!schema) throw new Error('PostgreSQL current schema is unavailable');
  const tableResult = await database.query<RelationRow>(
    `SELECT relation.relname AS table_name,
            relation.relkind AS relation_kind,
            relation.relpersistence AS persistence,
            relation.relrowsecurity AS row_security,
            relation.relforcerowsecurity AS force_row_security,
            extension.extname AS extension_name,
            owned_relation.relname AS owned_table,
            owned_attribute.attname AS owned_column,
            sequence.seqstart AS sequence_start,
            sequence.seqincrement AS sequence_increment,
            sequence.seqmin AS sequence_minimum,
            sequence.seqmax AS sequence_maximum,
            sequence.seqcache AS sequence_cache,
            sequence.seqcycle AS sequence_cycles
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_depend extension_dependency
         ON extension_dependency.classid = 'pg_class'::regclass
        AND extension_dependency.objid = relation.oid
        AND extension_dependency.deptype = 'e'
       LEFT JOIN pg_extension extension
         ON extension.oid = extension_dependency.refobjid
       LEFT JOIN pg_depend sequence_dependency
         ON relation.relkind = 'S'
        AND sequence_dependency.classid = 'pg_class'::regclass
        AND sequence_dependency.objid = relation.oid
        AND sequence_dependency.refclassid = 'pg_class'::regclass
        AND sequence_dependency.deptype IN ('a', 'i')
       LEFT JOIN pg_class owned_relation
         ON owned_relation.oid = sequence_dependency.refobjid
       LEFT JOIN pg_attribute owned_attribute
         ON owned_attribute.attrelid = sequence_dependency.refobjid
        AND owned_attribute.attnum = sequence_dependency.refobjsubid
       LEFT JOIN pg_sequence sequence ON sequence.seqrelid = relation.oid
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`,
    [schema]
  );
  const columns = await database.query<ColumnRow>(
    `SELECT relation.relname AS table_name, attribute.attname AS column_name,
            format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
            attribute.attnotnull AS not_null,
            pg_get_expr(default_value.adbin, default_value.adrelid, true)
              AS default_expression,
            attribute.attidentity AS identity_kind,
            attribute.attgenerated AS generated_kind,
            attribute.attcollation = data_type.typcollation
              AS uses_default_collation
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
       JOIN pg_type data_type ON data_type.oid = attribute.atttypid
       LEFT JOIN pg_attrdef default_value
         ON default_value.adrelid = relation.oid
        AND default_value.adnum = attribute.attnum
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND attribute.attnum > 0 AND NOT attribute.attisdropped`,
    [schema, expected.tables]
  );
  const constraints = await database.query<ConstraintRow>(
    `SELECT schema_constraint.conname AS constraint_name,
            relation.relname AS table_name,
            schema_constraint.contype AS constraint_type,
            ARRAY(
              SELECT attribute.attname
                FROM unnest(schema_constraint.conkey) WITH ORDINALITY key(attnum, position)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
               ORDER BY key.position
            )::text[] AS columns,
            referenced_namespace.nspname AS referenced_schema,
            referenced.relname AS referenced_table,
            CASE WHEN schema_constraint.confkey IS NULL THEN NULL ELSE ARRAY(
              SELECT attribute.attname
                FROM unnest(schema_constraint.confkey) WITH ORDINALITY key(attnum, position)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = referenced.oid AND attribute.attnum = key.attnum
               ORDER BY key.position
            )::text[] END AS referenced_columns,
            schema_constraint.confdeltype AS delete_action,
            schema_constraint.confupdtype AS update_action,
            schema_constraint.confmatchtype AS match_type,
            schema_constraint.condeferrable AS is_deferrable,
            schema_constraint.condeferred AS is_initially_deferred,
            schema_constraint.convalidated AS is_validated,
            pg_get_expr(
              schema_constraint.conbin,
              schema_constraint.conrelid,
              true
            ) AS check_expression
       FROM pg_constraint schema_constraint
       JOIN pg_class relation ON relation.oid = schema_constraint.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_class referenced ON referenced.oid = schema_constraint.confrelid
       LEFT JOIN pg_namespace referenced_namespace
         ON referenced_namespace.oid = referenced.relnamespace
      WHERE namespace.nspname = $1
        AND schema_constraint.contype IN ('p', 'u', 'f', 'c', 'x')`,
    [schema]
  );
  const indexes = await database.query<IndexRow>(
    `SELECT index_relation.relname AS index_name,
            table_relation.relname AS table_name,
            index.indisunique AS is_unique,
            index.indisvalid AS is_valid,
            index.indisready AS is_ready,
            index.indisclustered AS is_clustered,
            index.indisreplident AS is_replica_identity,
            index.indnullsnotdistinct AS nulls_not_distinct,
            access_method.amname AS access_method,
            pg_get_indexdef(index.indexrelid, 0, true) AS definition,
            pg_get_expr(index.indpred, index.indrelid, true) AS predicate,
            owned_constraint.oid IS NOT NULL AS constraint_owned,
            extension.extname AS extension_name
       FROM pg_index index
       JOIN pg_class index_relation ON index_relation.oid = index.indexrelid
       JOIN pg_class table_relation ON table_relation.oid = index.indrelid
       JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
       JOIN pg_am access_method ON access_method.oid = index_relation.relam
       LEFT JOIN pg_constraint owned_constraint
         ON owned_constraint.conindid = index.indexrelid
       LEFT JOIN pg_depend extension_dependency
         ON extension_dependency.classid = 'pg_class'::regclass
        AND extension_dependency.objid = index.indexrelid
        AND extension_dependency.deptype = 'e'
       LEFT JOIN pg_extension extension
         ON extension.oid = extension_dependency.refobjid
      WHERE namespace.nspname = $1`,
    [schema]
  );
  const triggers = await database.query<
    TriggerRow & { extension_name: string | null }
  >(
    `SELECT trigger.tgname AS trigger_name,
            relation.relname AS table_name,
            pg_get_triggerdef(trigger.oid, true) AS definition,
            extension.extname AS extension_name
       FROM pg_trigger trigger
       JOIN pg_class relation ON relation.oid = trigger.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_depend extension_dependency
         ON extension_dependency.classid = 'pg_trigger'::regclass
        AND extension_dependency.objid = trigger.oid
        AND extension_dependency.deptype = 'e'
       LEFT JOIN pg_extension extension
         ON extension.oid = extension_dependency.refobjid
      WHERE namespace.nspname = $1 AND NOT trigger.tgisinternal
      ORDER BY trigger.tgname`,
    [schema]
  );
  const extensions = await database.query<{ extension_name: string }>(
    'SELECT extname AS extension_name FROM pg_extension ORDER BY extname'
  );

  const problems: string[] = [];
  const allowedExtensions = new Set(expected.extensions);
  const applicationRelations = tableResult.rows.filter(
    row => !row.extension_name || !allowedExtensions.has(row.extension_name)
  );
  const applicationTables = applicationRelations.filter(
    row => row.relation_kind !== 'S'
  );
  const applicationSequences = applicationRelations.filter(
    row => row.relation_kind === 'S'
  );
  const presentApplicationTables = new Set(
    applicationTables.map(row => row.table_name)
  );
  const optionalTableNames = new Set(expected.optionalTableGroups.flat());
  const activeExpectedTables = new Set(
    expected.tables.filter(table => !optionalTableNames.has(table))
  );
  for (const group of expected.optionalTableGroups) {
    if (group.some(table => presentApplicationTables.has(table))) {
      for (const table of group) activeExpectedTables.add(table);
    }
  }
  const expectedForActiveTable = <Value extends { table: string }>(
    values: readonly Value[]
  ): Value[] => values.filter(value => activeExpectedTables.has(value.table));
  for (const table of activeExpectedTables) {
    const relation = applicationTables.find(row => row.table_name === table);
    if (!relation) {
      problems.push(`missing table ${table}`);
    } else if (
      relation.relation_kind !== 'r' ||
      relation.persistence !== 'p' ||
      relation.row_security ||
      relation.force_row_security
    ) {
      problems.push(`invalid table ${table}`);
    }
  }
  for (const relation of applicationTables) {
    if (!expected.tables.includes(relation.table_name)) {
      problems.push(`unexpected relation ${relation.table_name}`);
    }
  }
  const expectedIdentityColumns = expected.columns
    .filter(column => activeExpectedTables.has(column.table))
    .filter(column => column.identityKind !== '')
    .map(column => `${column.table}.${column.name}`);
  reportExactMultiset(
    problems,
    expectedIdentityColumns,
    applicationSequences.map(sequence =>
      sequence.owned_table && sequence.owned_column
        ? `${sequence.owned_table}.${sequence.owned_column}`
        : `unowned:${sequence.table_name}`
    ),
    'missing identity sequence for',
    'unexpected sequence for'
  );
  for (const sequence of applicationSequences) {
    const maximum =
      expected.columns.find(
        column =>
          column.table === sequence.owned_table &&
          column.name === sequence.owned_column
      )?.type === 'integer'
        ? 2_147_483_647
        : 9_223_372_036_854_775_807n;
    if (
      BigInt(sequence.sequence_start ?? 0) !== 1n ||
      BigInt(sequence.sequence_increment ?? 0) !== 1n ||
      BigInt(sequence.sequence_minimum ?? 0) !== 1n ||
      BigInt(sequence.sequence_maximum ?? 0) !== BigInt(maximum) ||
      BigInt(sequence.sequence_cache ?? 0) !== 1n ||
      sequence.sequence_cycles !== false
    ) {
      problems.push(`invalid sequence ${sequence.table_name}`);
    }
  }
  const columnByKey = new Map(
    columns.rows.map(row => [`${row.table_name}:${row.column_name}`, row])
  );
  for (const column of expectedForActiveTable(expected.columns)) {
    const actual = columnByKey.get(`${column.table}:${column.name}`);
    if (!actual) {
      problems.push(`missing column ${column.table}.${column.name}`);
    } else if (normalizeType(actual.data_type) !== column.type) {
      problems.push(`wrong type ${column.table}.${column.name}`);
    } else if (actual.not_null !== column.notNull) {
      problems.push(`wrong nullability ${column.table}.${column.name}`);
    } else if (
      normalizeExpression(actual.default_expression ?? '') !==
      normalizeExpression(column.defaultExpression ?? '')
    ) {
      problems.push(`wrong default ${column.table}.${column.name}`);
    } else if (
      actual.identity_kind !== column.identityKind ||
      actual.generated_kind !== column.generatedKind ||
      !actual.uses_default_collation
    ) {
      problems.push(`invalid column ${column.table}.${column.name}`);
    }
  }
  const expectedColumnKeys = new Set(
    expectedForActiveTable(expected.columns).map(
      column => `${column.table}:${column.name}`
    )
  );
  for (const column of columns.rows) {
    if (!expectedColumnKeys.has(`${column.table_name}:${column.column_name}`)) {
      problems.push(
        `unexpected column ${column.table_name}.${column.column_name}`
      );
    }
  }
  const keys = (type: ConstraintRow['constraint_type']): ConstraintRow[] =>
    constraints.rows.filter(row => row.constraint_type === type);
  reportExactMultiset(
    problems,
    expectedForActiveTable(expected.primaryKeys).map(keyColumns),
    keys('p').map(actualKeyColumns),
    'missing primary key',
    'unexpected primary key'
  );
  reportExactMultiset(
    problems,
    expectedForActiveTable(expected.uniqueKeys).map(keyColumns),
    keys('u').map(actualKeyColumns),
    'missing unique key',
    'unexpected unique key'
  );
  reportExactMultiset(
    problems,
    expectedForActiveTable(expected.foreignKeys).map(value =>
      foreignKey(value, schema)
    ),
    keys('f').map(actualForeignKey),
    'missing foreign key',
    'unexpected foreign key'
  );
  reportExactMultiset(
    problems,
    expectedForActiveTable(expected.checks).map(
      value => `${value.table}:${value.expression}`
    ),
    keys('c').map(
      value =>
        `${value.table_name}:${normalizeExpression(value.check_expression ?? '')}`
    ),
    'missing check constraint',
    'unexpected check constraint'
  );
  for (const constraint of constraints.rows) {
    if (
      constraint.constraint_type === 'x' ||
      constraint.is_deferrable ||
      constraint.is_initially_deferred ||
      !constraint.is_validated
    ) {
      problems.push(
        `invalid constraint ${constraint.table_name}.${constraint.constraint_name}`
      );
    }
  }
  const applicationIndexes = indexes.rows.filter(
    row =>
      !row.constraint_owned &&
      (!row.extension_name || !allowedExtensions.has(row.extension_name))
  );
  const indexByName = new Map(
    applicationIndexes.map(row => [row.index_name, row])
  );
  const activeExpectedIndexes = expectedForActiveTable(expected.indexes);
  for (const expectedIndex of activeExpectedIndexes) {
    const actual = indexByName.get(expectedIndex.name);
    if (!actual) {
      problems.push(`missing index ${expectedIndex.name}`);
      continue;
    }
    if (
      actual.table_name !== expectedIndex.table ||
      actual.is_unique !== expectedIndex.unique ||
      actual.access_method !== expectedIndex.accessMethod ||
      !actual.is_valid ||
      !actual.is_ready ||
      actual.is_clustered ||
      actual.is_replica_identity ||
      actual.nulls_not_distinct ||
      indexColumns(actual.definition) !==
        normalizeExpression(expectedIndex.columns) ||
      normalizeExpression(actual.predicate ?? '') !==
        normalizeExpression(expectedIndex.predicate ?? '')
    ) {
      problems.push(`invalid index ${expectedIndex.name}`);
    }
  }
  for (const index of applicationIndexes) {
    if (!activeExpectedIndexes.some(value => value.name === index.index_name)) {
      problems.push(`unexpected index ${index.index_name}`);
    }
  }
  const installedExtensions = new Set(
    extensions.rows.map(row => row.extension_name)
  );
  for (const extension of expected.extensions) {
    if (!installedExtensions.has(extension)) {
      problems.push(`missing extension ${extension}`);
    }
  }
  for (const extension of installedExtensions) {
    if (!expected.extensions.includes(extension)) {
      problems.push(`unexpected extension ${extension}`);
    }
  }
  const applicationTriggers = triggers.rows.filter(
    row => !row.extension_name || !allowedExtensions.has(row.extension_name)
  );
  reportExactMultiset(
    problems,
    expectedForActiveTable(expected.triggers).map(
      value => `${value.table}.${value.name}`
    ),
    applicationTriggers.map(
      value => `${value.table_name}.${value.trigger_name}`
    ),
    'missing trigger',
    'unexpected trigger'
  );

  const observed = {
    tables: applicationRelations
      .map(row => ({
        name: row.table_name,
        kind: row.relation_kind,
        persistence: row.persistence,
        rowSecurity: row.row_security,
        forceRowSecurity: row.force_row_security,
        ownedTable: row.owned_table,
        ownedColumn: row.owned_column,
        sequenceStart: row.sequence_start,
        sequenceIncrement: row.sequence_increment,
        sequenceMinimum: row.sequence_minimum,
        sequenceMaximum: row.sequence_maximum,
        sequenceCache: row.sequence_cache,
        sequenceCycles: row.sequence_cycles,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    columns: columns.rows
      .map(row => ({
        table: row.table_name,
        name: row.column_name,
        type: normalizeType(row.data_type),
        notNull: row.not_null,
        defaultExpression: normalizeExpression(row.default_expression ?? ''),
        identity: row.identity_kind,
        generated: row.generated_kind,
        defaultCollation: row.uses_default_collation,
      }))
      .sort((left, right) =>
        `${left.table}:${left.name}`.localeCompare(
          `${right.table}:${right.name}`
        )
      ),
    constraints: constraints.rows
      .map(row => ({
        table: row.table_name,
        type: row.constraint_type,
        columns: row.columns,
        name: row.constraint_name,
        referencedSchema: row.referenced_schema,
        referencedTable: row.referenced_table,
        referencedColumns: row.referenced_columns,
        deleteAction: row.delete_action,
        updateAction: row.update_action,
        matchType: row.match_type,
        deferrable: row.is_deferrable,
        initiallyDeferred: row.is_initially_deferred,
        validated: row.is_validated,
        checkExpression: normalizeExpression(row.check_expression ?? ''),
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ),
    indexes: applicationIndexes
      .map(row => ({
        name: row.index_name,
        table: row.table_name,
        unique: row.is_unique,
        valid: row.is_valid,
        ready: row.is_ready,
        clustered: row.is_clustered,
        replicaIdentity: row.is_replica_identity,
        nullsNotDistinct: row.nulls_not_distinct,
        accessMethod: row.access_method,
        columns: indexColumns(row.definition),
        predicate: normalizeExpression(row.predicate ?? ''),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    triggers: applicationTriggers
      .map(row => ({
        name: row.trigger_name,
        table: row.table_name,
        definition: normalize(row.definition),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    extensions: [...installedExtensions].sort(),
  };
  return {
    compatible: problems.length === 0,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(observed))
      .digest('hex'),
    problems,
  };
};
