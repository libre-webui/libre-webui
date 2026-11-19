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
import test from 'node:test';
import type { OllamaModel } from '@/types';
import { applyDecisionModels } from '@/store/chatStoreHelpers';
import {
  decisionQuestionsFromDrafts,
  draftsFromDecisionQuestions,
  emptyDecisionQuestionDraft,
  viewDecisionAnswer,
} from './decisionQuestions';

test('decision question drafts become the saved set the server accepts', () => {
  const yesNo = {
    ...emptyDecisionQuestionDraft('noul'),
    instructions: ' Is a refund being requested? ',
  };
  const choice = {
    ...emptyDecisionQuestionDraft('choice'),
    instructions: 'Which team?',
    options: [
      { name: 'billing', description: 'Payments and refunds' },
      { name: 'technical', description: '' },
      { name: '', description: '' },
    ],
  };
  const score = {
    ...emptyDecisionQuestionDraft('score'),
    instructions: 'How urgent?',
    levels: ['Routine', ' Soon ', '', 'Immediate'],
  };
  const result = decisionQuestionsFromDrafts([yesNo, choice, score]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.questions, {
    q1: { type: 'noul', instructions: 'Is a refund being requested?' },
    q2: {
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'Payments and refunds', technical: null },
    },
    q3: {
      type: 'score',
      instructions: 'How urgent?',
      criteria: ['Routine', 'Soon', 'Immediate'],
    },
  });
  assert.deepEqual(
    decisionQuestionsFromDrafts(
      draftsFromDecisionQuestions(result.ok ? result.questions : undefined)
    ),
    result,
    'a saved set opens in the editor and saves back unchanged'
  );
  assert.deepEqual(decisionQuestionsFromDrafts([]), {
    ok: true,
    questions: undefined,
  });
});

test('the decision editor refuses what the server would refuse', () => {
  assert.deepEqual(
    decisionQuestionsFromDrafts([emptyDecisionQuestionDraft('noul')]),
    { ok: false, error: { kind: 'instructions', question: 1 } }
  );
  const duplicate = {
    ...emptyDecisionQuestionDraft('choice'),
    instructions: 'Pick one',
    options: [
      { name: 'a', description: '' },
      { name: 'a', description: 'again' },
    ],
  };
  assert.deepEqual(decisionQuestionsFromDrafts([duplicate]), {
    ok: false,
    error: { kind: 'options', question: 1 },
  });
  const oneLevel = {
    ...emptyDecisionQuestionDraft('score'),
    instructions: 'Rate it',
    levels: ['only'],
  };
  assert.deepEqual(decisionQuestionsFromDrafts([oneLevel]), {
    ok: false,
    error: { kind: 'levels', question: 1 },
  });
});

test('decision answers read as the answer, its probability, and the spread', () => {
  const yes = viewDecisionAnswer(
    { type: 'noul', instructions: 'Refund?' },
    { type: 'noul', noul: 0.97 }
  );
  assert.equal(yes.kind, 'yes');
  assert.equal(yes.probability, 0.97);
  const no = viewDecisionAnswer(
    { type: 'noul', instructions: 'Refund?' },
    { type: 'noul', noul: 0.2 }
  );
  assert.equal(no.kind, 'no');
  assert.ok(Math.abs((no.probability ?? 0) - 0.8) < 1e-9);

  const score = viewDecisionAnswer(
    {
      type: 'score',
      instructions: 'Urgency',
      criteria: ['Routine', 'Soon', 'Immediate'],
    },
    {
      type: 'score',
      score: 0.83,
      legend: { '0': 'Routine', '1': 'Soon', '2': 'Immediate' },
      probabilities: { '0': 0.3, '1': 0.57, '2': 0.13 },
    }
  );
  assert.equal(score.label, 'Soon');
  assert.deepEqual(score.score, { value: 1.83, max: 3 });
  assert.deepEqual(
    score.distribution.map(entry => entry.label),
    ['Soon', 'Routine', 'Immediate']
  );
  assert.equal(
    viewDecisionAnswer(undefined, { type: 'refusal' }).kind,
    'refusal'
  );
});

test('decision models are marked, added, or hidden in the model list', () => {
  const base = (name: string, extra: Partial<OllamaModel> = {}) =>
    ({ name, size: 0, digest: '', modified_at: '', ...extra }) as OllamaModel;
  const models = [
    base('llama3.2'),
    base('nimble'),
    base('zai-org/GLM-5.3', { isPlugin: true, pluginId: 'baseten' }),
  ];
  const list = {
    allowed: true,
    models: [
      {
        id: 'nimble',
        providerType: 'ollama' as const,
        providerName: 'Ollama',
        images: false,
      },
      {
        id: 'decision-models/baseten-elephant-9b-latest',
        providerType: 'plugin' as const,
        providerId: 'baseten',
        providerName: 'Baseten',
        images: true,
      },
    ],
  };
  const marked = applyDecisionModels(models, list);
  assert.deepEqual(
    marked.map(model => [model.name, model.isDecision === true]),
    [
      ['llama3.2', false],
      ['nimble', true],
      ['zai-org/GLM-5.3', false],
      ['decision-models/baseten-elephant-9b-latest', true],
    ]
  );
  const added = marked[3];
  assert.equal(added.isPlugin, true);
  assert.equal(added.pluginId, 'baseten');
  assert.equal(added.decisionImages, true);

  assert.deepEqual(
    applyDecisionModels(models, { ...list, allowed: false }).map(m => m.name),
    ['llama3.2', 'zai-org/GLM-5.3'],
    'an account without access is not offered a model it cannot use'
  );
});
