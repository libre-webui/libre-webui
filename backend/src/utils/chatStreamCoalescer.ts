/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

export interface ChatStreamBatch {
  contentDelta: string;
  thinkingDelta: string;
  contentTotal: string;
  thinkingTotal: string;
}

export interface ChatStreamCoalescer {
  queue(batch: ChatStreamBatch): void;
  drain(): Promise<void>;
}

/**
 * Keep provider consumption independent from durable event latency while
 * retaining exact ordered deltas. At most one publish and one aggregate batch
 * are resident, so a fast stream cannot create an unbounded Promise backlog.
 */
export const createChatStreamCoalescer = (
  publish: (batch: ChatStreamBatch) => Promise<void>
): ChatStreamCoalescer => {
  let pending: ChatStreamBatch | undefined;
  let flushing: Promise<void> | undefined;
  let failure: unknown;

  const start = (): void => {
    if (flushing || failure || !pending) return;
    flushing = (async () => {
      while (pending && !failure) {
        const batch = pending;
        pending = undefined;
        try {
          await publish(batch);
        } catch (error) {
          failure = error;
          pending = undefined;
        }
      }
    })().finally(() => {
      flushing = undefined;
      if (pending && !failure) start();
    });
  };

  return {
    queue(batch) {
      if (failure) throw failure;
      pending = pending
        ? {
            contentDelta: pending.contentDelta + batch.contentDelta,
            thinkingDelta: pending.thinkingDelta + batch.thinkingDelta,
            contentTotal: batch.contentTotal,
            thinkingTotal: batch.thinkingTotal,
          }
        : { ...batch };
      start();
    },
    async drain() {
      while (flushing || pending) {
        if (!flushing) start();
        await flushing;
      }
      if (failure) throw failure;
    },
  };
};
