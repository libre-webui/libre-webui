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
 * An isolated DSH planning loop for one Work run. Work remains authoritative
 * for transcripts, authorization, approval, sandbox execution, and durability.
 * Tool bodies here only wait for results supplied by Work's next model step.
 */
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm';
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import Agents, { type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import type {
  OllamaChatRequest,
  OllamaChatResponse,
} from '../../types/index.js';
import type { WorkModelStreamObserver } from '../../services/workModelProviderService.js';

export interface WorkDshDriver {
  generate(
    request: OllamaChatRequest,
    observer: WorkModelStreamObserver,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse>;
  dispose(): Promise<void>;
}

export interface WorkDshDriverOptions {
  generate(
    request: OllamaChatRequest,
    observer: WorkModelStreamObserver,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse>;
}

interface Step {
  request: OllamaChatRequest;
  observer: WorkModelStreamObserver;
  controller: AbortController;
  claimed: boolean;
  response?: OllamaChatResponse;
  resolve(response: OllamaChatResponse): void;
  reject(error: unknown): void;
  detach(): void;
}

/** Queue provider deltas without starting another model request. */
class ChunkQueue {
  private readonly chunks: StreamChunk[] = [];
  private wake?: () => void;
  private ended = false;
  private failure?: unknown;
  private queuedBytes = 0;
  constructor(private readonly overflow: (error: Error) => void) {}
  push(chunk: StreamChunk): void {
    if (this.ended) return;
    const bytes = Buffer.byteLength(JSON.stringify(chunk));
    if (
      this.queuedBytes + bytes > 2 * 1024 * 1024 ||
      this.chunks.length >= 10000
    ) {
      const error = new Error(
        'The Work provider exceeded the DSH stream buffer limit.'
      );
      this.overflow(error);
      this.finish(error);
      throw error;
    }
    this.chunks.push(chunk);
    this.queuedBytes += bytes;
    this.wake?.();
  }
  finish(error?: unknown): void {
    this.failure = error;
    if (error) {
      this.chunks.length = 0;
      this.queuedBytes = 0;
    }
    this.ended = true;
    this.wake?.();
  }
  async *read(): AsyncGenerator<StreamChunk> {
    while (true) {
      if (this.chunks.length) {
        const chunk = this.chunks.shift()!;
        this.queuedBytes -= Buffer.byteLength(JSON.stringify(chunk));
        yield chunk;
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

/** Create one in-memory native DSH loop; no host filesystem capabilities mount. */
export async function createWorkDshDriver(
  options: WorkDshDriverOptions
): Promise<WorkDshDriver> {
  const ctx = new Context();
  let disposed = false;
  let active: Step | undefined;
  let delivering: Step | undefined;
  let recovery: Promise<void> | undefined;
  let agent: AgentHandle | undefined;
  let nextModel: (() => void) | undefined;
  const toolResults = new Map<string, string>();
  const toolWaiters = new Map<
    string,
    { resolve(value: string): void; reject(error: unknown): void }
  >();
  const registered = new Map<string, () => void>();

  const fail = (error: unknown, step = active) => {
    if (!step || active !== step) return;
    active = undefined;
    // Provider rejection reaches the caller before DSH records its failure.
    // Drain that native activity before a retry can become the active step.
    recovery = agent?.agent.whenIdle().catch(() => undefined);
    step.detach();
    step.controller.abort(error);
    step.reject(error);
  };

  class WorkAdapter extends LlmAdapter {
    async *stream(call: GenerateOptions): AsyncGenerator<StreamChunk> {
      while (!active && !disposed) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () =>
            call.signal?.removeEventListener('abort', abortWait);
          const abortWait = () => {
            cleanup();
            nextModel = undefined;
            reject(call.signal?.reason);
          };
          nextModel = () => {
            cleanup();
            resolve();
          };
          call.signal?.addEventListener('abort', abortWait, { once: true });
          if (call.signal?.aborted) abortWait();
        });
        nextModel = undefined;
      }
      if (disposed) throw new Error('The Work DSH driver is disposed.');
      const step = active!;
      if (step.claimed)
        throw new Error('A Work model step is already running.');
      step.claimed = true;
      delivering = step;
      const abort = () => step.controller.abort(call.signal?.reason);
      call.signal?.addEventListener('abort', abort, { once: true });
      if (call.signal?.aborted) abort();
      const queue = new ChunkQueue(error => {
        step.controller.abort(error);
        fail(error, step);
      });
      const blocks = new Map<
        'text' | 'reasoning',
        { index: number; text: string }
      >();
      let nextIndex = 0;
      const emit = (kind: 'text' | 'reasoning', delta: string) => {
        if (!delta || active !== step || step.controller.signal.aborted) return;
        let block = blocks.get(kind);
        if (!block) {
          block = { index: nextIndex++, text: '' };
          blocks.set(kind, block);
          queue.push({
            type: 'block-start',
            index: block.index,
            blockType: kind,
          });
        }
        block.text += delta;
        queue.push({
          type: kind === 'text' ? 'text-delta' : 'reasoning-delta',
          index: block.index,
          text: delta,
        });
      };
      const run = (async () => {
        const original = await options.generate(
          step.request,
          {
            onContent: text => emit('text', text),
            onReasoning: text => emit('reasoning', text),
            onUsage: usage => {
              if (active === step && !step.controller.signal.aborted)
                step.observer.onUsage?.(usage);
            },
          },
          step.controller.signal
        );
        step.controller.signal.throwIfAborted();
        const rawCalls = original.message.tool_calls ?? [];
        const calls = rawCalls.map(call =>
          typeof call.id === 'string'
            ? call
            : { ...call, id: `work-dsh-${randomUUID()}` }
        );
        step.response = calls.some((call, index) => call !== rawCalls[index])
          ? { ...original, message: { ...original.message, tool_calls: calls } }
          : original;
        for (const [kind, full] of [
          ['reasoning', original.message.thinking ?? ''],
          ['text', original.message.content],
        ] as const) {
          const streamed = blocks.get(kind)?.text ?? '';
          if (full.startsWith(streamed))
            emit(kind, full.slice(streamed.length));
        }
        for (const [kind, block] of blocks)
          queue.push({
            type: 'block-end',
            index: block.index,
            block: { type: kind, text: block.text },
          });
        for (const record of calls) {
          const fn = record.function as
            { name?: unknown; arguments?: unknown } | undefined;
          if (
            !fn ||
            typeof fn.name !== 'string' ||
            typeof record.id !== 'string'
          )
            throw new Error('The Work provider returned an invalid tool call.');
          const index = nextIndex++;
          const args =
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {});
          queue.push({ type: 'block-start', index, blockType: 'tool-call' });
          queue.push({
            type: 'tool-call-delta',
            index,
            id: record.id as ToolCallId,
            name: fn.name,
            argumentsDelta: args,
          });
          queue.push({
            type: 'block-end',
            index,
            block: {
              type: 'tool-call',
              id: record.id as ToolCallId,
              name: fn.name,
              arguments: args,
            },
          });
        }
        queue.push({
          type: 'finish',
          reason: { kind: calls.length ? 'tool-calls' : 'stop' },
        });
      })();
      void run.then(
        () => queue.finish(),
        error => {
          fail(error, step);
          queue.finish(error);
        }
      );
      try {
        yield* queue.read();
      } finally {
        call.signal?.removeEventListener('abort', abort);
        await run.catch(() => undefined);
      }
    }
  }

  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjections);
    await ctx.plugin(SystemPrompt, { personaPrefix: '' });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(Agents);
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.llm.registerAdapter(['libre-work'], new WorkAdapter());
    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type !== 'chunk' || !active || active !== delivering) return;
      if (frame.chunk.type === 'text-delta')
        active.observer.onContent?.(frame.chunk.text);
      if (frame.chunk.type === 'reasoning-delta')
        active.observer.onReasoning?.(frame.chunk.text);
    });
    ctx.on('session/event', (_session, event) => {
      if (
        event.type !== 'assistant/message' ||
        !active?.response ||
        active !== delivering
      )
        return;
      const step = active;
      active = undefined;
      step.detach();
      step.resolve(step.response!);
    });
    ctx.on('agent/error', ({ error }) =>
      fail(error, active?.claimed ? delivering : active)
    );
    agent = await ctx.agents.create({
      sessionId: `work-${randomUUID()}` as SessionId,
      agentOptions: { provider: 'libre-work', model: 'work-model' },
    });
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }

  const driver: WorkDshDriver = {
    async generate(request, observer, signal) {
      signal?.throwIfAborted();
      const draining = recovery;
      await draining;
      if (recovery === draining) recovery = undefined;
      if (disposed) throw new Error('The Work DSH driver is disposed.');
      if (active) throw new Error('A Work model step is already running.');
      signal?.throwIfAborted();
      for (const dispose of registered.values()) dispose();
      registered.clear();
      for (const raw of request.tools ?? []) {
        const fn = raw.function as
          { name?: unknown; description?: unknown } | undefined;
        if (!fn || typeof fn.name !== 'string' || registered.has(fn.name))
          continue;
        registered.set(
          fn.name,
          ctx.tools.register({
            name: fn.name,
            description:
              typeof fn.description === 'string' ? fn.description : '',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: true,
            },
            output: {
              schema: { type: 'string' },
              render: (_args, value) => [{ type: 'text', text: String(value) }],
            },
            async execute(_args, exec) {
              exec.signal.throwIfAborted();
              const immediate = toolResults.get(exec.callId);
              if (immediate !== undefined) {
                toolResults.delete(exec.callId);
                return immediate;
              }
              return new Promise<string>((resolve, reject) => {
                const abort = () => {
                  toolWaiters.delete(exec.callId);
                  reject(exec.signal.reason);
                };
                const finish = (value: string) => {
                  exec.signal.removeEventListener('abort', abort);
                  toolWaiters.delete(exec.callId);
                  resolve(value);
                };
                const failWait = (error: unknown) => {
                  exec.signal.removeEventListener('abort', abort);
                  toolWaiters.delete(exec.callId);
                  reject(error);
                };
                toolWaiters.set(exec.callId, {
                  resolve: finish,
                  reject: failWait,
                });
                exec.signal.addEventListener('abort', abort, { once: true });
              });
            },
          })
        );
      }
      return new Promise<OllamaChatResponse>((resolve, reject) => {
        const controller = new AbortController();
        const abort = () => {
          controller.abort(signal?.reason);
          agent?.agent.cancel({ kind: 'user' });
          fail(signal?.reason ?? new Error('Work generation aborted.'), step);
        };
        const step: Step = {
          request,
          observer,
          controller,
          claimed: false,
          resolve,
          reject,
          detach: () => signal?.removeEventListener('abort', abort),
        };
        active = step;
        signal?.addEventListener('abort', abort, { once: true });
        for (const message of request.messages) {
          if (message.role !== 'tool' || !message.tool_call_id) continue;
          const waiter = toolWaiters.get(message.tool_call_id);
          if (waiter) waiter.resolve(message.content);
          else toolResults.set(message.tool_call_id, message.content);
        }
        nextModel?.();
        // Idle follow-ups wake a new DSH turn. A loop still consuming Work tool
        // results advances itself; checking claimed avoids a duplicate wake.
        void agent!.agent
          .whenIdle()
          .then(() => {
            if (active !== step || step.claimed || disposed) return;
            agent!.agent.followup(
              createUserMessage({
                source: { kind: 'user' },
                content: [
                  { type: 'text', text: 'Continue the current Work request.' },
                ],
              })
            );
          })
          .catch(error => fail(error, step));
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const error = new Error('The Work DSH driver is disposed.');
      fail(error);
      nextModel?.();
      for (const waiter of toolWaiters.values()) waiter.reject(error);
      toolWaiters.clear();
      toolResults.clear();
      await agent?.dispose();
      await ctx.fiber.dispose();
    },
  };
  return driver;
}
