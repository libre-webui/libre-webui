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
 * A DSH provider adapter backed by Libre WebUI's own provider layer.
 *
 * Without this, the engine would need its own provider configuration — its own
 * route, its own credential variable, its own model list — duplicating what the
 * Chat surface already resolves. That parallel stack drifts: a model pulled in
 * the UI would be invisible to the engine, and an operator would maintain two
 * places to say which model to use.
 *
 * So the engine asks Libre WebUI instead. `ctx.llm.registerAdapter` publishes a
 * single route whose models and calls come from a handler Libre WebUI installs
 * at startup, which means the engine uses exactly the providers, credentials,
 * and models the product already manages.
 *
 * The direction of the dependency is deliberate: this module imports nothing
 * from Libre WebUI's services, and Libre WebUI's services import nothing from
 * here. The handler is passed in through {@link registerLibreWebUiProvider}.
 * That keeps the engine substitutable and keeps Libre WebUI's service graph
 * free of engine types.
 *
 * @module cordis/dsh/librewebui-llm-adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type {
  FinishReason,
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { DSH_ENGINE_SERVICE } from '../contracts.js';

/** Plugin name reported to Cordis diagnostics. */
export const name = 'librewebui-llm-adapter';

/** The LLM service must exist before a route can be registered. */
export const inject = ['llm'];

/** Provider route the engine addresses Libre WebUI's providers by. */
export const ROUTE = 'libre-webui';

/** Loader entry id of the adapter row that publishes {@link ROUTE}. */
export const ADAPTER_ENTRY_ID = 'libre-webui-llm-adapter';

/** One model Libre WebUI can serve. */
export interface BridgeModel {
  /** Identifier the provider layer accepts. */
  readonly id: string;
  /** Operator-facing name. */
  readonly name: string;
  /** Concrete provider behind this qualified model route. */
  readonly providerType?: 'ollama' | 'plugin' | 'dsh';
  readonly providerId?: string;
  readonly providerName?: string;
  /** Context window in tokens, when known. */
  readonly contextWindow?: number;
  /** Default output cap in tokens, when known. */
  readonly maxTokens?: number;
}

/** One tool offered to the model, in provider-neutral form. */
export interface BridgeTool {
  /** Model-facing name. */
  readonly name: string;
  /** Model-facing description. */
  readonly description: string;
  /** JSON Schema object for the parameters. */
  readonly parameters: Record<string, unknown>;
}

/** One message handed to Libre WebUI's provider layer. */
export interface BridgeMessage {
  /** Conversation role. */
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  /** Flattened text content. */
  readonly content: string;
  readonly thinking?: string;
  readonly providerMetadata?: Record<string, unknown>;
  /** Assistant tool calls, when this message requested them. */
  readonly toolCalls?: readonly BridgeToolCall[];
  /** Tool calls this message answers, when it is a tool result. */
  readonly toolCallId?: string;
}

/** One tool call the model requested. */
export interface BridgeToolCall {
  /** Provider-assigned identifier, echoed by the matching result. */
  readonly id: string;
  /** Name of the tool the model called. */
  readonly name: string;
  /** Raw JSON argument string exactly as the model produced it. */
  readonly arguments: string;
  readonly providerMetadata?: Record<string, unknown>;
}

/** One increment of a Libre WebUI provider stream. */
export type BridgeEvent =
  /** Text the model produced. */
  | { readonly type: 'text'; readonly text: string }
  /** Reasoning the model produced, when the provider exposes it. */
  | { readonly type: 'reasoning'; readonly text: string }
  /** A tool call the model requested. */
  | { readonly type: 'tool-call'; readonly toolCall: BridgeToolCall }
  /** Token accounting for the call. */
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  /** The call finished; `reason` maps to DSH's finish vocabulary. */
  | {
      readonly type: 'done';
      readonly reason: 'stop' | 'tool-calls' | 'max-tokens' | 'error';
      readonly providerMetadata?: Record<string, unknown>;
    };

/** One streaming call Libre WebUI is asked to serve. */
export interface BridgeCall {
  /** Model identifier the caller selected. */
  readonly model: string;
  /** Conversation so far, oldest first. */
  readonly messages: readonly BridgeMessage[];
  /** Tools the model may call, absent when the request offers none. */
  readonly tools?: readonly BridgeTool[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
  readonly signal?: AbortSignal;
  readonly userId?: string;
  readonly reasoningEffort?: string;
  readonly purpose?: 'session-title' | 'compaction';
}

/**
 * What Libre WebUI must provide for the engine to reach its providers.
 *
 * Implemented by Libre WebUI and handed to {@link registerLibreWebUiProvider};
 * this module never imports the implementation.
 */
export interface LibreWebUiProviderHandler {
  /**
   * List the models the engine may offer.
   * @returns the currently available models.
   */
  listModels(userId?: string): Promise<readonly BridgeModel[]>;
  /**
   * Resolve one model's metadata.
   * @param model - identifier to look up.
   * @returns the model, or undefined when it is not currently available.
   */
  resolveModel(
    model: string,
    userId?: string
  ): Promise<BridgeModel | undefined>;
  /**
   * The model a call should use when the engine names none.
   *
   * Read live rather than pinned in configuration, so changing the default in
   * the UI changes what the engine uses.
   * @returns the model identifier, or undefined when the deployment has none.
   */
  defaultModel(userId?: string): Promise<string | undefined>;
  /**
   * Stream one call.
   * @param call - the request to serve.
   * @returns increments, ending with a `done` event.
   */
  stream(call: BridgeCall): AsyncIterable<BridgeEvent>;
}

let handler: LibreWebUiProviderHandler | undefined;

/**
 * Install the provider handler the engine's adapter delegates to.
 *
 * A plugin row is imported by URL while the application imports its own modules
 * by path, so the two are separate module instances with separate state: a
 * registration made from `src/main.ts` is invisible to a row loaded from
 * `dist/`. The host therefore calls this against the instance the row will use,
 * immediately before the row activates, and this entry point exists for direct
 * use in tests.
 *
 * @param next - the handler, or undefined to withdraw it.
 */
export function setLibreWebUiProvider(
  next: LibreWebUiProviderHandler | undefined
): void {
  handler = next;
}

/** Alias of {@link setLibreWebUiProvider} for callers that read it as a registration. */
export const registerLibreWebUiProvider = setLibreWebUiProvider;

/** Whether a provider handler is installed. */
export function hasLibreWebUiProvider(): boolean {
  return handler !== undefined;
}

/**
 * Read the installed handler.
 * @returns the handler.
 * @throws when no handler is installed, rather than failing a call obscurely.
 */
function requireProvider(): LibreWebUiProviderHandler {
  if (!handler) {
    throw new Error(
      'librewebui-llm-adapter: no Libre WebUI provider handler is installed'
    );
  }
  return handler;
}

/**
 * The adapter the engine calls for the `libre-webui` route.
 *
 * DSH requires the emitted stream to follow a strict grammar: a `block-start`
 * before any delta at that index, a matching `block-end` before the finish, at
 * most one `usage`, and a terminal `finish` that is last. Text and tool-call
 * blocks are opened lazily, so a response that turns out to be tool calls only
 * never opens a text block.
 */
class LibreWebUiAdapter extends LlmAdapter {
  constructor(
    private readonly requestUserId: (sessionId: string) => string | undefined
  ) {
    super();
  }

  /** Model ids this adapter last advertised. */
  private known = new Map<string, BridgeModel>();

  providerInfo(provider: string) {
    return { id: provider, name: 'Libre WebUI' };
  }

  async listModels(provider: string) {
    const models = await requireProvider().listModels();
    this.known = new Map(models.map(model => [model.id, model]));
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      // The engine projects image history to text for a route that declares
      // text only, which is what Libre WebUI's text providers accept.
      inputModalities: ['text'] as const,
    }));
  }

  async resolveModel(provider: string, model: string) {
    const resolved =
      this.known.get(model) ?? (await requireProvider().resolveModel(model));
    return {
      provider,
      id: model,
      name: resolved?.name ?? model,
      inputModalities: ['text'] as const,
      ...(resolved?.contextWindow
        ? { context: { contextWindow: resolved.contextWindow } }
        : {}),
      ...(resolved?.maxTokens ? { defaultMaxTokens: resolved.maxTokens } : {}),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    const provider = requireProvider();
    const call: BridgeCall = {
      model: options.model,
      messages: [
        ...(options.system
          ? [{ role: 'system' as const, content: options.system }]
          : []),
        ...toBridgeMessages(options.messages),
      ],
      signal: options.signal,
      userId: options.sessionId
        ? this.requestUserId(options.sessionId)
        : undefined,
      ...(options.tools?.length ? { tools: toBridgeTools(options.tools) } : {}),
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      ...(options.maxTokens === undefined
        ? {}
        : { maxTokens: options.maxTokens }),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(options.reasoningEffort
        ? { reasoningEffort: options.reasoningEffort }
        : {}),
      ...(options.purpose ? { purpose: options.purpose } : {}),
    };

    // Indexes are adapter-local and assigned in emission order; text and tool
    // blocks may interleave, so each open block keeps its own index and
    // accumulated text.
    let nextIndex = 0;
    let textIndex: number | undefined;
    let reasoningIndex: number | undefined;
    let text = '';
    let reasoning = '';
    const openToolCalls = new Map<
      string,
      { index: number; arguments: string; name: string }
    >();
    let finishReason: 'stop' | 'tool-calls' | 'max-tokens' | 'error' = 'stop';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let providerMetadata: Record<string, unknown> = {};

    const closeText = function* () {
      if (textIndex === undefined) return;
      yield {
        type: 'block-end' as const,
        index: textIndex,
        block: { type: 'text' as const, text },
      };
      textIndex = undefined;
      text = '';
    };

    const closeReasoning = function* () {
      if (reasoningIndex === undefined) return;
      yield {
        type: 'block-end' as const,
        index: reasoningIndex,
        block: { type: 'reasoning' as const, text: reasoning },
      };
      reasoningIndex = undefined;
      reasoning = '';
    };

    const closeToolCalls = function* () {
      for (const [id, open] of openToolCalls) {
        yield {
          type: 'block-end' as const,
          index: open.index,
          block: {
            type: 'tool-call' as const,
            // The identity is the provider's; DSH brands it, and the brand is
            // a compile-time marker rather than a runtime wrapper.
            id: id as never,
            name: open.name,
            // DSH requires the raw JSON string, never a parsed object.
            arguments: open.arguments,
          },
        };
      }
      openToolCalls.clear();
    };

    for await (const event of provider.stream(call)) {
      options.signal?.throwIfAborted();
      switch (event.type) {
        case 'text': {
          if (event.text === '') break;
          // Empty deltas are skipped rather than opening an empty block, which
          // the grammar rejects as an empty response.
          yield* closeReasoning();
          if (textIndex === undefined) {
            textIndex = nextIndex++;
            yield {
              type: 'block-start' as const,
              index: textIndex,
              blockType: 'text' as const,
            };
          }
          text += event.text;
          yield {
            type: 'text-delta' as const,
            index: textIndex,
            text: event.text,
          };
          break;
        }
        case 'reasoning': {
          if (event.text === '') break;
          yield* closeText();
          if (reasoningIndex === undefined) {
            reasoningIndex = nextIndex++;
            yield {
              type: 'block-start' as const,
              index: reasoningIndex,
              blockType: 'reasoning' as const,
            };
          }
          reasoning += event.text;
          yield {
            type: 'reasoning-delta' as const,
            index: reasoningIndex,
            text: event.text,
          };
          break;
        }
        case 'tool-call': {
          yield* closeText();
          yield* closeReasoning();
          const { id, name, arguments: args } = event.toolCall;
          Object.assign(providerMetadata, event.toolCall.providerMetadata);
          const open = openToolCalls.get(id);
          if (!open) {
            const index = nextIndex++;
            openToolCalls.set(id, { index, arguments: args, name });
            yield {
              type: 'block-start' as const,
              index,
              blockType: 'tool-call' as const,
            };
            // `name` is omitted rather than sent as undefined: the accumulator
            // rejects an explicit undefined, and a chunk must stay
            // JSON-serializable.
            yield {
              type: 'tool-call-delta' as const,
              index,
              id: id as never,
              argumentsDelta: args,
              ...(name === '' ? {} : { name }),
            };
          } else {
            open.arguments += args;
            if (open.name === '' && name !== '') open.name = name;
            yield {
              type: 'tool-call-delta' as const,
              index: open.index,
              id: id as never,
              argumentsDelta: args,
              ...(name === '' ? {} : { name }),
            };
          }
          finishReason = 'tool-calls';
          break;
        }
        case 'usage': {
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          };
          break;
        }
        case 'done': {
          finishReason = event.reason;
          Object.assign(providerMetadata, event.providerMetadata);
          break;
        }
      }
    }

    yield* closeText();
    yield* closeReasoning();
    yield* closeToolCalls();

    if (usage) {
      yield { type: 'usage' as const, usage };
    }
    options.signal?.throwIfAborted();
    yield {
      type: 'finish' as const,
      reason: finishReasonOf(finishReason),
      ...(Object.keys(providerMetadata).length
        ? { replayState: { response: { libreWebUi: providerMetadata } } }
        : {}),
    };
  }
}

