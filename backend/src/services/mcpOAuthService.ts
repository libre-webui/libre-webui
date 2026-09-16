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
 * Interactive OAuth for MCP tool servers.
 *
 * An MCP server that answers 401 with a `WWW-Authenticate` challenge is
 * pointing at its protected-resource metadata. From there this module walks
 * the standard path: protected-resource metadata -> authorization-server
 * metadata -> dynamic client registration (RFC 7591) when the server offers
 * it, otherwise an administrator-supplied client id. What it learns is
 * per-server, so it lives in `system_settings` under
 * `tools.mcp-oauth.<serverId>`; the only secret in that blob (a static
 * client secret) is encrypted.
 *
 * The browser half is an ordinary redirect flow with PKCE S256 and the
 * shared CSRF-state cookie. Tokens are per user, encrypted into the existing
 * `tool_server_credentials.secret` column, and never leave the server: the
 * callback stores them and redirects the browser back to the app with a
 * status flag only.
 */

import { createHash, randomBytes } from 'node:crypto';
import { ResourcePolicyError } from '../utils/resourceLimits.js';
import { secureToolRequest } from '../utils/toolEgress.js';
import { encryptionService } from './encryptionService.js';
import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';
import type { OAuthFlowScope } from './oauthSecurity.js';

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_DOCUMENT_BYTES = 128 * 1024;
/** Refresh this far ahead of expiry so an in-flight call cannot age out. */
export const OAUTH_EXPIRY_MARGIN_MS = 60_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface McpOAuthConfig {
  v: 1;
  /** Issuer (or base) of the authorization server this resource trusts. */
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** Canonical resource identifier to bind tokens to (RFC 8707). */
  resource?: string;
  scope?: string;
  clientId: string;
  /** Encrypted at rest; only this module ever decrypts it. */
  clientSecretEncrypted?: string;
  /** True when the client id came from dynamic registration. */
  dynamicallyRegistered?: boolean;
  discoveredAt: number;
}

/** The per-user token set stored in the credential envelope. */
export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

