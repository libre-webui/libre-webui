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

/** A stable cancellation error that can cross provider adapter boundaries. */
export class ChatGenerationCancelledError extends Error {
  readonly code = 'CHAT_GENERATION_CANCELLED';

  constructor(message = 'Chat generation was cancelled.') {
    super(message);
    this.name = 'ChatGenerationCancelledError';
  }
}

export interface ActiveChatGeneration {
  assistantMessageId: string;
  sessionId: string;
  controller: AbortController;
}

/** Tracks only this authenticated connection's active Chat generations. */
export class ChatGenerationRegistry {
  private readonly generations = new Map<string, ActiveChatGeneration>();

  constructor(private readonly maxActiveGenerations = 4) {}

  start(
    sessionId: string,
    assistantMessageId: string,
    controller = new AbortController()
  ): ActiveChatGeneration {
    // One upstream generation per chat and assistant ID avoids stale chunks,
    // orphaned controllers, and duplicate-ID replacement attacks. Remove the
    // cancelled entry before inserting an immediate retry; finish() is
    // identity-aware, so the old request cannot delete its replacement.
    for (const [id, generation] of this.generations) {
      if (
        generation.sessionId === sessionId ||
        generation.assistantMessageId === assistantMessageId
      ) {
        generation.controller.abort(new ChatGenerationCancelledError());
        this.generations.delete(id);
      }
    }
    if (this.generations.size >= this.maxActiveGenerations) {
      throw new Error(
        `This connection already has ${this.maxActiveGenerations} active chat generations.`
      );
    }
    const generation = { sessionId, assistantMessageId, controller };
    this.generations.set(assistantMessageId, generation);
    return generation;
  }

  cancel(sessionId: unknown, assistantMessageId: unknown): boolean {
    if (typeof assistantMessageId !== 'string') return false;
    const generation = this.generations.get(assistantMessageId);
    if (
      !generation ||
      (typeof sessionId === 'string' && generation.sessionId !== sessionId)
    ) {
      return false;
    }
    generation.controller.abort(new ChatGenerationCancelledError());
    return true;
  }

  finish(generation: ActiveChatGeneration): void {
    if (this.generations.get(generation.assistantMessageId) === generation) {
      this.generations.delete(generation.assistantMessageId);
    }
  }

  cancelAll(message = 'The client disconnected before generation completed.') {
    for (const generation of this.generations.values()) {
      generation.controller.abort(new ChatGenerationCancelledError(message));
    }
    this.generations.clear();
  }

  get size(): number {
    return this.generations.size;
  }
}

/** Bounds provider work across every Chat WebSocket owned by one user. */
export class UserChatGenerationRegistry {
  private readonly generationsByUser = new Map<
    string,
    Set<ActiveChatGeneration>
  >();

  constructor(private readonly maxActiveGenerationsPerUser = 4) {}

  start(userId: string, generation: ActiveChatGeneration): void {
    const generations =
      this.generationsByUser.get(userId) ?? new Set<ActiveChatGeneration>();
    for (const active of generations) {
      if (
        active.sessionId === generation.sessionId ||
        active.assistantMessageId === generation.assistantMessageId
      ) {
        active.controller.abort(new ChatGenerationCancelledError());
        generations.delete(active);
      }
    }
    if (generations.size >= this.maxActiveGenerationsPerUser) {
      throw new Error(
        `This account already has ${this.maxActiveGenerationsPerUser} active chat generations.`
      );
    }
    generations.add(generation);
    this.generationsByUser.set(userId, generations);
  }

  finish(userId: string, generation: ActiveChatGeneration): void {
    const generations = this.generationsByUser.get(userId);
    if (!generations) return;
    generations.delete(generation);
    if (generations.size === 0) this.generationsByUser.delete(userId);
  }

  sizeForUser(userId: string): number {
    return this.generationsByUser.get(userId)?.size ?? 0;
  }
}

export function throwIfChatGenerationCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new ChatGenerationCancelledError();
}

export function isChatGenerationCancelled(
  error: unknown,
  signal?: AbortSignal
): boolean {
  if (signal?.aborted) return true;
  if (error instanceof ChatGenerationCancelledError) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;

  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AbortError' ||
    candidate.name === 'CanceledError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.code === 'ERR_CANCELED' ||
    candidate.code === 'CHAT_GENERATION_CANCELLED'
  );
}

/**
 * Abort an operation when the HTTP response closes before it has completed.
 * The returned cleanup must be called when the handler settles.
 */
export function abortChatGenerationOnResponseClose(
  response: {
    writableEnded: boolean;
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
  },
  controller = new AbortController()
): { controller: AbortController; cleanup: () => void } {
  const abort = () => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort(
        new ChatGenerationCancelledError(
          'The client disconnected before generation completed.'
        )
      );
    }
  };
  response.once('close', abort);
  return {
    controller,
    cleanup: () => response.off('close', abort),
  };
}