/**
 * Build the terminal reason for a finished call.
 *
 * `error` and `aborted` reasons carry a failure payload in DSH's vocabulary
 * rather than being bare kinds, so the error case names the provider layer as
 * the origin instead of emitting an invalid reason.
 *
 * @param reason - the reason the provider stream reported.
 * @returns a well-formed DSH finish reason.
 */
function finishReasonOf(
  reason: 'stop' | 'tool-calls' | 'max-tokens' | 'error'
): FinishReason {
  if (reason === 'error') {
    return {
      kind: 'error',
      failure: {
        message: 'The Libre WebUI provider stream reported a failure.',
        code: 'PROVIDER_STREAM_FAILED',
      },
    };
  }
  return { kind: reason };
}

/**
 * Read a DSH message's content as flat text.
 * @param message - the message to flatten.
 * @returns concatenated text blocks.
 */
function messageText(
  message: Record<string, unknown>,
  type: 'text' | 'reasoning' = 'text'
): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type === type && typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  return parts.join('');
}

/**
 * Convert DSH messages into Libre WebUI's provider-neutral shape.
 *
 * DSH carries structured content; Libre WebUI's providers take flattened text
 * plus the wire fields a tool loop needs, so tool calls and their results are
 * lifted onto the message rather than dropped.
 *
 * @param messages - DSH messages, oldest first.
 * @returns messages Libre WebUI's provider layer accepts.
 */
