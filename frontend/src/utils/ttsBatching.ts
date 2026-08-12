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

export const DEFAULT_TTS_TARGET_CHARS = 240;
export const DEFAULT_TTS_MAX_CHARS = 360;
export const DEFAULT_TTS_MIN_CHARS = 48;
export const MAX_TTS_GENERATION_CONCURRENCY = 3;
export const DEFAULT_TTS_INITIAL_BUFFER_SIZE = 2;

export interface TTSSentenceSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

export interface TTSBatchingOptions {
  /** Batches are packed toward this length without exceeding maxChars. */
  targetChars?: number;
  /** Hard upper bound for every returned batch. */
  maxChars?: number;
  /** Small trailing phrases are merged or rebalanced when possible. */
  minChars?: number;
  locale?: string;
  /** Pass false to force the deterministic fallback (useful in tests). */
  segmenter?: TTSSentenceSegmenter | false;
}

interface NormalizedBatchingOptions {
  targetChars: number;
  maxChars: number;
  minChars: number;
  locale?: string;
  segmenter?: TTSSentenceSegmenter | false;
}

const SENTENCE_ENDINGS = new Set([
  '.',
  '!',
  '?',
  '\u3002',
  '\uff01',
  '\uff1f',
  '\u2026',
]);
const CJK_SENTENCE_ENDINGS = new Set(['\u3002', '\uff01', '\uff1f']);
const CLOSING_PUNCTUATION = new Set([
  '"',
  "'",
  '\u2019',
  '\u201d',
  '\u00bb',
  ')',
  ']',
  '}',
]);
const PHRASE_BREAKS = new Set([
  ',',
  ';',
  ':',
  '\u2014',
  '\u2013',
  '\uff0c',
  '\uff1b',
  '\uff1a',
  '\u3001',
  '\n',
]);
const COMMON_ABBREVIATIONS = new Set([
  'a.m',
  'apr',
  'aug',
  'dec',
  'dr',
  'e.g',
  'etc',
  'feb',
  'fri',
  'i.e',
  'jan',
  'jr',
  'jul',
  'jun',
  'mar',
  'mr',
  'mrs',
  'ms',
  'nov',
  'oct',
  'p.m',
  'prof',
  'sep',
  'sept',
  'sr',
  'st',
  'vs',
]);

const normalizePositiveInteger = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return Math.floor(value);
};

const normalizeBatchingOptions = (
  options: TTSBatchingOptions
): NormalizedBatchingOptions => {
  const maxChars = normalizePositiveInteger(
    options.maxChars ?? DEFAULT_TTS_MAX_CHARS,
    'maxChars'
  );
  const targetChars = normalizePositiveInteger(
    options.targetChars ?? Math.min(DEFAULT_TTS_TARGET_CHARS, maxChars),
    'targetChars'
  );
  const minChars = normalizePositiveInteger(
    options.minChars ?? Math.min(DEFAULT_TTS_MIN_CHARS, targetChars),
    'minChars'
  );

  if (targetChars > maxChars) {
    throw new RangeError('targetChars cannot exceed maxChars');
  }
  if (minChars > targetChars) {
    throw new RangeError('minChars cannot exceed targetChars');
  }

  return { ...options, targetChars, maxChars, minChars };
};

const getIntlSentenceSegmenter = (
  locale?: string
): TTSSentenceSegmenter | undefined => {
  const intlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: 'sentence' }
    ) => TTSSentenceSegmenter;
  };

  if (!intlWithSegmenter.Segmenter) return undefined;

  try {
    return new intlWithSegmenter.Segmenter(locale, {
      granularity: 'sentence',
    });
  } catch {
    return undefined;
  }
};

const isWhitespace = (value: string | undefined): boolean =>
  value !== undefined && /\s/u.test(value);