interface StoredOAuthEnvelope {
  v: 1;
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

const settingKey = (serverId: string): string => `tools.mcp-oauth.${serverId}`;

/** Cookie scope for one server's flow, so two servers cannot cross over. */
export const mcpOAuthFlowScope = (serverId: string): OAuthFlowScope => ({
  cookieName: `libre_oauth_state_mcp_${serverId}`,
  cookiePath: `/api/tools/servers/${serverId}/oauth`,
});

/** Public origin of this instance, the same way the auth routes derive it. */
export const publicBaseUrl = (): string => {
  const configured =
    process.env.BASE_URL?.trim() ||
    process.env.CORS_ORIGIN?.split(',')[0]?.trim() ||
    'http://localhost:3001';
  return configured.replace(/\/$/, '');
};

export const mcpOAuthRedirectUri = (serverId: string): string =>
  `${publicBaseUrl()}/api/tools/servers/${serverId}/oauth/callback`;

/**
 * Discovered endpoints carry tokens, so they must be https. Loopback is the
 * one exception, for a developer running an authorization server locally.
 */
const assertSafeEndpoint = (rawUrl: string, label: string): URL => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ResourcePolicyError(`The ${label} is not a valid URL`, 400);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new ResourcePolicyError(`The ${label} must use https`, 400);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringField = (
  document: Record<string, unknown>,
  field: string
): string | undefined => {
  const value = document[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const fetchJsonDocument = async (
  url: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> => {
  let response;
  try {
    response = await secureToolRequest({
      url,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs,
      maxResponseBytes: MAX_DOCUMENT_BYTES,
    });
  } catch {
    return null;
  }
  if (response.status >= 400 || response.truncated) return null;
  try {
    return asRecord(JSON.parse(response.bodyText));
  } catch {
    return null;
  }
};

/** The `resource_metadata` hint of an RFC 9728 `WWW-Authenticate` challenge. */
export const resourceMetadataUrlFromChallenge = (
  challenge: string | undefined
): string | undefined => {
  if (!challenge) return undefined;
  const quoted = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challenge);
  if (quoted?.[1]) return quoted[1];
  const bare = /resource_metadata\s*=\s*([^\s,]+)/i.exec(challenge);
  return bare?.[1];
};

const trimmedPath = (url: URL): string =>
  url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');

const protectedResourceCandidates = (
  baseUrl: string,
  challenge: string | undefined
): string[] => {
  const hint = resourceMetadataUrlFromChallenge(challenge);
  const url = new URL(baseUrl);
  const path = trimmedPath(url);
  return [
    ...new Set([
      ...(hint ? [hint] : []),
      ...(path
        ? [`${url.origin}/.well-known/oauth-protected-resource${path}`]
        : []),
      `${url.origin}/.well-known/oauth-protected-resource`,
    ]),
  ];
};

const authorizationServerCandidates = (issuer: string): string[] => {
  const url = new URL(issuer);
  const path = trimmedPath(url);
  return [
    ...new Set([
      `${url.origin}/.well-known/oauth-authorization-server${path}`,
      `${url.origin}/.well-known/openid-configuration${path}`,
      `${url.origin}${path}/.well-known/openid-configuration`,
    ]),
  ];
};

export interface DiscoveredMcpOAuth {
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource?: string;
  scope?: string;
}

/**
 * Walk protected-resource metadata to the authorization server's own
 * metadata. `challenge` is the verbatim WWW-Authenticate header of the 401
 * that started this, when the server sent one.
 */
export async function discoverMcpOAuth(input: {
  baseUrl: string;
  challenge?: string;
  timeoutMs?: number;
}): Promise<DiscoveredMcpOAuth> {
  const timeoutMs = input.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  let resourceDocument: Record<string, unknown> | null = null;
  for (const candidate of protectedResourceCandidates(
    input.baseUrl,
    input.challenge
  )) {
    assertSafeEndpoint(candidate, 'protected-resource metadata URL');
    resourceDocument = await fetchJsonDocument(candidate, timeoutMs);
    if (resourceDocument) break;
  }
  if (!resourceDocument) {
    throw new ResourcePolicyError(
      'This MCP server did not publish OAuth protected-resource metadata',
      400
    );
  }

  const servers = Array.isArray(resourceDocument.authorization_servers)
    ? resourceDocument.authorization_servers.filter(
        (entry): entry is string => typeof entry === 'string' && !!entry.trim()
      )
    : [];
  const issuer = servers[0];
  if (!issuer) {
    throw new ResourcePolicyError(
      'The protected-resource metadata names no authorization server',
      400
    );
  }
  assertSafeEndpoint(issuer, 'authorization server URL');

  let metadata: Record<string, unknown> | null = null;
  for (const candidate of authorizationServerCandidates(issuer)) {
    metadata = await fetchJsonDocument(candidate, timeoutMs);
    if (metadata) break;
  }
  if (!metadata) {
    throw new ResourcePolicyError(
      'The authorization server published no discovery document',
      400
    );
  }

  const authorizationEndpoint = stringField(metadata, 'authorization_endpoint');
  const tokenEndpoint = stringField(metadata, 'token_endpoint');
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new ResourcePolicyError(
      'The authorization server metadata is missing its endpoints',
      400
    );
  }
  assertSafeEndpoint(authorizationEndpoint, 'authorization endpoint');
  assertSafeEndpoint(tokenEndpoint, 'token endpoint');
  const registrationEndpoint = stringField(metadata, 'registration_endpoint');
  if (registrationEndpoint) {
    assertSafeEndpoint(registrationEndpoint, 'registration endpoint');
  }

  const scopes = Array.isArray(resourceDocument.scopes_supported)
    ? resourceDocument.scopes_supported.filter(
        (entry): entry is string => typeof entry === 'string'
      )
    : [];
  const resource = stringField(resourceDocument, 'resource');

  return {
    authorizationServer: stringField(metadata, 'issuer') ?? issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(resource ? { resource } : {}),
    ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
  };
}

/** RFC 7591 dynamic client registration. */
export async function registerOAuthClient(input: {
  registrationEndpoint: string;
  redirectUri: string;
  clientName: string;
  scope?: string;
  timeoutMs?: number;
}): Promise<{ clientId: string; clientSecret?: string }> {
  const response = await secureToolRequest({
    url: input.registrationEndpoint,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: [input.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(input.scope ? { scope: input.scope } : {}),
    }),
    timeoutMs: input.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    maxResponseBytes: MAX_DOCUMENT_BYTES,
  });
  if (response.status >= 400 || response.truncated) {
    throw new ResourcePolicyError(
      'The authorization server refused dynamic client registration',
      400
    );
  }
  let document: Record<string, unknown> | null;
  try {
    document = asRecord(JSON.parse(response.bodyText));
  } catch {
    document = null;
  }
  const clientId = document ? stringField(document, 'client_id') : undefined;
  if (!clientId) {
    throw new ResourcePolicyError(
      'The client registration response carried no client id',
      400
    );
  }
  const clientSecret = document
    ? stringField(document, 'client_secret')
    : undefined;
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

export function buildAuthorizeUrl(
  config: McpOAuthConfig,
  input: { state: string; codeChallenge: string; redirectUri: string }
): string {
  const url = new URL(config.authorizationEndpoint);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (config.scope) params.set('scope', config.scope);
  if (config.resource) params.set('resource', config.resource);
  // Keep any query the authorization endpoint itself published.
  for (const [key, value] of url.searchParams) {
    if (!params.has(key)) params.set(key, value);
  }
  url.search = params.toString();
  return url.toString();
}

const clientSecretOf = (config: McpOAuthConfig): string | undefined =>
  config.clientSecretEncrypted
    ? encryptionService.decrypt(config.clientSecretEncrypted)
    : undefined;

const readTokenResponse = (
  bodyText: string,
  previous?: McpOAuthTokens
): McpOAuthTokens => {
  let document: Record<string, unknown> | null;
  try {
    document = asRecord(JSON.parse(bodyText));
  } catch {
    document = null;
  }
  const accessToken = document
    ? stringField(document, 'access_token')
    : undefined;
  if (!accessToken) {
    throw new ResourcePolicyError(
      'The token response carried no access token',
      400
    );
  }
  const refreshToken =
    (document ? stringField(document, 'refresh_token') : undefined) ??
    previous?.refreshToken;
  const expiresIn = document?.expires_in;
  const scope =
    (document ? stringField(document, 'scope') : undefined) ?? previous?.scope;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn)
      ? { expiresAt: Date.now() + Math.trunc(expiresIn) * 1000 }
      : {}),
    ...(scope ? { scope } : {}),
  };
};

