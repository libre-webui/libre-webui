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
 * Resolved configuration for the embedded Cordis host and its DSH engine.
 *
 * The host is feature-flagged off by default: Libre WebUI must behave exactly
 * as before unless an operator opts in, and an opted-in host that cannot start
 * must fail loudly rather than silently degrading to a half-mounted engine.
 *
 * Precedence, lowest to highest: built-in defaults, the `cordis.patch.yml`
 * document, `LIBRE_CORDIS_*` environment variables. Secrets are never stored
 * in the config document — a provider names the environment variable that
 * holds its key, and the adapter resolves that variable per request.
 *
 * @module cordis/host/config
 */

import path from 'node:path';
import { readSettingsFile } from './composition.js';
import { resolveDataDirectory } from '../../utils/dataDirectory.js';

/** Default file name of the host settings document. */
export const CORDIS_SETTINGS_FILENAME = 'cordis.config.yml';

/**
 * Default file name of the composition document.
 *
 * Deliberately the same name Cordis uses, so an operator who already knows the
 * Cordis loader recognises it: a top-level YAML array of loader entries.
 */
export const CORDIS_PATCH_FILENAME = 'cordis.patch.yml';

/**
 * How the engine reaches a model provider.
 *
 * `libre-webui` is the supported mode: the engine calls the providers this
 * deployment already has, through the composition's adapter row. The other
 * values mount a provider package directly and require installing it, because
 * carrying every provider SDK as a hard dependency pulled in a large transitive
 * tree that includes deprecated packages for capabilities the engine never
 * reaches.
 */
export type ModelProviderMode =
  /** The DeepSeek provider adapter package, installed separately. */
  | 'deepseek'
  /** The generic pi-ai adapter package, installed separately. */
  | 'pi-ai'
  /** Served through Libre WebUI's own provider layer. */
  | 'libre-webui'
  /** Mount no provider adapter; the engine starts without model access. */
  | 'none';

/** Configuration for the swappable model adapter plugin. */
export interface ModelAdapterConfig {
  /** Which adapter family to mount. */
  readonly provider: ModelProviderMode;
  /** Environment variable holding the API key, never the key itself. */
  readonly apiKeyEnv: string;
  /** Base URL override; empty means the adapter's own default endpoint. */
  readonly baseUrl: string;
  /** Provider route name used when creating agents. */
  readonly route: string;
  /** Default model identifier. */
  readonly model: string;
  /**
   * Hand-declared pi-ai provider routes, keyed by route name.
   *
   * Passed through to `dsh-llm-pi-ai` verbatim: a route that names an installed
   * pi-ai provider inherits that provider's defaults, and any other key is a
   * complete declaration. This is what lets an operator point the engine at an
   * Ollama or OpenAI-compatible gateway without changing Libre WebUI code.
   */
  readonly providers: Readonly<Record<string, Record<string, unknown>>>;
}

/** Feature flags for the embedded engine. */
export interface EngineFeatures {
  /**
   * Mount the engine at all.
   *
   * Read from `features.enabled`. Every capability switch lives in this one
   * block so there is a single place to look for "what is turned on"; a
   * top-level `enabled` key would be a second, silently ignored spelling.
   */
  readonly enabled: boolean;
  /** Accept chat requests that stream model output. */
  readonly streaming: boolean;
  /** Expose the engine's tool listing to the UI. */
  readonly tools: boolean;
  /** Keep engine sessions on disk across restarts. */
  readonly persistence: boolean;
}