const isAbbreviation = (text: string, sentenceStart: number, end: number) => {
  const candidate = text.slice(sentenceStart, end);
  const token = candidate.match(/([\p{L}.]+)\.$/u)?.[1]?.toLocaleLowerCase();
  if (!token) return false;

  if (COMMON_ABBREVIATIONS.has(token)) return true;
  // Initials and dotted initialisms such as "J." and "U.S." generally do not
  // terminate a sentence when more text follows.
  if (/^\p{L}$/u.test(token) || /^(?:\p{L}\.)+\p{L}$/u.test(token)) {
    return true;
  }
  return false;
};

/**
 * Deterministic sentence splitting used when Intl.Segmenter is unavailable.
 * Sentence punctuation and closing quotes remain attached to their sentence.
 */
export function splitTTSSentencesFallback(text: string): string[] {
  const sentences: string[] = [];
  let sentenceStart = 0;
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (!SENTENCE_ENDINGS.has(character)) {
      index += 1;
      continue;
    }

    // A period surrounded by digits is a decimal point, not a sentence end.
    if (
      character === '.' &&
      /\d/u.test(text[index - 1] ?? '') &&
      /\d/u.test(text[index + 1] ?? '')
    ) {
      index += 1;
      continue;
    }

    let punctuationEnd = index + 1;
    while (
      punctuationEnd < text.length &&
      SENTENCE_ENDINGS.has(text[punctuationEnd])
    ) {
      punctuationEnd += 1;
    }

    let sentenceEnd = punctuationEnd;
    while (
      sentenceEnd < text.length &&
      CLOSING_PUNCTUATION.has(text[sentenceEnd])
    ) {
      sentenceEnd += 1;
    }

    const hasBoundaryAfter =
      sentenceEnd === text.length ||
      isWhitespace(text[sentenceEnd]) ||
      CJK_SENTENCE_ENDINGS.has(character);
    const abbreviation =
      character === '.' &&
      sentenceEnd < text.length &&
      isAbbreviation(text, sentenceStart, punctuationEnd);

    if (hasBoundaryAfter && !abbreviation) {
      const sentence = text.slice(sentenceStart, sentenceEnd).trim();
      if (sentence) sentences.push(sentence);
      sentenceStart = sentenceEnd;
      while (sentenceStart < text.length && isWhitespace(text[sentenceStart])) {
        sentenceStart += 1;
      }
      index = sentenceStart;
      continue;
    }

    index = punctuationEnd;
  }

  const remainder = text.slice(sentenceStart).trim();
  if (remainder) sentences.push(remainder);
  return sentences;
}

/** Split text into sentence units without changing their punctuation or order. */
export function splitTTSSentences(
  text: string,
  options: Pick<TTSBatchingOptions, 'locale' | 'segmenter'> = {}
): string[] {
  if (!text.trim()) return [];

  const segmenter =
    options.segmenter === false
      ? undefined
      : (options.segmenter ?? getIntlSentenceSegmenter(options.locale));
  if (!segmenter) return splitTTSSentencesFallback(text);

  try {
    const sentences = Array.from(segmenter.segment(text), item =>
      item.segment.trim()
    ).filter(Boolean);
    return sentences.length > 0 ? sentences : splitTTSSentencesFallback(text);
  } catch {
    return splitTTSSentencesFallback(text);
  }
}

const safeCodeUnitCut = (text: string, requestedIndex: number): number => {
  let index = Math.min(Math.max(1, requestedIndex), text.length);
  const previousCodeUnit = text.charCodeAt(index - 1);
  if (
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    index < text.length
  ) {
    index -= 1;
  }
  return Math.max(1, index);
};

const findBreakBefore = (
  text: string,
  requestedIndex: number,
  minimumIndex: number
): number | undefined => {
  const requested = safeCodeUnitCut(text, requestedIndex);
  const minimum = Math.max(1, minimumIndex);

  for (let index = requested - 1; index >= minimum; index -= 1) {
    if (PHRASE_BREAKS.has(text[index])) return index + 1;
  }
  for (let index = requested - 1; index >= minimum; index -= 1) {
    if (isWhitespace(text[index])) return index;
  }
  return undefined;
};

