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
 * The logins agent CLIs in Work run under: the same ones Chat uses, read
 * from where each CLI keeps its own sign-in for the server user.
 *
 * Chat runs a CLI on the host, so the CLI simply finds its login. Work runs
 * the CLI inside the task's sandbox, so each login here is turned into the
 * CLI's own login file (or variable) with placeholders where the tokens go.
 * The egress proxy swaps the real token in on the login's own API hosts;
 * the token itself never enters the sandbox.
 *
 * A sandboxed CLI cannot refresh its login (a refresh token travels in a
 * request body, which the proxy never rewrites), so the sandbox copy claims
 * not to expire and the host side keeps the real token fresh instead, the
 * way the CLI itself would: before the run and periodically during it.
 * Refreshed tokens are written back where the CLI keeps them, so the CLI on
 * the host keeps working too.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { providerRequest } from '../utils/providerFetch.js';
import { resolveBinary } from './agentCliService.js';
import {
  readKiroLoginRows,
  scrubbedKiroDatabase,
} from './kiroLoginDatabase.js';
import codexOAuthService from './codexOAuthService.js';
import type { WorkAgentCliId } from './workAgentCatalog.js';
import {
  createEgressPlaceholder,
  type EgressCredential,
} from './workEgressProxy.js';

const logger = createLogger('services:work-agent-logins');

/** A token must stay valid at least this long when a run (re)checks it. */
export const LOGIN_REFRESH_MARGIN_MS = 10 * 60_000;
/** How long the sandbox copy claims to stay valid. */
const SANDBOX_VALIDITY_MS = 365 * 24 * 60 * 60_000;
const STATUS_CACHE_MS = 15_000;
const HOST_COMMAND_TIMEOUT_MS = 30_000;

export interface WorkAgentLoginFile {
  /** Path relative to the agent's home directory in the sandbox. */
  readonly path: string;
  readonly content: Buffer;
}

/** What one run needs to sign its CLI in without holding a real token. */
export interface WorkAgentLogin {
  readonly credentials: readonly EgressCredential[];
  /** Variables for the CLI; any token among them is a placeholder. */
  readonly env: Readonly<Record<string, string>>;
  /** Login and settings files written into the agent's home. */
  readonly files: readonly WorkAgentLoginFile[];
  /** Model to pass when the selection left it to the CLI's own default. */
  readonly model?: string;
  /** Keeps the real tokens current; called periodically during a run. */
  readonly refresh?: (signal?: AbortSignal) => Promise<void>;
}

export type WorkAgentLoginStatus =
  { readonly ready: true } | { readonly ready: false; readonly reason: string };

export interface WorkAgentHostLogin {
  /** Whether a login exists. Cheap: never refreshes or calls out. */
  status(): Promise<WorkAgentLoginStatus>;
  /** A sandbox login for one run, refreshing the real one if needed. */
  prepare(
    model: string | undefined,
    signal?: AbortSignal
  ): Promise<WorkAgentLogin>;
}

/** A login that is missing, expired, or of a kind Work cannot carry. */
export class WorkAgentLoginError extends Error {
  readonly status = 409;
  readonly code = 'WORK_AGENT_NOT_SIGNED_IN';
  constructor(message: string) {
    super(message);
    this.name = 'WorkAgentLoginError';
  }
}

// --- Provider hosts ------------------------------------------------------

const ANTHROPIC_HOSTS = ['api.anthropic.com'];
const OPENAI_HOSTS = ['api.openai.com'];
const CHATGPT_HOSTS = ['chatgpt.com'];
const COPILOT_HOSTS = [
  'api.githubcopilot.com',
  'api.individual.githubcopilot.com',
  'api.business.githubcopilot.com',
  'api.enterprise.githubcopilot.com',
];
const KIRO_HOSTS = [
  'management.*.kiro.dev',
  'runtime.*.kiro.dev',
  'q.*.amazonaws.com',
  'codewhisperer.*.amazonaws.com',
];

/**
 * Where each provider's login may be used, for providers OpenCode and Pi
 * can sign in to. Exact API hosts only: the proxy puts a real token on
 * nothing else. A provider missing here cannot run in Work, and says so.
 */
export const WORK_AGENT_PROVIDER_HOSTS: Readonly<
  Record<string, readonly string[]>
> = {
  anthropic: ANTHROPIC_HOSTS,
  openai: OPENAI_HOSTS,
  'openai-codex': CHATGPT_HOSTS,
  openrouter: ['openrouter.ai'],
  google: ['generativelanguage.googleapis.com'],
  'github-copilot': COPILOT_HOSTS,
  groq: ['api.groq.com'],
  mistral: ['api.mistral.ai'],
  deepseek: ['api.deepseek.com'],
  xai: ['api.x.ai'],
  cerebras: ['api.cerebras.ai'],
  togetherai: ['api.together.xyz'],
  'fireworks-ai': ['api.fireworks.ai'],
  moonshotai: ['api.moonshot.ai'],
  zai: ['api.z.ai'],
  'zai-coding-plan': ['api.z.ai'],
  opencode: ['opencode.ai'],
  huggingface: ['router.huggingface.co'],
};

