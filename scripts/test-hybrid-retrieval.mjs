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

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const { scoreCandidatesBm25, reciprocalRankFusion, tokenizeForRetrieval } =
  await import(dist('utils/hybridRetrieval.js'));

test('tokenization is unicode-aware, lowercased, and drops single characters', () => {
  assert.deepEqual(
    tokenizeForRetrieval('Müller invoiced 42 € for the RAG-pipeline, § 7a.'),
    ['müller', 'invoiced', '42', 'for', 'the', 'rag', 'pipeline', '7a']
  );
  assert.deepEqual(tokenizeForRetrieval('a b c'), []);
});

test('BM25 weighs rare terms above common terms', () => {
  const candidates = [
    { id: 'about-refunds', text: 'refund policy refund window refund steps' },
    { id: 'about-invoices', text: 'the quarterly invoice covers the pelican' },
    { id: 'filler-one', text: 'the handbook covers the general policy' },
    { id: 'filler-two', text: 'the policy describes the general handbook' },
  ];
  // "pelican" appears in one document, "policy" in three: the rare term must
  // dominate even though the query mentions both.
  const scored = scoreCandidatesBm25('pelican policy', candidates);
  assert.equal(scored[0].id, 'about-invoices');
  assert.ok(scored.length >= 3, 'policy matches must still score');
});

test('BM25 length normalization keeps a short exact match ahead of a padded one', () => {
  const padding = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const scored = scoreCandidatesBm25('narwhal', [
    { id: 'short', text: 'the narwhal migration' },
    { id: 'padded', text: `narwhal ${padding}` },
    { id: 'unrelated', text: 'nothing relevant here' },
  ]);
  assert.deepEqual(
    scored.map(entry => entry.id),
    ['short', 'padded']
  );
});

test('BM25 output is deterministic and only ever positive', () => {
  const scored = scoreCandidatesBm25('tie', [
    { id: 'b', text: 'tie' },
    { id: 'a', text: 'tie' },
    { id: 'c', text: 'no match' },
  ]);
  assert.deepEqual(
    scored.map(entry => entry.id),
    ['a', 'b']
  );
  assert.ok(scored.every(entry => entry.score > 0));
  assert.deepEqual(scoreCandidatesBm25('', [{ id: 'a', text: 'x' }]), []);
  assert.deepEqual(scoreCandidatesBm25('term', []), []);
});

test('reciprocal-rank fusion rewards agreement between rankings', () => {
  const fused = reciprocalRankFusion([
    ['semantic-top', 'agreed', 'semantic-tail'],
    ['lexical-top', 'agreed', 'lexical-tail'],
  ]);
  assert.equal(fused[0].id, 'agreed');
  const ids = fused.map(entry => entry.id);
  assert.ok(ids.includes('semantic-top') && ids.includes('lexical-top'));
  // A single-list id still surfaces — one empty ranking must not censor the other.
  const oneSided = reciprocalRankFusion([[], ['only-lexical']]);
  assert.deepEqual(oneSided.map(entry => entry.id), ['only-lexical']);
});

// A small labeled corpus proving the hybrid property this feature exists
// for: fusion recovers the relevant answer both when the lexical ranking
// fails (synonym query) and when the semantic ranking fails (identifier
// query), without regressing when both agree.
test('rank fusion recovers labeled answers that either ranking alone misses', () => {
  const corpus = [
    { id: 'billing', text: 'Invoices are issued on the first business day.' },
    { id: 'refunds', text: 'Reimbursements are wired within ten days.' },
    { id: 'errors', text: 'Error E4512 means the ledger export failed.' },
    { id: 'hours', text: 'Support answers between 9am and 5pm.' },
  ];
  const evaluations = [
    {
      // Lexical search cannot match "refund" against "reimbursements";
      // the semantic ranking knows they are the same concept.
      query: 'refund timeline',
      relevant: 'refunds',
      semanticRanking: ['refunds', 'billing'],
    },
    {
      // The identifier only exists verbatim; the semantic ranking is
      // distracted by conceptually related but wrong chunks.
      query: 'E4512',
      relevant: 'errors',
      semanticRanking: ['billing', 'refunds'],
    },
    {
      query: 'invoice schedule',
      relevant: 'billing',
      semanticRanking: ['billing', 'hours'],
    },
  ];
  for (const { query, relevant, semanticRanking } of evaluations) {
    const lexicalRanking = scoreCandidatesBm25(query, corpus).map(
      entry => entry.id
    );
    const fused = reciprocalRankFusion([semanticRanking, lexicalRanking]);
    const topTwo = fused.slice(0, 2).map(entry => entry.id);
    assert.ok(
      topTwo.includes(relevant),
      `query "${query}" must rank ${relevant} in the fused top 2 (got ${topTwo.join(', ')})`
    );
  }
});
