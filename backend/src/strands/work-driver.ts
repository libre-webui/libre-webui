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
 * A Strands agent loop driving one Work run.
 *
 * Work stays authoritative for transcripts, authorization, approvals,
 * sandboxed tool execution, and durability. The Strands agent owns the loop:
 * each model call it makes is served by the next Work step, and its tools are
 * proxies whose bodies wait for the results Work supplies with the following
 * step. Nothing here touches the filesystem or runs a tool itself.
 */
import { randomUUID } from 'node:crypto';
import type {
  Agent,
  Message,
  ModelStreamEvent,
  StopReason,
  StreamOptions,
  Tool,
  ToolContext,
  BaseModelConfig,
} from '@strands-agents/sdk';
import type { OllamaChatRequest, OllamaChatResponse } from '../types/index.js';
import type { WorkModelStreamObserver } from '../services/workModelProviderService.js';

export interface WorkStrandsDriver {
  generate(
    request: OllamaChatRequest,
    observer: WorkModelStreamObserver,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse>;
  dispose(): Promise<void>;
}

export interface WorkStrandsDriverOptions {
  generate(
    request: OllamaChatRequest,
    observer: WorkModelStreamObserver,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse>;
}

const MAX_QUEUED_EVENTS = 2048;
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const CONTINUE_PROMPT = 'Continue the current Work request.';
const MISSING_RESULT =
  'Work did not return a result for this tool call. Continue with the next step.';

interface Step {
  request: OllamaChatRequest;
  observer: WorkModelStreamObserver;
  controller: AbortController;
  claimed: boolean;
  settled: boolean;
  resolve(response: OllamaChatResponse): void;
  reject(error: unknown): void;
  detach(): void;
}

/** Hand provider deltas to the Strands model stream without re-requesting. */
class EventQueue {
  private readonly events: ModelStreamEvent[] = [];
  private readonly sizes: number[] = [];
  private bytes = 0;
  private ended = false;
  private failure?: unknown;
  private wake?: () => void;

  push(event: ModelStreamEvent): void {
    if (this.ended) return;
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (
      this.events.length >= MAX_QUEUED_EVENTS ||
      this.bytes + size > MAX_QUEUED_BYTES
    ) {
      const error = new Error(
        'The Work provider exceeded the Strands stream buffer limit.'
      );
      this.finish(error);
      throw error;
    }
    this.events.push(event);
    this.sizes.push(size);
    this.bytes += size;
    this.wake?.();
  }

  finish(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    if (error) {
      this.events.length = 0;
      this.sizes.length = 0;
      this.bytes = 0;
    }
    this.wake?.();
  }