/** The variable each provider's key is read from when no login is saved. */
const PROVIDER_KEY_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  xai: ['XAI_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  togetherai: ['TOGETHER_API_KEY'],
  'fireworks-ai': ['FIREWORKS_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  huggingface: ['HF_TOKEN'],
};

// --- Shared helpers ------------------------------------------------------

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    ) as unknown;
    return claims && typeof claims === 'object'
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

/**
 * A placeholder shaped like the token it replaces. CLIs that read their
 * account from a ChatGPT access token still find it, along with an expiry
 * far enough out that they never try to refresh; the signature segment is
 * the placeholder itself, so the whole string is what the proxy replaces.
 */
export function placeholderFor(realToken: string): string {
  const placeholder = createEgressPlaceholder();
  const claims = jwtClaims(realToken);
  if (!claims) return placeholder;
  const kept: Record<string, unknown> = {
    exp: Math.floor((Date.now() + SANDBOX_VALIDITY_MS) / 1000),
  };
  const auth = claims[OPENAI_AUTH_CLAIM];
  if (auth && typeof auth === 'object') {
    const { chatgpt_account_id, chatgpt_plan_type } = auth as Record<
      string,
      unknown
    >;
    kept[OPENAI_AUTH_CLAIM] = { chatgpt_account_id, chatgpt_plan_type };
  }
  if (typeof claims.chatgpt_account_id === 'string') {
    kept.chatgpt_account_id = claims.chatgpt_account_id;
  }
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(kept)}.${placeholder}`;
}

/** A token the proxy reads on every request, replaced when refreshed. */
class LiveSecret {
  constructor(private value: string) {}
  readonly read = (): string => this.value;
  set(value: string): void {
    this.value = value;
  }
}

function credential(
  name: string,
  placeholder: string,
  secret: LiveSecret | string,
  hosts: readonly string[]
): EgressCredential {
  return {
    name,
    placeholder,
    secret: typeof secret === 'string' ? secret : secret.read,
    hosts,
  };
}

function jsonFile(relativePath: string, value: unknown): WorkAgentLoginFile {
  return {
    path: relativePath,
    content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
  };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Write a login file back with the same restrictive mode the CLI uses. */
function writeJsonPrivate(file: string, value: unknown): void {
  const temporary = `${file}.libre-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function xdgDataHome(): string {
  return (
    environmentValue('XDG_DATA_HOME') ??
    path.join(os.homedir(), '.local', 'share')
  );
}

function runHost(
  command: string,
  args: readonly string[],
  options: { input?: string; signal?: AbortSignal } = {}
): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const child = execFile(
      command,
      [...args],
      {
        timeout: HOST_COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout) });
      }
    );
    child.stdin?.end(options.input ?? '');
  });
}

function signInHint(cli: string, command: string): string {
  return `${cli} is not signed in on this server. Run \`${command}\` as the server user (the account Libre WebUI runs as), then try again.`;
}

function expiredHint(cli: string, command: string): string {
  return `${cli}'s login on this server has expired and could not be refreshed. Run \`${command}\` as the server user, then try again.`;
}

/** Cache a cheap status for a few seconds; the picker asks often. */
function cachedStatus(
  read: () => Promise<WorkAgentLoginStatus>
): () => Promise<WorkAgentLoginStatus> {
  let cached: { at: number; value: Promise<WorkAgentLoginStatus> } | null =
    null;
  return () => {
    if (!cached || Date.now() - cached.at > STATUS_CACHE_MS) {
      cached = { at: Date.now(), value: read() };
    }
    return cached.value;
  };
}

// --- OAuth refresh, as the CLIs themselves do it -------------------------

interface RefreshedTokens {
  access: string;
  refresh?: string;
  expiresAtMs: number;
}

const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