const postToken = async (
  config: McpOAuthConfig,
  body: URLSearchParams,
  timeoutMs: number,
  previous?: McpOAuthTokens
): Promise<McpOAuthTokens> => {
  body.set('client_id', config.clientId);
  const secret = clientSecretOf(config);
  if (secret) body.set('client_secret', secret);
  if (config.resource) body.set('resource', config.resource);
  const response = await secureToolRequest({
    url: config.tokenEndpoint,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    timeoutMs,
    maxResponseBytes: MAX_DOCUMENT_BYTES,
  });
  if (response.status >= 400 || response.truncated) {
    // The body can echo the submitted code or assertion; never log it.
    throw new ResourcePolicyError(
      `The authorization server refused the token request (${response.status})`,
      400
    );
  }
  return readTokenResponse(response.bodyText, previous);
};

export const exchangeAuthorizationCode = (
  config: McpOAuthConfig,
  input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    timeoutMs?: number;
  }
): Promise<McpOAuthTokens> =>
  postToken(
    config,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
    input.timeoutMs ?? DISCOVERY_TIMEOUT_MS
  );

export const refreshAccessToken = (
  config: McpOAuthConfig,
  tokens: McpOAuthTokens,
  timeoutMs?: number
): Promise<McpOAuthTokens> => {
  if (!tokens.refreshToken) {
    throw new ResourcePolicyError(
      'This connection has no refresh token; reconnect the server',
      400
    );
  }
  return postToken(
    config,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
    timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    tokens
  );
};

// === Per-server configuration (system_settings) ===

