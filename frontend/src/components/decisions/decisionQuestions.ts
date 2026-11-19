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

import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionQuestions,
  DecisionReplyMetadata,
} from '@/types';

/** The limits the server enforces, so the editor says no first. */
export const DECISION_EDITOR_LIMITS = {
  maxQuestions: 64,
  minOptions: 2,
  maxOptions: 255,
  minLevels: 2,
  maxLevels: 10,
} as const;

export type DecisionQuestionType = DecisionQuestion['type'];

/** One question as the editor holds it, before it is valid. */
export interface DecisionQuestionDraft {
  type: DecisionQuestionType;
  instructions: string;
  options: Array<{ name: string; description: string }>;
  levels: string[];
  trueDescription: string;
  falseDescription: string;
}

export const emptyDecisionQuestionDraft = (
  type: DecisionQuestionType = 'noul'
): DecisionQuestionDraft => ({
  type,
  instructions: '',
  options: [
    { name: '', description: '' },
    { name: '', description: '' },
  ],
  levels: ['', '', ''],
  trueDescription: '',
  falseDescription: '',
});

export function draftsFromDecisionQuestions(
  questions: DecisionQuestions | undefined
): DecisionQuestionDraft[] {
  return Object.values(questions ?? {}).map(question => {
    const draft = emptyDecisionQuestionDraft(question.type);
    draft.instructions = question.instructions;
    if (question.type === 'choice') {
      draft.options = Object.entries(question.criteria).map(
        ([name, description]) => ({ name, description: description ?? '' })
      );
    } else if (question.type === 'score') {
      draft.levels = [...question.criteria];
    } else {
      draft.trueDescription = question.criteria?.true ?? '';
      draft.falseDescription = question.criteria?.false ?? '';
    }
    return draft;
  });
}

export type DecisionDraftError =
  | { kind: 'too-many' }
  | { kind: 'instructions' | 'options' | 'levels'; question: number };

/**
 * The saved question set for a list of drafts, or the first problem. Names
 * are q1, q2, ... in order: the answers are shown with each question's own
 * text, so the names only need to be valid and stable.
 */
export function decisionQuestionsFromDrafts(
  drafts: readonly DecisionQuestionDraft[]
):
  | { ok: true; questions: DecisionQuestions | undefined }
  | { ok: false; error: DecisionDraftError } {
  if (drafts.length > DECISION_EDITOR_LIMITS.maxQuestions) {
    return { ok: false, error: { kind: 'too-many' } };
  }
  const questions: DecisionQuestions = {};
  for (const [index, draft] of drafts.entries()) {
    const number = index + 1;
    const instructions = draft.instructions.trim();
    if (!instructions) {
      return { ok: false, error: { kind: 'instructions', question: number } };
    }
    if (draft.type === 'choice') {
      const options = draft.options
        .map(option => ({
          name: option.name.trim(),
          description: option.description.trim(),
        }))
        .filter(option => option.name || option.description);
      const names = new Set(options.map(option => option.name));
      if (
        options.some(option => !option.name) ||
        names.size !== options.length ||
        options.length < DECISION_EDITOR_LIMITS.minOptions ||
        options.length > DECISION_EDITOR_LIMITS.maxOptions
      ) {
        return { ok: false, error: { kind: 'options', question: number } };
      }
      questions[`q${number}`] = {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(
          options.map(option => [option.name, option.description || null])
        ),
      };
    } else if (draft.type === 'score') {
      const levels = draft.levels.map(level => level.trim()).filter(Boolean);
      if (
        levels.length < DECISION_EDITOR_LIMITS.minLevels ||
        levels.length > DECISION_EDITOR_LIMITS.maxLevels
      ) {
        return { ok: false, error: { kind: 'levels', question: number } };
      }
      questions[`q${number}`] = {
        type: 'score',
        instructions,
        criteria: levels,
      };
    } else {
      const trueDescription = draft.trueDescription.trim();
      const falseDescription = draft.falseDescription.trim();
      questions[`q${number}`] =
        trueDescription || falseDescription
          ? {
              type: 'noul',
              instructions,
              criteria: {
                ...(trueDescription ? { true: trueDescription } : {}),
                ...(falseDescription ? { false: falseDescription } : {}),
              },
            }
          : { type: 'noul', instructions };
    }
  }
  return {
    ok: true,
    questions: Object.keys(questions).length > 0 ? questions : undefined,
  };
}

/** One answer as the result card shows it. */
export interface DecisionAnswerView {
  /** The answer's label: yes or no, an option, or a level. */
  label: string;
  /** The answer's own probability, 0 to 1. */
  probability?: number;
  kind: 'yes' | 'no' | 'choice' | 'score' | 'refusal';
  /** For a score: the weighted level and the number of levels, counted from 1. */
  score?: { value: number; max: number };
  /** Every candidate with its probability, highest first. */
  distribution: Array<{ label: string; probability: number }>;
  confidence?: number;
}

export function viewDecisionAnswer(
  question: DecisionQuestion | undefined,
  answer: DecisionAnswer | undefined
): DecisionAnswerView {
  if (!answer || answer.type === 'refusal') {
    return { label: '', kind: 'refusal', distribution: [] };
  }
  if (answer.type === 'noul') {
    const yes = answer.noul >= 0.5;
    return {
      label: '',
      kind: yes ? 'yes' : 'no',
      probability: yes ? answer.noul : 1 - answer.noul,
      distribution: [
        { label: 'yes', probability: answer.noul },
        { label: 'no', probability: 1 - answer.noul },
      ],
      ...(answer.confidence !== undefined
        ? { confidence: answer.confidence }
        : {}),
    };
  }
  const distribution = Object.entries(answer.probabilities)
    .map(([key, probability]) => ({
      label:
        answer.type === 'score' ? (answer.legend[key] ?? key) : String(key),
      probability,
    }))
    .sort((a, b) => b.probability - a.probability);
  if (answer.type === 'choice') {
    return {
      label: answer.choice,
      kind: 'choice',
      probability: answer.probabilities[answer.choice],
      distribution,
      ...(answer.confidence !== undefined
        ? { confidence: answer.confidence }
        : {}),
    };
  }
  const levels =
    question?.type === 'score'
      ? question.criteria.length
      : Object.keys(answer.legend).length;
  return {
    label: distribution[0]?.label ?? '',
    kind: 'score',
    probability: distribution[0]?.probability,
    // Providers number levels from 0; people count them from 1.
    score: { value: answer.score + 1, max: levels },
    distribution,
    ...(answer.confidence !== undefined
      ? { confidence: answer.confidence }
      : {}),
  };
}

export const formatDecisionPercent = (value: number): string =>
  `${(Math.round(value * 1000) / 10).toFixed(1)}%`;

/** The decision a reply's provider metadata carries, when it carries one. */
export function readDecisionReplyMetadata(
  providerMetadata: Record<string, unknown> | undefined
): DecisionReplyMetadata | null {
  const decision = providerMetadata?.decision;
  if (!decision || typeof decision !== 'object') return null;
  const kind = (decision as { kind?: unknown }).kind;
  if (kind === 'state' || kind === 'cleared') {
    return { kind };
  }
  if (
    kind === 'answers' &&
    typeof (decision as { questions?: unknown }).questions === 'object' &&
    typeof (decision as { answers?: unknown }).answers === 'object'
  ) {
    return decision as DecisionReplyMetadata;
  }
  return null;
}