async function refreshAnthropic(
  refreshToken: string,
  signal?: AbortSignal
): Promise<RefreshedTokens> {
  const response = await providerRequest({
    url:
      process.env.WORK_AGENT_ANTHROPIC_OAUTH_URL ||
      'https://console.anthropic.com/v1/oauth/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    }),
    timeoutMs: HOST_COMMAND_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  const data = response.data as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error('The Anthropic token refresh returned no access token.');
  }
  return {
    access: data.access_token,
    ...(data.refresh_token ? { refresh: data.refresh_token } : {}),
    expiresAtMs: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

async function refreshOpenAi(
  refreshToken: string,
  signal?: AbortSignal
): Promise<RefreshedTokens> {
  const response = await providerRequest({
    url:
      process.env.CODEX_OAUTH_TOKEN_URL ||
      'https://auth.openai.com/oauth/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }).toString(),
    timeoutMs: HOST_COMMAND_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  const data = response.data as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error('The OpenAI token refresh returned no access token.');
  }
  const exp = jwtClaims(data.access_token)?.exp;
  return {
    access: data.access_token,
    ...(data.refresh_token ? { refresh: data.refresh_token } : {}),
    expiresAtMs:
      typeof exp === 'number'
        ? exp * 1000
        : Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/** A Copilot session token from the long-lived GitHub token. */
async function refreshCopilot(
  githubToken: string,
  signal?: AbortSignal
): Promise<RefreshedTokens> {
  const response = await providerRequest({
    url: 'https://api.github.com/copilot_internal/v2/token',
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'Editor-Version': 'vscode/1.99.3',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
    },
    timeoutMs: HOST_COMMAND_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  const data = response.data as { token?: string; expires_at?: number };
  if (!data.token) {
    throw new Error('GitHub returned no Copilot token.');
  }
  return {
    access: data.token,
    // The GitHub token is the refresh token; it does not rotate.
    refresh: githubToken,
    expiresAtMs:
      typeof data.expires_at === 'number'
        ? data.expires_at * 1000
        : Date.now() + 25 * 60_000,
  };
}

type ProviderRefresh = (
  token: string,
  signal?: AbortSignal
) => Promise<RefreshedTokens>;

/** The refresh flow for an OpenCode or Pi provider's OAuth login. */
const PROVIDER_REFRESH: Readonly<Record<string, ProviderRefresh>> = {
  anthropic: refreshAnthropic,
  openai: refreshOpenAi,
  'openai-codex': refreshOpenAi,
  'github-copilot': refreshCopilot,
};

// --- Claude Code ---------------------------------------------------------

interface ClaudeOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Where Claude Code keeps its subscription login: the macOS login keychain,
 * or `.credentials.json` in its config directory elsewhere. A custom
 * CLAUDE_CONFIG_DIR gets its own keychain entry, suffixed like the CLI does.
 */
export class ClaudeCodeLoginStore {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly configDir: string | undefined = environmentValue(
      'CLAUDE_CONFIG_DIR'
    )
  ) {}

  private get file(): string {
    return path.join(
      this.configDir ?? path.join(os.homedir(), '.claude'),
      '.credentials.json'
    );
  }

  private get service(): string {
    if (!this.configDir) return CLAUDE_KEYCHAIN_SERVICE;
    const suffix = createHash('sha256')
      .update(this.configDir)
      .digest('hex')
      .slice(0, 8);
    return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
  }

  async read(): Promise<Record<string, unknown> | null> {
    if (this.platform !== 'darwin') return readJson(this.file);
    const result = await runHost('security', [
      'find-generic-password',
      '-a',
      os.userInfo().username,
      '-s',
      this.service,
      '-w',
    ]);
    if (result.code !== 0) return readJson(this.file);
    try {
      const parsed = JSON.parse(result.stdout.trim()) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  async write(value: Record<string, unknown>): Promise<void> {
    if (this.platform !== 'darwin') {
      writeJsonPrivate(this.file, value);
      return;
    }
    // Through `security -i` so the token never appears in a process list.
    const hex = Buffer.from(JSON.stringify(value)).toString('hex');
    const quote = (text: string) => `"${text.replace(/["\\]/g, '\\$&')}"`;
    const result = await runHost('security', ['-i'], {
      input: `add-generic-password -U -a ${quote(os.userInfo().username)} -s ${quote(this.service)} -X ${hex}\n`,
    });
    if (result.code !== 0) {
      throw new Error('Could not save the refreshed Claude Code login.');
    }
  }
}

export class ClaudeCodeHostLogin implements WorkAgentHostLogin {
  private refreshing: Promise<ClaudeOauth> | null = null;

  constructor(
    private readonly store = new ClaudeCodeLoginStore(),
    private readonly refresh = refreshAnthropic
  ) {}

  readonly status = cachedStatus(async () => {
    const unsupported = this.unsupportedBackend();
    if (unsupported) return { ready: false, reason: unsupported };
    if (
      environmentValue('ANTHROPIC_API_KEY') ||
      environmentValue('CLAUDE_CODE_OAUTH_TOKEN')
    ) {
      return { ready: true };
    }
    const oauth = await this.readOauth();
    return oauth?.accessToken
      ? { ready: true }
      : { ready: false, reason: signInHint('Claude Code', 'claude') };
  });

  async prepare(
    _model: string | undefined,
    signal?: AbortSignal
  ): Promise<WorkAgentLogin> {
    const unsupported = this.unsupportedBackend();
    if (unsupported) throw new WorkAgentLoginError(unsupported);
    // The same precedence Claude Code applies to the server's variables.
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      const value = environmentValue(name);
      if (!value) continue;
      const placeholder = createEgressPlaceholder();
      return {
        credentials: [credential(name, placeholder, value, ANTHROPIC_HOSTS)],
        env: { [name]: placeholder },
        files: [],
      };
    }
    const oauth = await this.fresh(signal);
    const secret = new LiveSecret(oauth.accessToken as string);
    const placeholder = createEgressPlaceholder();
    return {
      credentials: [
        credential(
          'CLAUDE_CODE_OAUTH_TOKEN',
          placeholder,
          secret,
          ANTHROPIC_HOSTS
        ),
      ],
      // The CLI's documented headless form of a subscription login.
      env: { CLAUDE_CODE_OAUTH_TOKEN: placeholder },
      files: [],
      refresh: async refreshSignal => {
        secret.set((await this.fresh(refreshSignal)).accessToken as string);
      },
    };
  }

  private unsupportedBackend(): string | null {
    for (const name of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ]) {
      const value = environmentValue(name);
      if (value && value !== '0' && value.toLowerCase() !== 'false') {
        return `Claude Code on this server is set to use a cloud provider (${name}), which Work cannot run inside a sandbox. Unset it to use the Claude login instead.`;
      }
    }
    return null;
  }

  private async readOauth(): Promise<ClaudeOauth | null> {
    const stored = await this.store.read();
    const oauth = stored?.claudeAiOauth;
    return oauth && typeof oauth === 'object' ? (oauth as ClaudeOauth) : null;
  }

  /** The stored login, refreshed (single flight) when close to expiry. */
  private async fresh(signal?: AbortSignal): Promise<ClaudeOauth> {
    const oauth = await this.readOauth();
    if (!oauth?.accessToken) {
      throw new WorkAgentLoginError(signInHint('Claude Code', 'claude'));
    }
    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
    if (!expiresAt || expiresAt - Date.now() > LOGIN_REFRESH_MARGIN_MS) {
      return oauth;
    }
    this.refreshing ??= this.refreshStored(signal).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshStored(signal?: AbortSignal): Promise<ClaudeOauth> {
    // Read again right before refreshing: the CLI may have just done it.
    const stored = (await this.store.read()) ?? {};
    const oauth = (stored.claudeAiOauth ?? {}) as ClaudeOauth;
    if (
      oauth.accessToken &&
      typeof oauth.expiresAt === 'number' &&
      oauth.expiresAt - Date.now() > LOGIN_REFRESH_MARGIN_MS
    ) {
      return oauth;
    }
    if (!oauth.refreshToken) {
      throw new WorkAgentLoginError(expiredHint('Claude Code', 'claude'));
    }
    let tokens: RefreshedTokens;
    try {
      tokens = await this.refresh(oauth.refreshToken, signal);
    } catch (error) {
      logger.warn('Could not refresh the Claude Code login', error);
      throw new WorkAgentLoginError(expiredHint('Claude Code', 'claude'));
    }
    const updated: ClaudeOauth = {
      ...oauth,
      accessToken: tokens.access,
      refreshToken: tokens.refresh ?? oauth.refreshToken,
      expiresAt: tokens.expiresAtMs,
    };
    await this.store.write({ ...stored, claudeAiOauth: updated });
    logger.info('Refreshed the Claude Code login for a Work run.');
    return updated;
  }
}

// --- Codex ---------------------------------------------------------------

export interface CodexSignIn {
  signIn(
    minValidityMs: number,
    signal?: AbortSignal
  ): Promise<{ accessToken: string; accountId?: string; expiresAtMs: number }>;
}

export class CodexHostLogin implements WorkAgentHostLogin {
  constructor(
    private readonly codexHome: () => string = () =>
      environmentValue('CODEX_HOME') ?? path.join(os.homedir(), '.codex'),
    private readonly chatgpt: CodexSignIn = codexOAuthService
  ) {}

  private authFile(): Record<string, unknown> | null {
    return readJson(path.join(this.codexHome(), 'auth.json'));
  }

  readonly status = cachedStatus(async () => {
    if (environmentValue('CODEX_API_KEY')) return { ready: true };
    const auth = this.authFile();
    const tokens = auth?.tokens as Record<string, unknown> | undefined;
    return typeof tokens?.refresh_token === 'string' ||
      typeof auth?.OPENAI_API_KEY === 'string'
      ? { ready: true }
      : { ready: false, reason: signInHint('Codex', 'codex login') };
  });

  async prepare(
    _model: string | undefined,
    signal?: AbortSignal
  ): Promise<WorkAgentLogin> {
    const model = this.configuredModel();
    const withModel = model ? { model } : {};
    const fromEnvironment = environmentValue('CODEX_API_KEY');
    if (fromEnvironment) {
      const placeholder = createEgressPlaceholder();
      return {
        credentials: [
          credential(
            'CODEX_API_KEY',
            placeholder,
            fromEnvironment,
            OPENAI_HOSTS
          ),
        ],
        env: { CODEX_API_KEY: placeholder },
        files: [],
        ...withModel,
      };
    }
    const auth = this.authFile();
    const tokens = auth?.tokens as Record<string, unknown> | undefined;
    if (typeof tokens?.refresh_token !== 'string') {
      const apiKey = auth?.OPENAI_API_KEY;
      if (typeof apiKey !== 'string' || !apiKey) {
        throw new WorkAgentLoginError(signInHint('Codex', 'codex login'));
      }
      const placeholder = createEgressPlaceholder();
      return {
        credentials: [
          credential('OPENAI_API_KEY', placeholder, apiKey, OPENAI_HOSTS),
        ],
        env: {},
        files: [jsonFile('.codex/auth.json', { OPENAI_API_KEY: placeholder })],
        ...withModel,
      };
    }

    let signIn: Awaited<ReturnType<CodexSignIn['signIn']>>;
    try {
      signIn = await this.chatgpt.signIn(LOGIN_REFRESH_MARGIN_MS, signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn('Could not refresh the Codex login', error);
      throw new WorkAgentLoginError(expiredHint('Codex', 'codex login'));
    }
    const secret = new LiveSecret(signIn.accessToken);
    const accessPlaceholder = placeholderFor(signIn.accessToken);
    const accountId =
      signIn.accountId ??
      (typeof tokens.account_id === 'string' ? tokens.account_id : undefined);
    // Only what the CLI reads from its ID token: plan and account.
    const idClaims = jwtClaims(String(tokens.id_token ?? ''));
    const idAuth = (idClaims?.[OPENAI_AUTH_CLAIM] ?? {}) as Record<
      string,
      unknown
    >;
    const idToken = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      exp: Math.floor((Date.now() + SANDBOX_VALIDITY_MS) / 1000),
      [OPENAI_AUTH_CLAIM]: {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: idAuth.chatgpt_plan_type,
      },
    })}.${createEgressPlaceholder()}`;
    return {
      credentials: [
        credential(
          'CODEX_ACCESS_TOKEN',
          accessPlaceholder,
          secret,
          CHATGPT_HOSTS
        ),
      ],
      env: {},
      files: [
        jsonFile('.codex/auth.json', {
          ...(typeof auth?.auth_mode === 'string'
            ? { auth_mode: auth.auth_mode }
            : {}),
          OPENAI_API_KEY: null,
          tokens: {
            id_token: idToken,
            access_token: accessPlaceholder,
            // Never sent anywhere the proxy rewrites: a refresh cannot work.
            refresh_token: createEgressPlaceholder(),
            ...(accountId ? { account_id: accountId } : {}),
          },
          last_refresh: new Date().toISOString(),
        }),
      ],
      ...withModel,
      refresh: async refreshSignal => {
        const next = await this.chatgpt.signIn(
          LOGIN_REFRESH_MARGIN_MS,
          refreshSignal
        );
        secret.set(next.accessToken);
      },
    };
  }

  /** The default model in the CLI's config, which Chat's runs pick up. */
  private configuredModel(): string | undefined {
    try {
      const config = fs.readFileSync(
        path.join(this.codexHome(), 'config.toml'),
        'utf8'
      );
      // Top-level keys come before the first [table].
      const topLevel = config.split(/^\s*\[/m)[0];
      const match = /^\s*model\s*=\s*"([^"\n]{1,200})"\s*$/m.exec(topLevel);
      return match?.[1];
    } catch {
      return undefined;
    }
  }
}

// --- Kiro ----------------------------------------------------------------

interface KiroToken {
  key: string;
  value: Record<string, unknown>;
}

const KIRO_SANDBOX_DB = '.local/share/kiro-cli/data.sqlite3';
/** state keys that never go into a sandbox copy. */
const KIRO_PRIVATE_STATE =
  /token|secret|password|credential|session|history|conversation/i;

function kiroExpiry(value: Record<string, unknown>): number {
  const raw = value.expires_at ?? value.expiresAt;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Kiro keeps its login in a SQLite database. The sandbox gets a copy with
 * the same schema, the login rows rewritten to placeholders, and nothing
 * else of the user's: chat history, sessions, and the OAuth client
 * registration are dropped and the file is vacuumed so no freed page
 * carries them along.
 */
export class KiroHostLogin implements WorkAgentHostLogin {
  constructor(
    private readonly databasePath: () => string = () =>
      process.platform === 'darwin'
        ? path.join(
            os.homedir(),
            'Library',
            'Application Support',
            'kiro-cli',
            'data.sqlite3'
          )
        : path.join(xdgDataHome(), 'kiro-cli', 'data.sqlite3'),
    /** Lets Kiro refresh its own login on the host. */
    private readonly refreshOnHost: (
      signal?: AbortSignal
    ) => Promise<void> = async signal => {
      const binary = resolveBinary('kiro-cli');
      if (binary) await runHost(binary, ['whoami'], { signal });
    }
  ) {}

  readonly status = cachedStatus(async () => {
    if (environmentValue('KIRO_API_KEY')) return { ready: true };
    return this.readTokens().length > 0
      ? { ready: true }
      : { ready: false, reason: signInHint('Kiro', 'kiro-cli login') };
  });

  async prepare(
    _model: string | undefined,
    signal?: AbortSignal
  ): Promise<WorkAgentLogin> {
    const apiKey = environmentValue('KIRO_API_KEY');
    if (apiKey) {
      const placeholder = createEgressPlaceholder();
      return {
        credentials: [
          credential('KIRO_API_KEY', placeholder, apiKey, KIRO_HOSTS),
        ],
        env: { KIRO_API_KEY: placeholder },
        files: [],
      };
    }
    const tokens = await this.freshTokens(signal);
    const secrets = new Map<string, LiveSecret>();
    const placeholders = new Map<string, string>();
    for (const token of tokens) {
      const access = String(token.value.access_token);
      secrets.set(token.key, new LiveSecret(access));
      placeholders.set(token.key, placeholderFor(access));
    }
    return {
      credentials: tokens.map(token =>
        credential(
          `KIRO_LOGIN:${token.key}`,
          placeholders.get(token.key) as string,
          secrets.get(token.key) as LiveSecret,
          KIRO_HOSTS
        )
      ),
      env: {},
      files: [
        {
          path: KIRO_SANDBOX_DB,
          content: await this.sandboxDatabase(placeholders),
        },
      ],
      refresh: async refreshSignal => {
        for (const token of await this.freshTokens(refreshSignal)) {
          secrets.get(token.key)?.set(String(token.value.access_token));
        }
      },
    };
  }

  /** Login rows: auth_kv entries ending in `:token` with an access token. */
  private readTokens(): KiroToken[] {
    try {
      return readKiroLoginRows(this.databasePath()).flatMap(row => {
        try {
          const value = JSON.parse(row.value) as Record<string, unknown>;
          return typeof value.access_token === 'string' && value.access_token
            ? [{ key: row.key, value }]
            : [];
        } catch {
          return [];
        }
      });
    } catch (error) {
      logger.warn('Could not read the Kiro login database', error);
      return [];
    }
  }

  private async freshTokens(signal?: AbortSignal): Promise<KiroToken[]> {
    const stale = (tokens: KiroToken[]) =>
      tokens.some(token => {
        const expiry = kiroExpiry(token.value);
        return expiry > 0 && expiry - Date.now() < LOGIN_REFRESH_MARGIN_MS;
      });
    let tokens = this.readTokens();
    if (tokens.length === 0) {
      throw new WorkAgentLoginError(signInHint('Kiro', 'kiro-cli login'));
    }
    if (stale(tokens)) {
      await this.refreshOnHost(signal);
      signal?.throwIfAborted();
      tokens = this.readTokens();
      if (tokens.length === 0 || stale(tokens)) {
        throw new WorkAgentLoginError(expiredHint('Kiro', 'kiro-cli login'));
      }
    }
    return tokens;
  }

  /** The login rows become placeholders; every other auth_kv row goes. */
  private sandboxDatabase(
    placeholders: ReadonlyMap<string, string>
  ): Promise<Buffer> {
    return scrubbedKiroDatabase(
      this.databasePath(),
      (key, raw) => {
        const placeholder = placeholders.get(key);
        if (!placeholder) return null;
        const value = JSON.parse(raw) as Record<string, unknown>;
        const expiresAt = new Date(Date.now() + SANDBOX_VALIDITY_MS);
        const rewritten: Record<string, unknown> = {
          ...value,
          access_token: placeholder,
          refresh_token: createEgressPlaceholder(),
        };
        delete rewritten.client_secret;
        if ('expires_at' in value) {
          rewritten.expires_at =
            typeof value.expires_at === 'number'
              ? Math.floor(expiresAt.getTime() / 1000)
              : expiresAt.toISOString();
        }
        return JSON.stringify(rewritten);
      },
      KIRO_PRIVATE_STATE
    );
  }
}

// --- OpenCode and Pi -----------------------------------------------------

type ProviderEntry = Record<string, unknown> & { type?: unknown };

interface ProviderLoginOptions {
  readonly cli: string;
  readonly loginCommand: string;
  /** Sandbox path of the CLI's auth file, relative to home. */
  readonly sandboxAuthFile: string;
  /** Entry type names the CLI uses for a key and for an OAuth login. */
  readonly apiType: string;
}

/**
 * The shared shape of OpenCode's and Pi's logins: one auth file, one entry
 * per provider, either a key or an OAuth login with `access`, `refresh`,
 * and `expires`.
 */
abstract class ProviderAuthFileLogin implements WorkAgentHostLogin {
  private refreshing = new Map<string, Promise<ProviderEntry>>();

  constructor(
    protected readonly options: ProviderLoginOptions,
    protected readonly authPath: () => string,
    private readonly refreshers: Readonly<
      Record<string, ProviderRefresh>
    > = PROVIDER_REFRESH
  ) {}

  protected authFile(): Record<string, ProviderEntry> {
    return (readJson(this.authPath()) ?? {}) as Record<string, ProviderEntry>;
  }

  abstract status(): Promise<WorkAgentLoginStatus>;
  abstract prepare(
    model: string | undefined,
    signal?: AbortSignal
  ): Promise<WorkAgentLogin>;

  protected hasAnyLogin(): boolean {
    if (Object.keys(this.authFile()).length > 0) return true;
    return Object.values(PROVIDER_KEY_VARIABLES).some(names =>
      names.some(name => environmentValue(name))
    );
  }

  /** The sandbox login for one provider, with its auth file entry. */
  protected async providerLogin(
    provider: string,
    signal?: AbortSignal
  ): Promise<{
    credentials: EgressCredential[];
    env: Record<string, string>;
    entry?: ProviderEntry;
    refresh?: (signal?: AbortSignal) => Promise<void>;
  }> {
    const { cli, loginCommand } = this.options;
    const hosts = WORK_AGENT_PROVIDER_HOSTS[provider];
    const entry = this.authFile()[provider];
    if (!hosts) {
      throw new WorkAgentLoginError(
        `${cli}'s "${provider}" provider cannot run in Work yet: Libre WebUI does not know which API hosts its login may be sent to.`
      );
    }
    if (!entry) {
      for (const name of PROVIDER_KEY_VARIABLES[provider] ?? []) {
        const value = environmentValue(name);
        if (!value) continue;
        const placeholder = createEgressPlaceholder();
        return {
          credentials: [credential(name, placeholder, value, hosts)],
          env: { [name]: placeholder },
        };
      }
      throw new WorkAgentLoginError(
        `${cli} has no login for "${provider}" on this server. Run \`${loginCommand}\` as the server user, then try again.`
      );
    }
    if (entry.type === this.options.apiType && typeof entry.key === 'string') {
      const placeholder = createEgressPlaceholder();
      return {
        credentials: [credential(provider, placeholder, entry.key, hosts)],
        env: {},
        entry: { type: entry.type, key: placeholder },
      };
    }
    if (entry.type === 'oauth' && typeof entry.access === 'string') {
      const fresh = await this.freshOauth(provider, signal);
      const secret = new LiveSecret(String(fresh.access));
      const placeholder = placeholderFor(String(fresh.access));
      const sandboxEntry: ProviderEntry = { ...fresh };
      sandboxEntry.access = placeholder;
      sandboxEntry.refresh = createEgressPlaceholder();
      sandboxEntry.expires = Date.now() + SANDBOX_VALIDITY_MS;
      return {
        credentials: [credential(provider, placeholder, secret, hosts)],
        env: {},
        entry: sandboxEntry,
        refresh: async refreshSignal => {
          const next = await this.freshOauth(provider, refreshSignal);
          secret.set(String(next.access));
        },
      };
    }
    throw new WorkAgentLoginError(
      `${cli}'s "${provider}" login is a kind Work cannot carry into a sandbox yet.`
    );
  }

  private freshOauth(
    provider: string,
    signal?: AbortSignal
  ): Promise<ProviderEntry> {
    const entry = this.authFile()[provider];
    const expires = typeof entry?.expires === 'number' ? entry.expires : 0;
    if (entry && expires - Date.now() > LOGIN_REFRESH_MARGIN_MS) {
      return Promise.resolve(entry);
    }
    let flight = this.refreshing.get(provider);
    if (!flight) {
      flight = this.refreshEntry(provider, signal).finally(() => {
        this.refreshing.delete(provider);
      });
      this.refreshing.set(provider, flight);
    }
    return flight;
  }

  private async refreshEntry(
    provider: string,
    signal?: AbortSignal
  ): Promise<ProviderEntry> {
    const { cli, loginCommand } = this.options;
    const expired = new WorkAgentLoginError(
      `${cli}'s "${provider}" login on this server has expired and could not be refreshed. Run \`${loginCommand}\` as the server user, then try again.`
    );
    const refresh = this.refreshers[provider];
    const entry = this.authFile()[provider];
    if (!refresh || !entry || typeof entry.refresh !== 'string') throw expired;
    let tokens: RefreshedTokens;
    try {
      tokens = await refresh(entry.refresh, signal);
    } catch (error) {
      logger.warn(`Could not refresh ${cli}'s ${provider} login`, error);
      throw expired;
    }
    const updated: ProviderEntry = {
      ...entry,
      access: tokens.access,
      refresh: tokens.refresh ?? entry.refresh,
      expires: tokens.expiresAtMs,
    };
    // Re-read so a login the CLI changed meanwhile is not overwritten.
    const latest = this.authFile();
    writeJsonPrivate(this.authPath(), { ...latest, [provider]: updated });
    logger.info(`Refreshed ${cli}'s ${provider} login for a Work run.`);
    return updated;
  }
}

/** OpenCode: one auth file for every provider it is signed in to. */
export class OpenCodeHostLogin extends ProviderAuthFileLogin {
  constructor(
    authPath: () => string = () =>
      path.join(xdgDataHome(), 'opencode', 'auth.json'),
    refreshers?: Readonly<Record<string, ProviderRefresh>>
  ) {
    super(
      {
        cli: 'OpenCode',
        loginCommand: 'opencode auth login',
        sandboxAuthFile: '.local/share/opencode/auth.json',
        apiType: 'api',
      },
      authPath,
      refreshers
    );
  }

  readonly status = cachedStatus(async () =>
    this.hasAnyLogin()
      ? { ready: true as const }
      : {
          ready: false as const,
          reason: signInHint('OpenCode', 'opencode auth login'),
        }
  );

  async prepare(
    model: string | undefined,
    signal?: AbortSignal
  ): Promise<WorkAgentLogin> {
    const provider = model?.split('/')[0];
    if (!provider || !model?.includes('/')) {
      throw new WorkAgentLoginError(
        'OpenCode in Work needs a model chosen as provider/model.'
      );
    }
    const login = await this.providerLogin(provider, signal);
    return {
      credentials: login.credentials,
      env: login.env,
      files: login.entry
        ? [jsonFile(this.options.sandboxAuthFile, { [provider]: login.entry })]
        : [],
      ...(login.refresh ? { refresh: login.refresh } : {}),
    };
  }
}

/**
 * Pi: an auth file beside its settings. Chat runs Pi on its configured
 * default model, and so does Work, unless a provider/model is chosen.
 */
export class PiHostLogin extends ProviderAuthFileLogin {
  constructor(
    private readonly agentDir: () => string = () =>
      environmentValue('PI_CODING_AGENT_DIR') ??
      path.join(os.homedir(), '.pi', 'agent'),
    refreshers?: Readonly<Record<string, ProviderRefresh>>
  ) {
    super(
      {
        cli: 'Pi',
        loginCommand: 'pi',
        sandboxAuthFile: '.pi/agent/auth.json',
        apiType: 'api_key',
      },
      () => path.join(agentDir(), 'auth.json'),
      refreshers
    );
  }

  readonly status = cachedStatus(async () =>
    this.hasAnyLogin()
      ? { ready: true as const }
      : { ready: false as const, reason: signInHint('Pi', 'pi') }
  );

  async prepare(
    model: string | undefined,
    signal?: AbortSignal
  ): Promise<WorkAgentLogin> {
    let provider: string | undefined;
    let modelId: string | undefined;
    if (model?.includes('/')) {
      [provider] = model.split('/');
      modelId = model.slice(provider.length + 1) || undefined;
    } else {
      const settings = readJson(path.join(this.agentDir(), 'settings.json'));
      if (typeof settings?.defaultProvider === 'string') {
        provider = settings.defaultProvider;
        modelId =
          model ??
          (typeof settings.defaultModel === 'string'
            ? settings.defaultModel
            : undefined);
      } else {
        // Pi picks a provider it has a login for; so does Work.
        provider = Object.keys(this.authFile()).find(
          name => WORK_AGENT_PROVIDER_HOSTS[name]
        );
      }
    }
    if (!provider) {
      throw new WorkAgentLoginError(signInHint('Pi', 'pi'));
    }
    const login = await this.providerLogin(provider, signal);
    return {
      credentials: login.credentials,
      env: login.env,
      files: [
        ...(login.entry
          ? [
              jsonFile(this.options.sandboxAuthFile, {
                [provider]: login.entry,
              }),
            ]
          : []),
        jsonFile('.pi/agent/settings.json', {
          defaultProvider: provider,
          ...(modelId ? { defaultModel: modelId } : {}),
        }),
      ],
      model: modelId ? `${provider}/${modelId}` : `${provider}/`,
      ...(login.refresh ? { refresh: login.refresh } : {}),
    };
  }
}

/** The host login behind each agent CLI Work can run. */
export function createWorkAgentHostLogins(): Record<
  WorkAgentCliId,
  WorkAgentHostLogin
> {
  return {
    'claude-code': new ClaudeCodeHostLogin(),
    codex: new CodexHostLogin(),
    kiro: new KiroHostLogin(),
    opencode: new OpenCodeHostLogin(),
    pi: new PiHostLogin(),
  };
}