export function toBridgeMessages(
  messages: readonly unknown[]
): BridgeMessage[] {
  const converted: BridgeMessage[] = [];
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue;
    const message = raw as Record<string, unknown>;
    const role = message.role;
    if (
      role !== 'user' &&
      role !== 'assistant' &&
      role !== 'system' &&
      role !== 'tool'
    ) {
      continue;
    }
    const content = message.content;
    const toolCalls: BridgeToolCall[] = [];
    const toolResults: BridgeMessage[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (record.type === 'tool-call') {
          toolCalls.push({
            id: typeof record.id === 'string' ? record.id : '',
            name: typeof record.name === 'string' ? record.name : '',
            // DSH already holds the raw argument string.
            arguments:
              typeof record.arguments === 'string'
                ? record.arguments
                : JSON.stringify(record.arguments ?? {}),
          });
        }
        if (record.type === 'tool-result') {
          if (typeof record.toolCallId !== 'string' || !record.toolCallId) {
            throw new Error('A tool result is missing its call identifier.');
          }
          toolResults.push({
            role: 'tool',
            content: messageText(record),
            toolCallId: record.toolCallId,
          });
        }
      }
    }
    const text = messageText(message);
    const thinking = Array.isArray(content)
      ? messageText(message, 'reasoning')
      : '';
    const source = message.source as
      | {
          replayState?: { response?: { libreWebUi?: Record<string, unknown> } };
        }
      | undefined;
    const providerMetadata = source?.replayState?.response?.libreWebUi;
    // DSH stores tool outputs as user-role blocks. Each result must become its
    // own wire message; an empty user message would break call correlation.
    if (!toolResults.length || text || thinking || toolCalls.length) {
      converted.push({
        role,
        content: text,
        ...(thinking ? { thinking } : {}),
        ...(providerMetadata ? { providerMetadata } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(role === 'tool' && typeof message.toolCallId === 'string'
          ? { toolCallId: message.toolCallId }
          : {}),
      });
    }
    converted.push(...toolResults);
  }
  return converted;
}