  async *read(): AsyncGenerator<ModelStreamEvent> {
    while (true) {
      if (this.events.length > 0) {
        this.bytes -= this.sizes.shift() ?? 0;
        yield this.events.shift()!;
        continue;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>(resolve => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

function toolArguments(value: unknown): string {
  if (typeof value === 'string') return value || '{}';
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content ?? '');
  } catch {
    return '';
  }
}

export async function createWorkStrandsDriver(
  options: WorkStrandsDriverOptions
): Promise<WorkStrandsDriver> {
  const sdk = await import('@strands-agents/sdk');
  const lifetime = new AbortController();
  let disposed = false;
  let active: Step | undefined;
  let running: Promise<void> | undefined;
  let nextModel: (() => void) | undefined;
  const toolResults = new Map<string, string>();
  const toolWaiters = new Map<string, (value: string) => void>();
  const registered = new Set<string>();

  const settle = (step: Step) => {
    if (step.settled) return false;
    step.settled = true;
    step.detach();
    if (active === step) active = undefined;
    return true;
  };

  const fail = (step: Step | undefined, error: unknown) => {
    if (!step || !settle(step)) return;
    step.controller.abort(error);
    step.reject(error);
  };

  const releaseWaiters = (value: string) => {
    for (const [id, release] of toolWaiters) {
      toolWaiters.delete(id);
      release(value);
    }
  };

  const waitForStep = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const abort = () => {
        nextModel = undefined;
        reject(signal?.reason ?? new Error('The Strands model call aborted.'));
      };
      nextModel = () => {
        signal?.removeEventListener('abort', abort);
        nextModel = undefined;
        resolve();
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });

  class WorkStepModel extends sdk.Model<BaseModelConfig> {
    private config: BaseModelConfig = { modelId: 'libre-webui-work' };

    updateConfig(config: BaseModelConfig): void {
      this.config = { ...this.config, ...config };
    }

    getConfig(): BaseModelConfig {
      return { ...this.config };
    }

    async *stream(
      _messages: Message[],
      streamOptions: StreamOptions = {}
    ): AsyncIterable<ModelStreamEvent> {
      const cancel = streamOptions.cancelSignal;
      while (!active && !disposed) await waitForStep(cancel);
      if (disposed || !active)
        throw new Error('The Work Strands driver is disposed.');
      const step = active;
      if (step.claimed)
        throw new Error('A Work model step is already running.');
      step.claimed = true;
      const abort = () => step.controller.abort(cancel?.reason);
      cancel?.addEventListener('abort', abort, { once: true });
      if (cancel?.aborted) abort();

      const queue = new EventQueue();
      let block: { kind: 'text' | 'reasoning'; text: string } | undefined;
      const streamed = { text: '', reasoning: '' };
      const close = () => {
        if (!block) return;
        queue.push({ type: 'modelContentBlockStopEvent' });
        block = undefined;
      };
      const emit = (kind: 'text' | 'reasoning', delta: string) => {
        if (!delta || step.settled || step.controller.signal.aborted) return;
        if (block?.kind !== kind) {
          close();
          block = { kind, text: '' };
          queue.push({ type: 'modelContentBlockStartEvent' });
        }
        block.text += delta;
        streamed[kind] += delta;
        queue.push({
          type: 'modelContentBlockDeltaEvent',
          delta:
            kind === 'text'
              ? { type: 'textDelta', text: delta }
              : { type: 'reasoningContentDelta', text: delta },
        });
      };
      const forward = (kind: 'text' | 'reasoning', delta: string) => {
        if (!delta || step.settled || step.controller.signal.aborted) return;
        if (kind === 'text') step.observer.onContent?.(delta);
        else step.observer.onReasoning?.(delta);
        emit(kind, delta);
      };

      queue.push({ type: 'modelMessageStartEvent', role: 'assistant' });
      const provider = (async () => {
        const original = await options.generate(
          step.request,
          {
            ...step.observer,
            onContent: delta => forward('text', delta),
            onReasoning: delta => forward('reasoning', delta),
          },
          step.controller.signal
        );
        step.controller.signal.throwIfAborted();
        const rawCalls = original.message.tool_calls ?? [];
        const calls = rawCalls.map(call =>
          typeof call.id === 'string' && call.id
            ? call
            : { ...call, id: `work-strands-${randomUUID()}` }
        );
        const response =
          calls.length && calls.some((call, index) => call !== rawCalls[index])
            ? {
                ...original,
                message: { ...original.message, tool_calls: calls },
              }
            : original;
        // Providers that do not stream still return full text. Only the
        // part Strands has not seen yet is replayed.
        const reasoning = original.message.thinking ?? '';
        if (reasoning.startsWith(streamed.reasoning))
          emit('reasoning', reasoning.slice(streamed.reasoning.length));
        const content = original.message.content ?? '';
        if (content.startsWith(streamed.text))
          emit('text', content.slice(streamed.text.length));
        close();
        const toolUses: { id: string; name: string; input: string }[] = [];
        for (const call of calls) {
          const fn = call.function as
            { name?: unknown; arguments?: unknown } | undefined;
          if (!fn || typeof fn.name !== 'string' || typeof call.id !== 'string')
            throw new Error('The Work provider returned an invalid tool call.');
          toolUses.push({
            id: call.id,
            name: fn.name,
            input: toolArguments(fn.arguments),
          });
        }
        for (const use of toolUses) {
          queue.push({
            type: 'modelContentBlockStartEvent',
            start: {
              type: 'toolUseStart',
              name: use.name,
              toolUseId: use.id,
            },
          });
          queue.push({
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: use.input },
          });
          queue.push({ type: 'modelContentBlockStopEvent' });
        }
        const stopReason: StopReason = toolUses.length ? 'toolUse' : 'endTurn';
        queue.push({ type: 'modelMessageStopEvent', stopReason });
        const inputTokens = original.prompt_eval_count ?? 0;
        const outputTokens = original.eval_count ?? 0;
        queue.push({
          type: 'modelMetadataEvent',
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          },
        });
        queue.finish();
        // Work gets the step back as soon as the provider is done. Its tool
        // results arrive with the next step and release the proxy tools.
        if (settle(step)) step.resolve(response);
      })().catch(error => {
        queue.finish(error);
        fail(step, error);
      });

      try {
        yield* queue.read();
      } finally {
        cancel?.removeEventListener('abort', abort);
        await provider;
      }
    }
  }

