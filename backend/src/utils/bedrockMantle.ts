/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Plugin } from '../types/index.js';

/**
 * Amazon Bedrock through its Mantle endpoint, which takes a Bedrock API key as
 * a bearer token and lists every model the account can call from one
 * `/v1/models` route. Chat is split across three routes on the same host:
 * Claude only answers the Anthropic Messages API, and the remaining models
 * answer Chat Completions on either `/v1` or `/openai/v1` with no field in the
 * catalog saying which. Claude is routed by its ID; the other two are tried in
 * order and the route that answers is remembered per model.
 */

export const BEDROCK_PLUGIN_ID = 'bedrock';
export const BEDROCK_DEFAULT_REGION = 'us-east-1';

/** Commercial Regions that publish a bedrock-mantle endpoint. */
export const BEDROCK_MANTLE_REGIONS: readonly string[] = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
];

const MANTLE_HOST = /^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/;
const ANTHROPIC_MODEL = /^(?:[a-z]{2,6}\.)?anthropic\./;
const ROUTE_MISMATCH = /(?:isn't|is not|not) supported on this route/i;
const ROUTE_CACHE_LIMIT = 512;

export type BedrockChatRoute = 'anthropic' | 'mantle' | 'openai';
type CompletionsRoute = Exclude<BedrockChatRoute, 'anthropic'>;

const ROUTE_PATHS: Record<BedrockChatRoute, string> = {
  anthropic: '/anthropic/v1/messages',
  mantle: '/v1/chat/completions',
  openai: '/openai/v1/chat/completions',
};

// Families Mantle serves only on /openai/v1, so the first call skips a 400.
const OPENAI_ROUTE_MODELS = [/^xai\./, /^google\.gemma-4/];

const learnedRoutes = new Map<string, CompletionsRoute>();

export function isBedrockPlugin(plugin: Pick<Plugin, 'id'>): boolean {
  return plugin.id === BEDROCK_PLUGIN_ID;
}

export function isBedrockAnthropicModel(model: string): boolean {
  return ANTHROPIC_MODEL.test(model.trim().toLowerCase());
}

/** The Claude model name without the Bedrock provider prefix. */
export function bedrockAnthropicModelName(model: string): string {
  return model.trim().replace(ANTHROPIC_MODEL, '');
}

export function isBedrockMantleRegion(value: unknown): value is string {
  return typeof value === 'string' && BEDROCK_MANTLE_REGIONS.includes(value);
}

function mantleOrigin(endpoint: string): URL | undefined {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || !MANTLE_HOST.test(url.hostname)) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Point a Mantle endpoint at the chosen Region. Only Mantle hosts are
 * rewritten, and only to another listed Region, so the setting can never send
 * the key anywhere except bedrock-mantle.<region>.api.aws.
 */
export function applyBedrockRegion(endpoint: string, region: unknown): string {
  if (!isBedrockMantleRegion(region)) return endpoint;
  const url = mantleOrigin(endpoint);
  if (!url) return endpoint;
  url.hostname = `bedrock-mantle.${region}.api.aws`;
  return url.toString();
}

function routeKey(endpoint: string, model: string): string | undefined {
  const url = mantleOrigin(endpoint);
  return url ? `${url.host}\n${model.trim()}` : undefined;
}

export function bedrockChatRoute(
  endpoint: string,
  model: string
): BedrockChatRoute {
  if (isBedrockAnthropicModel(model)) return 'anthropic';
  const key = routeKey(endpoint, model);
  const learned = key ? learnedRoutes.get(key) : undefined;
  if (learned) return learned;
  return OPENAI_ROUTE_MODELS.some(pattern => pattern.test(model.trim()))
    ? 'openai'
    : 'mantle';
}

export function bedrockRouteEndpoint(
  endpoint: string,
  route: BedrockChatRoute
): string {
  const url = mantleOrigin(endpoint);
  if (!url) return endpoint;
  return `${url.origin}${ROUTE_PATHS[route]}`;
}

function rememberRoute(
  endpoint: string,
  model: string,
  route: CompletionsRoute
): void {
  const key = routeKey(endpoint, model);
  if (!key) return;
  learnedRoutes.delete(key);
  learnedRoutes.set(key, route);
  if (learnedRoutes.size > ROUTE_CACHE_LIMIT) {
    const oldest = learnedRoutes.keys().next().value;
    if (oldest !== undefined) learnedRoutes.delete(oldest);
  }
}

/** Test hook: forget every remembered route. */
export function resetBedrockRoutes(): void {
  learnedRoutes.clear();
}

/** The URL a chat request for this model goes to. */
export function pluginChatEndpoint(
  plugin: Pick<Plugin, 'id'>,
  endpoint: string,
  model: string
): string {
  if (!isBedrockPlugin(plugin)) return endpoint;
  return bedrockRouteEndpoint(endpoint, bedrockChatRoute(endpoint, model));
}

/** Which wire format a plugin speaks for a given model. */
export function pluginChatProtocol(
  plugin: Pick<Plugin, 'id'>,
  model: string
): 'anthropic' | 'gemini' | 'openai' {
  if (plugin.id === 'anthropic') return 'anthropic';
  if (plugin.id === 'gemini') return 'gemini';
  if (isBedrockPlugin(plugin) && isBedrockAnthropicModel(model)) {
    return 'anthropic';
  }
  return 'openai';
}

export function isBedrockRouteMismatch(status: number, body: unknown): boolean {
  if (status !== 400) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return ROUTE_MISMATCH.test(text);
}

function alternateRoute(route: CompletionsRoute): CompletionsRoute {
  return route === 'mantle' ? 'openai' : 'mantle';
}

/**
 * Send a chat request, retrying once on the other Chat Completions route when
 * Mantle says the model lives there. `send` is called with the final URL; for
 * any other plugin it runs exactly once against `pluginChatEndpoint`.
 */
export async function sendPluginChat<T>(
  plugin: Pick<Plugin, 'id'>,
  endpoint: string,
  model: string,
  send: (url: string) => Promise<T>,
  mismatch: (result: T | undefined, error: unknown) => Promise<boolean>
): Promise<T> {
  const route = isBedrockPlugin(plugin)
    ? bedrockChatRoute(endpoint, model)
    : undefined;
  if (!route || route === 'anthropic' || !mantleOrigin(endpoint)) {
    return send(pluginChatEndpoint(plugin, endpoint, model));
  }

  let result: T | undefined;
  let failure: unknown;
  try {
    result = await send(bedrockRouteEndpoint(endpoint, route));
  } catch (error) {
    failure = error;
  }
  if (!(await mismatch(result, failure))) {
    if (failure !== undefined) throw failure;
    return result as T;
  }

  const next = alternateRoute(route);
  const retried = await send(bedrockRouteEndpoint(endpoint, next));
  rememberRoute(endpoint, model, next);
  return retried;
}

/** `sendPluginChat` for fetch callers that read the Response themselves. */
export function fetchPluginChat(
  plugin: Pick<Plugin, 'id'>,
  endpoint: string,
  model: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return sendPluginChat(
    plugin,
    endpoint,
    model,
    url => fetchImpl(url, init),
    async response =>
      response !== undefined &&
      response.status === 400 &&
      isBedrockRouteMismatch(400, await response.clone().text())
  );
}

/** `sendPluginChat` for callers whose client throws on a non-2xx status. */
export function requestPluginChat<T>(
  plugin: Pick<Plugin, 'id'>,
  endpoint: string,
  model: string,
  send: (url: string) => Promise<T>
): Promise<T> {
  return sendPluginChat(plugin, endpoint, model, send, async (_, error) => {
    const response = (
      error as { response?: { status?: unknown; data?: unknown } } | undefined
    )?.response;
    return (
      typeof response?.status === 'number' &&
      isBedrockRouteMismatch(response.status, response.data)
    );
  });
}
