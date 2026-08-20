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

/**
 * Lexical scoring and rank fusion for hybrid document retrieval.
 *
 * Chunk text is encrypted at rest in both storage dialects, so Libre keeps
 * lexical scoring in-process instead of building an on-disk full-text index
 * that would persist plaintext tokens next to the ciphertext. BM25 runs over
 * the ACL-scoped candidate set the caller already loaded, and reciprocal-rank
 * fusion merges that ranking with the vector ranking. Document-frequency
 * statistics are computed per query over the candidate corpus, which keeps
 * scores comparable inside one search and requires no maintained state.
 */

const BM25_K1 = 1.2;
const BM25_B = 0.75;
export const RRF_K = 60;

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

/** Unicode-aware tokens, lowercased, single characters dropped. */
export const tokenizeForRetrieval = (text: string): string[] => {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD_PATTERN)) {
    if (match[0].length > 1) tokens.push(match[0]);
  }
  return tokens;
};

export interface RetrievalCandidate {
  id: string;
  text: string;
}

export interface ScoredCandidate {
  id: string;
  score: number;
}

/**
 * Okapi BM25 over one candidate set. Returns only candidates with a
 * positive score, best first, ties broken by id for deterministic output.
 */
export const scoreCandidatesBm25 = (
  query: string,
  candidates: readonly RetrievalCandidate[]
): ScoredCandidate[] => {
  const queryTerms = [...new Set(tokenizeForRetrieval(query))];
  if (queryTerms.length === 0 || candidates.length === 0) return [];

  const termFrequencies: Array<Map<string, number>> = [];
  const lengths: number[] = [];
  const documentFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    const tokens = tokenizeForRetrieval(candidate.text);
    const frequency = new Map<string, number>();
    for (const token of tokens) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
    termFrequencies.push(frequency);
    lengths.push(tokens.length);
    for (const term of queryTerms) {
      if (frequency.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const averageLength = totalLength > 0 ? totalLength / candidates.length : 1;

  const scored: ScoredCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const frequency = termFrequencies[index];
    const length = lengths[index];
    let score = 0;
    for (const term of queryTerms) {
      const termFrequency = frequency.get(term);
      if (!termFrequency) continue;
      const matching = documentFrequency.get(term) ?? 0;
      const idf = Math.log(
        1 + (candidates.length - matching + 0.5) / (matching + 0.5)
      );
      score +=
        (idf * (termFrequency * (BM25_K1 + 1))) /
        (termFrequency +
          BM25_K1 * (1 - BM25_B + (BM25_B * length) / averageLength));
    }
    if (score > 0) scored.push({ id: candidates[index].id, score });
  }
  return scored.sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id)
  );
};

/**
 * Reciprocal-rank fusion of independently ranked id lists. An id absent
 * from a list simply contributes nothing for that list; ids appearing in
 * several lists accumulate. Best first, ties broken by id.
 */
export const reciprocalRankFusion = (
  rankedLists: readonly (readonly string[])[],
  k = RRF_K
): ScoredCandidate[] => {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const id = list[rank];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id)
    );
};