  const agent: Agent = new sdk.Agent({
    model: new WorkStepModel(),
    printer: false,
    retryStrategy: null,
    name: 'libre-webui-work',
  });

  const proxyTool = (name: string, description: string): Tool =>
    new sdk.FunctionTool({
      name,
      description,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      callback: (_input: unknown, context: ToolContext) => {
        const id = context.toolUse.toolUseId;
        const immediate = toolResults.get(id);
        if (immediate !== undefined) {
          toolResults.delete(id);
          return immediate;
        }
        // Work has already moved to its next step without this result.
        if (active && !active.claimed) return MISSING_RESULT;
        return new Promise<string>((resolve, reject) => {
          const signal = context.cancelSignal;
          const abort = () => {
            toolWaiters.delete(id);
            reject(signal.reason ?? new Error('The Work tool call aborted.'));
          };
          toolWaiters.set(id, value => {
            signal.removeEventListener('abort', abort);
            resolve(value);
          });
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    });

  const syncTools = (request: OllamaChatRequest) => {
    const wanted = new Map<string, string>();
    for (const raw of request.tools ?? []) {
      const fn = (raw as { function?: unknown }).function as
        { name?: unknown; description?: unknown } | undefined;
      if (!fn || typeof fn.name !== 'string' || wanted.has(fn.name)) continue;
      wanted.set(
        fn.name,
        typeof fn.description === 'string' ? fn.description : ''
      );
    }
    for (const name of registered) {
      if (wanted.has(name)) continue;
      agent.toolRegistry.remove(name);
      registered.delete(name);
    }
    const fresh = [...wanted]
      .filter(([name]) => !registered.has(name))
      .map(([name, description]) => proxyTool(name, description));
    if (fresh.length) {
      agent.toolRegistry.addOrReplace(fresh);
      for (const tool of fresh) registered.add(tool.name);
    }
  };

  const start = () => {
    const invocation = (async () => {
      const events = agent.stream(CONTINUE_PROMPT, {
        cancelSignal: lifetime.signal,
      });
      // Draining the generator runs the loop. Work consumes the output.
      while (!(await events.next()).done) {
        /* keep the loop moving */
      }
    })();
    running = invocation
      .catch(error => {
        // Provider failures already reached the step that caused them. Any
        // other loop failure fails the step waiting on it.
        if (active) fail(active, error);
        releaseWaiters(MISSING_RESULT);
      })
      .finally(() => {
        running = undefined;
        // A step that arrived while the previous turn was wrapping up still
        // needs a model call.
        if (!disposed && active && !active.claimed) start();
      });
  };

  return {
    async generate(request, observer, signal) {
      signal?.throwIfAborted();
      if (disposed) throw new Error('The Work Strands driver is disposed.');
      if (active) throw new Error('A Work model step is already running.');
      syncTools(request);
      return new Promise<OllamaChatResponse>((resolve, reject) => {
        const controller = new AbortController();
        const onAbort = () =>
          fail(step, signal?.reason ?? new Error('Work generation aborted.'));
        const step: Step = {
          request,
          observer,
          controller,
          claimed: false,
          settled: false,
          resolve,
          reject,
          detach: () => signal?.removeEventListener('abort', onAbort),
        };
        active = step;
        signal?.addEventListener('abort', onAbort, { once: true });
        for (const message of request.messages) {
          const callId = (message as { tool_call_id?: unknown }).tool_call_id;
          if (message.role !== 'tool' || typeof callId !== 'string') continue;
          const text = toolResultText(message.content);
          const waiter = toolWaiters.get(callId);
          if (waiter) {
            toolWaiters.delete(callId);
            waiter(text);
          } else {
            toolResults.set(callId, text);
          }
        }
        // Calls Work did not answer would otherwise hold the loop forever.
        releaseWaiters(MISSING_RESULT);
        if (running) nextModel?.();
        else start();
      });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const error = new Error('The Work Strands driver is disposed.');
      fail(active, error);
      nextModel?.();
      lifetime.abort(error);
      agent.cancel();
      releaseWaiters(MISSING_RESULT);
      toolResults.clear();
      await running?.catch(() => undefined);
      await agent.memoryManager?.flush?.().catch(() => undefined);
    },
  };
}