export async function loadOAuthConfig(
  serverId: string
): Promise<McpOAuthConfig | null> {
  const raw = await getSystemSetting(settingKey(serverId));
  if (!raw) return null;
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed || typeof parsed.clientId !== 'string') return null;
    return parsed as unknown as McpOAuthConfig;
  } catch {
    return null;
  }
}

export async function saveOAuthConfig(
  serverId: string,
  input: DiscoveredMcpOAuth & {
    clientId: string;
    clientSecret?: string;
    dynamicallyRegistered?: boolean;
  }
): Promise<McpOAuthConfig> {
  const config: McpOAuthConfig = {
    v: 1,
    authorizationServer: input.authorizationServer,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    ...(input.registrationEndpoint
      ? { registrationEndpoint: input.registrationEndpoint }
      : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    clientId: input.clientId,
    ...(input.clientSecret
      ? { clientSecretEncrypted: encryptionService.encrypt(input.clientSecret) }
      : {}),
    ...(input.dynamicallyRegistered ? { dynamicallyRegistered: true } : {}),
    discoveredAt: Date.now(),
  };
  await setSystemSetting(settingKey(serverId), JSON.stringify(config));
  return config;
}

/**
 * Forget a server's OAuth configuration. The settings table is a key/value
 * store with no delete, so an empty value is the tombstone
 * `loadOAuthConfig` reads back as "nothing configured".
 */
export const deleteOAuthConfig = (serverId: string): Promise<void> =>
  setSystemSetting(settingKey(serverId), '');

/**
 * Discover (and, where possible, register) in one step, persisting what it
 * learns against the server id.
 */
export async function configureServerOAuth(input: {
  serverId: string;
  baseUrl: string;
  serverName: string;
  challenge?: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
}): Promise<McpOAuthConfig> {
  const discovered = await discoverMcpOAuth({
    baseUrl: input.baseUrl,
    ...(input.challenge ? { challenge: input.challenge } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (input.clientId?.trim()) {
    return saveOAuthConfig(input.serverId, {
      ...discovered,
      clientId: input.clientId.trim(),
      ...(input.clientSecret?.trim()
        ? { clientSecret: input.clientSecret.trim() }
        : {}),
    });
  }
  if (!discovered.registrationEndpoint) {
    throw new ResourcePolicyError(
      'This authorization server does not register clients automatically; supply an OAuth client id',
      400
    );
  }
  const registered = await registerOAuthClient({
    registrationEndpoint: discovered.registrationEndpoint,
    redirectUri: mcpOAuthRedirectUri(input.serverId),
    clientName: `Libre WebUI (${input.serverName})`,
    ...(discovered.scope ? { scope: discovered.scope } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  return saveOAuthConfig(input.serverId, {
    ...discovered,
    clientId: registered.clientId,
    ...(registered.clientSecret
      ? { clientSecret: registered.clientSecret }
      : {}),
    dynamicallyRegistered: true,
  });
}

// === Credential envelope ===

export const serializeOAuthTokens = (tokens: McpOAuthTokens): string =>
  JSON.stringify({
    v: 1,
    kind: 'oauth',
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  } satisfies StoredOAuthEnvelope);

/** Read an OAuth envelope, or null for the legacy plain-secret rows. */
export const parseOAuthTokens = (secret: string): McpOAuthTokens | null => {
  if (!secret.startsWith('{')) return null;
  try {
    const parsed = asRecord(JSON.parse(secret));
    if (!parsed || parsed.kind !== 'oauth') return null;
    const accessToken = stringField(parsed, 'accessToken');
    if (!accessToken) return null;
    const refreshToken = stringField(parsed, 'refreshToken');
    const scope = stringField(parsed, 'scope');
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof parsed.expiresAt === 'number'
        ? { expiresAt: parsed.expiresAt }
        : {}),
      ...(scope ? { scope } : {}),
    };
  } catch {
    return null;
  }
};

export const tokensAreFresh = (tokens: McpOAuthTokens): boolean =>
  !tokens.expiresAt || Date.now() < tokens.expiresAt - OAUTH_EXPIRY_MARGIN_MS;