/** Fully resolved host configuration. */
export interface CordisHostConfig {
  /** Explicit opt-in to a local DSH instance's private provider socket. */
  readonly nativeProvider?: { readonly socketPath: string };
  /** Feature flags. */
  readonly features: EngineFeatures;
  /**
   * Runtime capability the host passes to the provider adapter row.
   *
   * A row is imported by URL while an application imports its own modules by
   * path, producing separate module instances. Carrying the handler on the
   * configuration is what lets the host hand it to the very instance the loader
   * will activate; a module-level registration made elsewhere would be invisible
   * to it. Never serialized — the composed document holds only the rows.
   */
  readonly providerHandler?: unknown;
  /** Model adapter selection and provider routes. */
  readonly model: ModelAdapterConfig;
  /** Absolute path of the composition document that mounts the engine. */
  readonly configPath: string;
  /** Absolute path of the settings document, read for operator preferences. */
  readonly settingsPath: string;
  /** Absolute directory handed to the engine as its default workspace. */
  readonly workspacePath: string;
  /** Absolute directory holding persisted engine sessions. */
  readonly sessionStorePath: string;
  /**
   * Absolute directory for host-owned runtime state.
   *
   * Kept separate from the session store because it is disposable: the host
   * regenerates its composed composition here on every start.
   */
  readonly runtimePath: string;
  /** Log every activation transition of the Cordis tree. */
  readonly trace: boolean;
  /**
   * Whether the settings document itself stated `features.enabled`.
   *
   * Distinguishes an operator decision from a built-in default. `features.enabled`
   * resolves to a boolean either way, so without this the access layer cannot
   * tell a file that says off apart from nobody having said anything, and would treat every
   * deployment as pinned.
   */
  readonly featuresEnabledDeclared: boolean;
}

/** Read a boolean environment variable, falling back when unset or malformed. */
function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/** Read a string environment variable, falling back when unset or blank. */
function readStringEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

/** Empty path settings mean the app-owned default, never the launch directory. */
function resolveEngineDirectory(
  explicit: string | undefined,
  envName: string,
  documented: unknown,
  fallback: string
): string {
  for (const value of [explicit, process.env[envName]?.trim(), documented]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string')
      throw new Error(`${envName} and its directory setting must be strings.`);
    if (value.trim() !== '') return path.resolve(value);
  }
  return path.resolve(fallback);
}

/**
 * Read a value where an empty string is a decision rather than an absence.
 *
 * The model route is the case that matters: naming none is how a composition
 * says it mounts no adapter, and the generic environment reader would treat
 * that as "unset" and substitute the default, turning a deliberate opt-out back
 * into a route nothing serves.
 *
 * @param name - environment variable overriding the document.
 * @param documented - value the settings document stated, if any.
 * @param fallback - value used when neither source says anything.
 * @returns the effective value.
 */
function readStringEnvHonouringEmpty(
  name: string,
  documented: unknown,
  fallback: string
): string {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() !== '') return raw.trim();
  if (documented === undefined || documented === null) return fallback;
  return String(documented).trim();
}

/** Parse the provider mode, rejecting unknown values instead of guessing. */
function readProviderMode(value: unknown): ModelProviderMode {
  if (
    value === 'deepseek' ||
    value === 'pi-ai' ||
    value === 'libre-webui' ||
    value === 'none'
  ) {
    return value;
  }
  if (value === undefined || value === null || value === '')
    return 'libre-webui';
  throw new Error(
    `cordis host: unknown model provider "${String(value)}" ` +
      '(expected libre-webui, deepseek, pi-ai, or none)'
  );
}

/** Narrow an unknown value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** One layer of configuration read from the settings document. */
interface ConfigDocument {
  readonly nativeProvider?: { readonly socketPath?: string };
  readonly features?: Partial<EngineFeatures>;
  readonly model?: Partial<ModelAdapterConfig> & {
    readonly providers?: Record<string, Record<string, unknown>>;
  };
  readonly workspacePath?: string;
  readonly sessionStorePath?: string;
  readonly trace?: boolean;
}

/**
 * Read the host settings document.
 *
 * A missing file is not an error — the host then runs on defaults plus the
 * environment. A present but malformed file is an error: silently ignoring an
 * operator's explicit configuration is how a deployment ends up running a
 * different engine than the one on disk.
 *
 * @param settingsPath - absolute path of the settings document.
 * @returns the settings mapping, or an empty mapping when the file is absent.
 * @throws when the file exists but does not parse to a settings mapping.
 */
export function readConfigDocument(settingsPath: string): ConfigDocument {
  return readSettingsFile(settingsPath) as ConfigDocument;
}

/**
 * Resolve the host configuration from defaults, the settings document, and
 * environment variables.
 * @param options - optional explicit document paths, workspace, and store path.
 * @returns the fully resolved configuration.
 * @throws when a document is malformed or names an unknown provider mode.
 */
