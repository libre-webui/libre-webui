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
 * Streaming Performance Debugger
 * Helps monitor and debug streaming performance issues
 */
export class StreamingDebugger {
  private static instance: StreamingDebugger;
  private enabled: boolean = false;
  private metrics: {
    chunksReceived: number;
    totalProcessingTime: number;
    averageProcessingTime: number;
    maxProcessingTime: number;
    startTime?: number;
    lastChunkTime?: number;
    chunkTimings: number[];
  } = {
    chunksReceived: 0,
    totalProcessingTime: 0,
    averageProcessingTime: 0,
    maxProcessingTime: 0,
    chunkTimings: [],
  };

  private constructor() {}

  public static getInstance(): StreamingDebugger {
    if (!StreamingDebugger.instance) {
      StreamingDebugger.instance = new StreamingDebugger();
    }
    return StreamingDebugger.instance;
  }

  public enable(): void {
    this.enabled = true;
    console.log('🔍 Streaming debugger enabled');
  }

  public disable(): void {
    this.enabled = false;
  }

  public startStreaming(): void {
    if (!this.enabled) return;

    this.resetMetrics();
    this.metrics.startTime = performance.now();
    console.log('🚀 Streaming started');
  }

  public recordChunk(_chunkSize: number): void {
    if (!this.enabled) return;

    const now = performance.now();
    this.metrics.chunksReceived++;

    if (this.metrics.lastChunkTime) {
      const timeSinceLastChunk = now - this.metrics.lastChunkTime;
      this.metrics.chunkTimings.push(timeSinceLastChunk);

      if (timeSinceLastChunk > this.metrics.maxProcessingTime) {
        this.metrics.maxProcessingTime = timeSinceLastChunk;
      }

      this.metrics.totalProcessingTime += timeSinceLastChunk;
      this.metrics.averageProcessingTime =
        this.metrics.totalProcessingTime / (this.metrics.chunksReceived - 1);
    }

    this.metrics.lastChunkTime = now;

    // Log performance warning if chunk processing is taking too long
    if (this.metrics.chunksReceived > 10) {
      const recentAverage =
        this.metrics.chunkTimings
          .slice(-10)
          .reduce((sum, time) => sum + time, 0) / 10;

      if (recentAverage > 100) {
        // More than 100ms between chunks is concerning
        console.warn(
          `⚠️ Slow chunk processing detected: ${recentAverage.toFixed(2)}ms average`
        );
      }
    }
  }

  public endStreaming(): void {
    if (!this.enabled || !this.metrics.startTime) return;

    const totalTime = performance.now() - this.metrics.startTime;
    const averageChunksPerSecond =
      (this.metrics.chunksReceived / totalTime) * 1000;

    console.log('📊 Streaming Performance Report:');
    console.log(`   Total chunks: ${this.metrics.chunksReceived}`);
    console.log(`   Total time: ${totalTime.toFixed(2)}ms`);
    console.log(`   Average chunks/sec: ${averageChunksPerSecond.toFixed(2)}`);
    console.log(
      `   Average chunk interval: ${this.metrics.averageProcessingTime.toFixed(2)}ms`
    );
    console.log(
      `   Max chunk interval: ${this.metrics.maxProcessingTime.toFixed(2)}ms`
    );

    // Performance recommendations
    if (this.metrics.averageProcessingTime > 50) {
      console.warn(
        '🐌 Consider optimizing: Average chunk processing time is high'
      );
    }
    if (this.metrics.maxProcessingTime > 200) {
      console.warn(
        '🐌 Consider optimizing: Max chunk processing time is very high'
      );
    }
    if (averageChunksPerSecond < 10) {
      console.warn('🐌 Consider optimizing: Chunk throughput is low');
    }
  }

  private resetMetrics(): void {
    this.metrics = {
      chunksReceived: 0,
      totalProcessingTime: 0,
      averageProcessingTime: 0,
      maxProcessingTime: 0,
      chunkTimings: [],
    };
  }

  public getMetrics() {
    return { ...this.metrics };
  }
}

// Export singleton instance
export const streamingDebugger = StreamingDebugger.getInstance();

// Enable in development mode
if (import.meta.env.DEV) {
  streamingDebugger.enable();
}