const findBreakAfter = (
  text: string,
  requestedIndex: number,
  maximumIndex: number
): number | undefined => {
  const maximum = Math.min(text.length - 1, maximumIndex);
  for (let index = Math.max(1, requestedIndex); index <= maximum; index += 1) {
    if (PHRASE_BREAKS.has(text[index])) return index + 1;
  }
  for (let index = Math.max(1, requestedIndex); index <= maximum; index += 1) {
    if (isWhitespace(text[index])) return index;
  }
  return undefined;
};

const splitOversizedUnit = (
  input: string,
  maxChars: number,
  minChars: number
): string[] => {
  const pieces: string[] = [];
  let remaining = input.trim();

  while (remaining.length > maxChars) {
    // On the final split, leave enough material to avoid a tiny tail.
    const desiredCut = Math.min(
      maxChars,
      Math.max(minChars, remaining.length - minChars)
    );
    const naturalCut = findBreakBefore(
      remaining,
      desiredCut,
      Math.min(minChars, Math.floor(desiredCut / 2))
    );
    const cut = naturalCut ?? safeCodeUnitCut(remaining, desiredCut);
    const piece = remaining.slice(0, cut).trim();
    if (piece) pieces.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) pieces.push(remaining);
  return pieces;
};

const joinedLength = (parts: readonly string[]): number =>
  parts.reduce(
    (length, part, index) => length + part.length + (index ? 1 : 0),
    0
  );

const joinParts = (parts: readonly string[]): string => parts.join(' ');

const rebalanceTinyTail = (
  batches: string[],
  { targetChars, maxChars, minChars }: NormalizedBatchingOptions
): void => {
  if (batches.length < 2) return;

  const lastIndex = batches.length - 1;
  const tail = batches[lastIndex];
  if (tail.length >= minChars) return;

  const combined = `${batches[lastIndex - 1]} ${tail}`;
  if (combined.length <= maxChars) {
    batches.splice(lastIndex - 1, 2, combined);
    return;
  }

  const minimumCut = Math.max(minChars, combined.length - maxChars);
  const maximumCut = Math.min(maxChars, combined.length - minChars);
  if (minimumCut > maximumCut) return;

  const desiredCut = Math.min(maximumCut, Math.max(minimumCut, targetChars));
  const cut =
    findBreakBefore(combined, desiredCut, minimumCut) ??
    findBreakAfter(combined, desiredCut, maximumCut);
  if (!cut) return;

  const first = combined.slice(0, cut).trim();
  const second = combined.slice(cut).trim();
  if (
    first.length >= minChars &&
    first.length <= maxChars &&
    second.length >= minChars &&
    second.length <= maxChars
  ) {
    batches.splice(lastIndex - 1, 2, first, second);
  }
};

/**
 * Split and pack TTS input into natural, ordered batches. `targetChars` is a
 * soft goal; `maxChars` is always enforced, including for very long sentences.
 */
export function batchTextForTTS(
  text: string,
  options: TTSBatchingOptions = {}
): string[] {
  const normalized = normalizeBatchingOptions(options);
  const sentences = splitTTSSentences(text, normalized);
  if (sentences.length === 0) return [];

  const units = sentences.flatMap(sentence =>
    splitOversizedUnit(sentence, normalized.maxChars, normalized.minChars)
  );
  const packed: string[][] = [];
  let current: string[] = [];

  for (const unit of units) {
    if (current.length === 0) {
      current = [unit];
      continue;
    }

    const currentLength = joinedLength(current);
    const candidateLength = currentLength + 1 + unit.length;
    const currentDistance = Math.abs(normalized.targetChars - currentLength);
    const candidateDistance = Math.abs(
      normalized.targetChars - candidateLength
    );
    const shouldPack =
      candidateLength <= normalized.maxChars &&
      (candidateLength <= normalized.targetChars ||
        currentLength < normalized.minChars ||
        unit.length < normalized.minChars ||
        candidateDistance <= currentDistance);

    if (shouldPack) {
      current.push(unit);
    } else {
      packed.push(current);
      current = [unit];
    }
  }
  if (current.length > 0) packed.push(current);

  const batches = packed.map(joinParts);
  rebalanceTinyTail(batches, normalized);
  return batches;
}