export function resolveCordisHostConfig(
  options: {
    /** Explicit composition path, overriding `LIBRE_CORDIS_CONFIG`. */
    configPath?: string;
    /** Explicit settings path, overriding `LIBRE_CORDIS_SETTINGS`. */
    settingsPath?: string;
    /** Absolute directory the engine may treat as its workspace. */
    workspacePath?: string;
    /** Absolute directory for persisted sessions. */
    sessionStorePath?: string;
  } = {}
): CordisHostConfig {
  const configPath = path.resolve(
    options.configPath ??
      readStringEnv(
        'LIBRE_CORDIS_CONFIG',
        path.join(process.cwd(), CORDIS_PATCH_FILENAME)
      )
  );
  // Settings default to sitting beside the composition, so pointing
  // LIBRE_CORDIS_CONFIG at a deployment directory moves both documents at once.
  const settingsPath = path.resolve(
    options.settingsPath ??
      readStringEnv(
        'LIBRE_CORDIS_SETTINGS',
        path.join(path.dirname(configPath), CORDIS_SETTINGS_FILENAME)
      )
  );
  const document = readConfigDocument(settingsPath);
  const documentFeatures = document.features ?? {};
  const documentModel = document.model ?? {};
  const dataDirectory = resolveDataDirectory();

  const workspacePath = resolveEngineDirectory(
    options.workspacePath,
    'LIBRE_CORDIS_WORKSPACE',
    document.workspacePath,
    path.join(dataDirectory, 'cordis-workspace')
  );
  const sessionStorePath = resolveEngineDirectory(
    options.sessionStorePath,
    'LIBRE_CORDIS_SESSION_STORE',
    document.sessionStorePath,
    path.join(dataDirectory, 'cordis-sessions')
  );

  const providers = asRecord(documentModel.providers) ?? {};
  const nativeSocket =
    process.env.LIBRE_DSH_PROVIDER_SOCKET ??
    document.nativeProvider?.socketPath;
  if (
    nativeSocket &&
    (typeof nativeSocket !== 'string' ||
      !path.isAbsolute(nativeSocket) ||
      nativeSocket !== nativeSocket.trim() ||
      [...nativeSocket].some(
        character =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ))
  )
    throw new Error('Native DSH provider socket must be an absolute path.');

  return {
    ...(nativeSocket ? { nativeProvider: { socketPath: nativeSocket } } : {}),
    configPath,
    settingsPath,
    featuresEnabledDeclared:
      documentFeatures.enabled === true || documentFeatures.enabled === false,
    workspacePath,
    sessionStorePath,
    runtimePath: path.join(dataDirectory, 'cordis-runtime'),
    trace: readBooleanEnv('LIBRE_CORDIS_TRACE', document.trace === true),
    features: {
      enabled: readBooleanEnv(
        'LIBRE_CORDIS_ENABLED',
        documentFeatures.enabled === true
      ),
      streaming: readBooleanEnv(
        'LIBRE_CORDIS_STREAMING',
        documentFeatures.streaming !== false
      ),
      tools: readBooleanEnv(
        'LIBRE_CORDIS_TOOLS',
        documentFeatures.tools !== false
      ),
      persistence: readBooleanEnv(
        'LIBRE_CORDIS_PERSISTENCE',
        documentFeatures.persistence !== false
      ),
    },
    model: {
      provider: readProviderMode(
        readStringEnv(
          'LIBRE_CORDIS_MODEL_PROVIDER',
          String(documentModel.provider ?? '')
        ) || undefined
      ),
      apiKeyEnv: readStringEnv(
        'LIBRE_CORDIS_API_KEY_ENV',
        String(documentModel.apiKeyEnv ?? 'OPENAI_API_KEY')
      ),
      baseUrl: readStringEnv(
        'LIBRE_CORDIS_BASE_URL',
        String(documentModel.baseUrl ?? '')
      ),
      route: readStringEnvHonouringEmpty(
        'LIBRE_CORDIS_MODEL_ROUTE',
        documentModel.route,
        'libre-webui'
      ),
      model: readStringEnv(
        'LIBRE_CORDIS_MODEL',
        String(documentModel.model ?? '')
      ),
      providers: providers as Record<string, Record<string, unknown>>,
    },
  };
}