/**
 * Convert DSH tool schemas into Libre WebUI's provider-neutral shape.
 * @param tools - DSH tool schemas.
 * @returns tool declarations for the provider layer.
 */
export function toBridgeTools(tools: readonly unknown[]): BridgeTool[] {
  const converted: BridgeTool[] = [];
  for (const raw of tools) {
    if (raw === null || typeof raw !== 'object') continue;
    const tool = raw as Record<string, unknown>;
    if (typeof tool.name !== 'string') continue;
    converted.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters:
        tool.parameters !== null &&
        typeof tool.parameters === 'object' &&
        !Array.isArray(tool.parameters)
          ? (tool.parameters as Record<string, unknown>)
          : { type: 'object', properties: {} },
    });
  }
  return converted;
}

/**
 * Register the Libre WebUI route, when a provider handler is installed.
 * @param ctx - the row's context, carrying `llm`.
 * @returns the disposer, or undefined when nothing was registered.
 */
export function apply(ctx: Context) {
  if (!handler) return;
  ctx.llm.registerAdapter(
    [ROUTE],
    new LibreWebUiAdapter(sessionId => {
      const engine = ctx.get(DSH_ENGINE_SERVICE) as
        { requestUserId(sessionId: string): string | undefined } | undefined;
      return engine?.requestUserId(sessionId);
    })
  );
}