export interface TTSBatchGenerationContext {
  index: number;
  total: number;
  signal: AbortSignal;
}

export type TTSBatchGenerator = (
  text: string,
  context: TTSBatchGenerationContext
) => Promise<Blob>;

export interface TTSDecodedAudio {
  duration: number;
}

export interface TTSAudioBufferSource {
  buffer: TTSDecodedAudio | null;
  onended: (() => void) | null;
  connect(destination: unknown): unknown;
  disconnect?(): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface TTSAudioContext {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state?: string;
  createBufferSource(): TTSAudioBufferSource;
  decodeAudioData(data: ArrayBuffer): Promise<TTSDecodedAudio>;
  resume?(): Promise<void>;
  close?(): Promise<void>;
}

export interface TTSHTMLAudioElement {
  currentTime: number;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  pause(): void;
  play(): Promise<void>;
  removeAttribute?(name: string): void;
  load?(): void;
}

export type TTSPlaybackState =
  'idle' | 'generating' | 'playing' | 'ended' | 'cancelled' | 'error';

export interface TTSPlaybackSessionOptions {
  generate: TTSBatchGenerator;
  /** Values above three are clamped to protect the TTS provider. */
  concurrency?: number;
  /** Ordered results to have ready before playback starts. Defaults to two. */
  initialBufferSize?: number;
  signal?: AbortSignal;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
  /** Primarily useful for tests; returning null selects HTMLAudio playback. */
  audioContextFactory?: () => TTSAudioContext | null;
  audioElementFactory?: (url: string) => TTSHTMLAudioElement;
  objectUrlFactory?: {
    create(blob: Blob): string;
    revoke(url: string): void;
  };
  /** Small scheduling lead so adjacent Web Audio sources can be queued. */
  scheduleLeadSeconds?: number;
}

type GenerationResult = { blob: Blob } | undefined;

const toError = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : new Error(fallback);

const createAbortError = (reason?: unknown): Error => {
  const message =
    reason instanceof Error ? reason.message : 'TTS playback cancelled';
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

export const isTTSPlaybackAbort = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const clampInteger = (
  value: number,
  minimum: number,
  maximum: number
): number => Math.min(maximum, Math.max(minimum, Math.floor(value)));

const safelyCall = (callback: (() => void) | undefined): void => {
  try {
    callback?.();
  } catch {
    // UI lifecycle callbacks must not corrupt audio cleanup or scheduling.
  }
};

const defaultAudioContextFactory = (): TTSAudioContext | null => {
  const audioGlobal = globalThis as typeof globalThis & {
    webkitAudioContext?: new () => TTSAudioContext;
  };
  const AudioContextConstructor =
    (audioGlobal.AudioContext as unknown as
      (new () => TTSAudioContext) | undefined) ??
    audioGlobal.webkitAudioContext;
  if (!AudioContextConstructor) return null;

  try {
    return new AudioContextConstructor();
  } catch {
    return null;
  }
};

const defaultAudioElementFactory = (url: string): TTSHTMLAudioElement => {
  const AudioConstructor = (
    globalThis as typeof globalThis & {
      Audio?: new (src: string) => TTSHTMLAudioElement;
    }
  ).Audio;
  if (!AudioConstructor) {
    throw new Error('Audio playback is not supported in this environment');
  }
  return new AudioConstructor(url) as unknown as TTSHTMLAudioElement;
};

const defaultObjectUrlFactory = {
  create(blob: Blob): string {
    if (typeof URL.createObjectURL !== 'function') {
      throw new Error('Blob audio URLs are not supported in this environment');
    }
    return URL.createObjectURL(blob);
  },
  revoke(url: string): void {
    URL.revokeObjectURL(url);
  },
};

class OrderedGenerationQueue {
  private nextIndex = 0;
  private consumedCount = 0;
  private readonly results: GenerationResult[];
  private readonly waiters = new Set<() => void>();
  private failure: Error | undefined;

  constructor(
    private readonly batches: readonly string[],
    private readonly generate: TTSBatchGenerator,
    private readonly concurrency: number,
    private readonly maxAhead: number,
    private readonly signal: AbortSignal,
    private readonly onFailure: (error: Error) => void
  ) {
    this.results = new Array(batches.length);
    const workerCount = Math.min(concurrency, batches.length);
    for (let worker = 0; worker < workerCount; worker += 1) {
      void this.runWorker();
    }
  }

  async get(index: number): Promise<Blob> {
    while (true) {
      if (this.failure) throw this.failure;
      if (this.signal.aborted) throw createAbortError(this.signal.reason);
      const result = this.results[index];
      if (result) {
        this.results[index] = undefined;
        this.consumedCount = Math.max(this.consumedCount, index + 1);
        this.notify();
        return result.blob;
      }

      await new Promise<void>(resolve => {
        const wake = () => {
          this.waiters.delete(wake);
          this.signal.removeEventListener('abort', wake);
          resolve();
        };
        this.waiters.add(wake);
        this.signal.addEventListener('abort', wake, { once: true });
      });
    }
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private async runWorker(): Promise<void> {
    while (!this.signal.aborted && !this.failure) {
      const index = await this.claimNextIndex();
      if (index === undefined) return;

      try {
        const blob = await this.generate(this.batches[index], {
          index,
          total: this.batches.length,
          signal: this.signal,
        });
        if (this.signal.aborted || this.failure) return;
        if (!blob || typeof blob.arrayBuffer !== 'function') {
          throw new TypeError('The TTS generator did not return a Blob');
        }
        this.results[index] = { blob };
        this.notify();
      } catch (error) {
        if (this.signal.aborted || this.failure) return;
        this.failure = toError(
          error,
          `Failed to generate TTS batch ${index + 1}`
        );
        this.onFailure(this.failure);
        this.notify();
        return;
      }
    }
  }

  private async claimNextIndex(): Promise<number | undefined> {
    while (!this.signal.aborted && !this.failure) {
      if (this.nextIndex >= this.batches.length) return undefined;
      if (this.nextIndex < this.consumedCount + this.maxAhead) {
        const index = this.nextIndex;
        this.nextIndex += 1;
        return index;
      }

      await new Promise<void>(resolve => {
        const wake = () => {
          this.waiters.delete(wake);
          this.signal.removeEventListener('abort', wake);
          resolve();
        };
        this.waiters.add(wake);
        this.signal.addEventListener('abort', wake, { once: true });
      });
    }
    return undefined;
  }
}

/**
 * One-shot, cancelable playback pipeline for pre-batched TTS text. Generation
 * runs concurrently, while decoding and playback always consume results in
 * source order.
 */
export class TTSPlaybackSession {
  private readonly controller = new AbortController();
  private readonly concurrency: number;
  private readonly initialBufferSize: number;
  private readonly scheduleLeadSeconds: number;
  private externalAbortListener: (() => void) | undefined;
  private audioContext: TTSAudioContext | null = null;
  private activeAudio: TTSHTMLAudioElement | null = null;
  private readonly sources = new Set<TTSAudioBufferSource>();
  private started = false;
  private used = false;
  private cancelled = false;
  private fatalError: Error | undefined;
  private currentState: TTSPlaybackState = 'idle';

  constructor(private readonly options: TTSPlaybackSessionOptions) {
    this.concurrency = clampInteger(
      options.concurrency ?? MAX_TTS_GENERATION_CONCURRENCY,
      1,
      MAX_TTS_GENERATION_CONCURRENCY
    );
    this.initialBufferSize = Math.max(
      1,
      Math.floor(options.initialBufferSize ?? DEFAULT_TTS_INITIAL_BUFFER_SIZE)
    );
    this.scheduleLeadSeconds = Math.max(0, options.scheduleLeadSeconds ?? 0.03);

    if (options.signal) {
      this.externalAbortListener = () => {
        this.cancelled = true;
        this.abort(options.signal?.reason);
      };
      if (options.signal.aborted) {
        this.externalAbortListener();
      } else {
        options.signal.addEventListener('abort', this.externalAbortListener, {
          once: true,
        });
      }
    }
  }

  get state(): TTSPlaybackState {
    return this.currentState;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(reason?: unknown): void {
    if (
      this.currentState === 'ended' ||
      this.currentState === 'error' ||
      this.currentState === 'cancelled'
    ) {
      return;
    }
    this.cancelled = true;
    this.abort(reason);
    this.stopActivePlayback();
  }

  async play(inputBatches: readonly string[]): Promise<void> {
    if (this.used)
      throw new Error('A TTSPlaybackSession can only be played once');
    this.used = true;

    const batches = inputBatches.map(batch => batch.trim()).filter(Boolean);
    if (batches.length === 0) {
      this.currentState = 'ended';
      safelyCall(this.options.onEnd);
      this.removeExternalAbortListener();
      return;
    }

    this.currentState = 'generating';
    const queue = new OrderedGenerationQueue(
      batches,
      this.options.generate,
      this.concurrency,
      Math.max(this.concurrency, this.initialBufferSize),
      this.controller.signal,
      error => {
        this.fatalError = error;
        this.abort(error);
      }
    );

    try {
      this.throwIfStopped();
      this.audioContext = (
        this.options.audioContextFactory ?? defaultAudioContextFactory
      )();

      if (this.audioContext) {
        await this.playWithWebAudio(queue, batches.length);
      } else {
        await this.playWithHtmlAudio(queue, batches.length);
      }
      this.throwIfStopped();
      this.currentState = 'ended';
      await this.cleanup();
      safelyCall(this.options.onEnd);
    } catch (error) {
      const failure = this.fatalError ?? toError(error, 'TTS playback failed');
      const wasCancelled = this.cancelled && !this.fatalError;
      this.currentState = wasCancelled ? 'cancelled' : 'error';
      if (!this.controller.signal.aborted) this.abort(failure);
      await this.cleanup();

      if (wasCancelled) throw createAbortError(this.controller.signal.reason);
      try {
        this.options.onError?.(failure);
      } catch {
        // Preserve the original playback error.
      }
      throw failure;
    }
  }

  private abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  private throwIfStopped(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.controller.signal.aborted) {
      throw createAbortError(this.controller.signal.reason);
    }
  }

  private markStarted(): void {
    if (this.started) return;
    this.started = true;
    this.currentState = 'playing';
    safelyCall(this.options.onStart);
  }

  private async playWithWebAudio(
    queue: OrderedGenerationQueue,
    total: number
  ): Promise<void> {
    const context = this.audioContext;
    if (!context) throw new Error('Web Audio context is unavailable');

    if (context.state === 'suspended' && context.resume) {
      await this.raceAbort(context.resume());
    }

    // Keep two decoded sources queued whenever possible. As each leading
    // source ends, decode the next batch in parallel with the remaining one
    // and schedule it at the known boundary. This preserves a natural handoff
    // without decoding or retaining the complete response up front.
    const prebufferCount = Math.min(Math.max(2, this.initialBufferSize), total);
    const decoded: TTSDecodedAudio[] = [];
    for (let index = 0; index < prebufferCount; index += 1) {
      decoded.push(await this.decode(queue, context, index));
    }

    let nextStartTime = context.currentTime + this.scheduleLeadSeconds;
    const ended: Promise<void>[] = [];
    const schedule = (buffer: TTSDecodedAudio) => {
      this.throwIfStopped();
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      this.sources.add(source);

      const completion = new Promise<void>(resolve => {
        source.onended = () => {
          source.onended = null;
          this.sources.delete(source);
          try {
            source.disconnect?.();
          } catch {
            // The source may already have disconnected during cleanup.
          }
          resolve();
        };
      });
      const startTime = Math.max(
        nextStartTime,
        context.currentTime + this.scheduleLeadSeconds
      );
      source.start(startTime);
      this.markStarted();
      nextStartTime = startTime + Math.max(0, buffer.duration);
      ended.push(completion);
    };

    for (const buffer of decoded) schedule(buffer);
    for (let index = prebufferCount; index < total; index += 1) {
      const nextBuffer = this.decode(queue, context, index);
      const leadingSourceEnded = ended[index - prebufferCount];
      const [, buffer] = await this.raceAbort(
        Promise.all([leadingSourceEnded, nextBuffer])
      );
      schedule(buffer);
    }

    await this.raceAbort(Promise.all(ended).then(() => undefined));
  }

  private async decode(
    queue: OrderedGenerationQueue,
    context: TTSAudioContext,
    index: number
  ): Promise<TTSDecodedAudio> {
    const blob = await queue.get(index);
    this.throwIfStopped();
    const encoded = await this.raceAbort(blob.arrayBuffer());
    this.throwIfStopped();
    return this.raceAbort(context.decodeAudioData(encoded));
  }

  private async playWithHtmlAudio(
    queue: OrderedGenerationQueue,
    total: number
  ): Promise<void> {
    const prebufferCount = Math.min(this.initialBufferSize, total);
    const buffered: Blob[] = [];
    for (let index = 0; index < prebufferCount; index += 1) {
      buffered.push(await queue.get(index));
    }

    for (let index = 0; index < total; index += 1) {
      this.throwIfStopped();
      const blob =
        index < prebufferCount ? buffered[index] : await queue.get(index);
      await this.playHtmlBlob(blob);
    }
  }

  private async playHtmlBlob(blob: Blob): Promise<void> {
    const urls = this.options.objectUrlFactory ?? defaultObjectUrlFactory;
    const url = urls.create(blob);
    let audio: TTSHTMLAudioElement | null = null;

    try {
      audio = (this.options.audioElementFactory ?? defaultAudioElementFactory)(
        url
      );
      this.activeAudio = audio;

      const ended = new Promise<void>((resolve, reject) => {
        if (!audio)
          return reject(new Error('Failed to create an audio element'));
        audio.onended = resolve;
        audio.onerror = () => reject(new Error('TTS audio playback failed'));
      });
      await this.raceAbort(audio.play());
      this.markStarted();
      await this.raceAbort(ended);
    } finally {
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        if (this.activeAudio === audio) this.activeAudio = null;
        audio.removeAttribute?.('src');
        audio.load?.();
      }
      urls.revoke(url);
    }
  }

  private raceAbort<T>(promise: Promise<T>): Promise<T> {
    if (this.controller.signal.aborted) {
      return Promise.reject(
        this.fatalError ?? createAbortError(this.controller.signal.reason)
      );
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.controller.signal.removeEventListener('abort', onAbort);
        reject(
          this.fatalError ?? createAbortError(this.controller.signal.reason)
        );
      };
      this.controller.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        value => {
          this.controller.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        error => {
          this.controller.signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  private stopActivePlayback(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already-ended sources throw in some browser implementations.
      }
    }
    if (this.activeAudio) {
      this.activeAudio.pause();
      this.activeAudio.currentTime = 0;
    }
  }

  private async cleanup(): Promise<void> {
    this.stopActivePlayback();
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.disconnect?.();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.sources.clear();

    const context = this.audioContext;
    this.audioContext = null;
    if (context?.close) {
      try {
        await context.close();
      } catch {
        // Closing an already-closed context is harmless for this session.
      }
    }
    this.removeExternalAbortListener();
  }

  private removeExternalAbortListener(): void {
    if (this.options.signal && this.externalAbortListener) {
      this.options.signal.removeEventListener(
        'abort',
        this.externalAbortListener
      );
      this.externalAbortListener = undefined;
    }
  }
}

export const createTTSPlaybackSession = (
  options: TTSPlaybackSessionOptions
): TTSPlaybackSession => new TTSPlaybackSession(options);

let activePlaybackSession: TTSPlaybackSession | null = null;

/**
 * Give one session exclusive ownership of speech playback across chat
 * components. The returned callback releases ownership without cancelling it.
 */
export function activateTTSPlaybackSession(
  session: TTSPlaybackSession
): () => void {
  if (activePlaybackSession !== session) activePlaybackSession?.cancel();
  activePlaybackSession = session;

  return () => {
    if (activePlaybackSession === session) activePlaybackSession = null;
  };
}
