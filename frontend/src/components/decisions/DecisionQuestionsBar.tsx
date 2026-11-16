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

import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks, Plus, Trash2, X } from 'lucide-react';
import {
  Button,
  ModalShell,
  modalFieldClass,
  modalLabelClass,
} from '@/components/ui';
import type { DecisionQuestions } from '@/types';
import { cn } from '@/utils';
import {
  DECISION_EDITOR_LIMITS,
  decisionQuestionsFromDrafts,
  draftsFromDecisionQuestions,
  emptyDecisionQuestionDraft,
  type DecisionDraftError,
  type DecisionQuestionDraft,
  type DecisionQuestionType,
} from './decisionQuestions';

interface DecisionQuestionsBarProps {
  questions: DecisionQuestions | undefined;
  /** Saves the set; undefined returns the chat to interactive mode. */
  onSave: (questions: DecisionQuestions | undefined) => Promise<void> | void;
  disabled?: boolean;
}

const QUESTION_TYPES: DecisionQuestionType[] = ['noul', 'choice', 'score'];

/**
 * Shown above the composer while a decision model is selected: the questions
 * each message is judged against, or how interactive mode works when there
 * are none, with the editor one click away.
 */
export const DecisionQuestionsBar: React.FC<DecisionQuestionsBarProps> = ({
  questions,
  onSave,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const list = Object.values(questions ?? {});

  return (
    <div
      data-testid='decision-questions-bar'
      className='mb-2 flex items-start gap-2 rounded-xl border border-line bg-surface-raised px-3 py-2 text-xs text-ink-muted'
    >
      <ListChecks className='mt-0.5 h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400' />
      <div className='min-w-0 flex-1'>
        <p className='font-medium text-ink'>{t('chat.decision.barTitle')}</p>
        {list.length === 0 ? (
          <p className='mt-0.5 leading-5'>
            {t('chat.decision.interactiveHint')}
          </p>
        ) : (
          <ul className='mt-1 flex flex-wrap gap-1.5'>
            {list.map((question, index) => (
              <li
                key={index}
                dir='auto'
                className='max-w-full truncate rounded-md bg-primary-50 px-2 py-0.5 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                title={question.instructions}
              >
                <span className='me-1 opacity-70'>
                  {t(`chat.decision.types.${question.type}`)}
                </span>
                {question.instructions}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Button
        size='sm'
        variant='outline'
        disabled={disabled}
        onClick={() => setEditing(true)}
        data-testid='decision-questions-edit'
      >
        {list.length === 0 ? t('chat.decision.add') : t('chat.decision.edit')}
      </Button>
      {editing && (
        <DecisionQuestionsDialog
          questions={questions}
          onClose={() => setEditing(false)}
          onSave={async next => {
            await onSave(next);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
};

const errorMessage = (
  t: ReturnType<typeof useTranslation>['t'],
  error: DecisionDraftError
): string => {
  if (error.kind === 'too-many') {
    return t('chat.decision.errors.tooMany', {
      max: DECISION_EDITOR_LIMITS.maxQuestions,
    });
  }
  return t(`chat.decision.errors.${error.kind}`, { number: error.question });
};

interface DecisionQuestionsDialogProps {
  questions: DecisionQuestions | undefined;
  onClose: () => void;
  onSave: (questions: DecisionQuestions | undefined) => Promise<void>;
}

const DecisionQuestionsDialog: React.FC<DecisionQuestionsDialogProps> = ({
  questions,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const fieldPrefix = useId();
  const [drafts, setDrafts] = useState<DecisionQuestionDraft[]>(() => {
    const existing = draftsFromDecisionQuestions(questions);
    return existing.length > 0 ? existing : [emptyDecisionQuestionDraft()];
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const update = (
    index: number,
    change: (draft: DecisionQuestionDraft) => DecisionQuestionDraft
  ) => {
    setError(null);
    setDrafts(current =>
      current.map((draft, i) => (i === index ? change(draft) : draft))
    );
  };

  const save = async (next: DecisionQuestionDraft[]) => {
    const result = decisionQuestionsFromDrafts(next);
    if (!result.ok) {
      setError(errorMessage(t, result.error));
      return;
    }
    setSaving(true);
    try {
      await onSave(result.questions);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      titleId={titleId}
      title={t('chat.decision.dialogTitle')}
      subtitle={t('chat.decision.dialogSubtitle')}
      onClose={onClose}
      widthClassName='max-w-2xl'
      testId='decision-questions-dialog'
      footer={
        <>
          <Button
            variant='ghost'
            disabled={saving}
            onClick={() => void save([])}
            data-testid='decision-questions-interactive'
          >
            {t('chat.decision.useInteractive')}
          </Button>
          <Button variant='outline' disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={saving}
            onClick={() => void save(drafts)}
            data-testid='decision-questions-save'
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      {drafts.map((draft, index) => {
        const id = `${fieldPrefix}-${index}`;
        return (
          <fieldset
            key={index}
            className='space-y-3 rounded-2xl border border-line p-4'
          >
            <div className='flex items-center justify-between gap-2'>
              <legend className='text-sm font-medium text-ink'>
                {t('chat.decision.questionNumber', { number: index + 1 })}
              </legend>
              <button
                type='button'
                aria-label={t('chat.decision.removeQuestion')}
                title={t('chat.decision.removeQuestion')}
                onClick={() =>
                  setDrafts(current => current.filter((_, i) => i !== index))
                }
                className='rounded-lg p-1.5 text-ink-muted hover:bg-interactive-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500'
              >
                <Trash2 className='h-4 w-4' />
              </button>
            </div>
            <div
              role='radiogroup'
              aria-label={t('chat.decision.typeLabel')}
              className='flex flex-wrap gap-1.5'
            >
              {QUESTION_TYPES.map(type => (
                <button
                  key={type}
                  type='button'
                  role='radio'
                  aria-checked={draft.type === type}
                  onClick={() =>
                    update(index, current => ({ ...current, type }))
                  }
                  className={cn(
                    'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                    draft.type === type
                      ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-dark-200 dark:text-gray-400 dark:hover:bg-dark-300'
                  )}
                >
                  {t(`chat.decision.types.${type}`)}
                </button>
              ))}
            </div>
            <div>
              <label htmlFor={`${id}-q`} className={modalLabelClass}>
                {t('chat.decision.question')}
              </label>
              <input
                id={`${id}-q`}
                dir='auto'
                value={draft.instructions}
                placeholder={t(`chat.decision.placeholders.${draft.type}`)}
                onChange={event =>
                  update(index, current => ({
                    ...current,
                    instructions: event.target.value,
                  }))
                }
                className={modalFieldClass}
              />
            </div>

            {draft.type === 'noul' && (
              <div className='grid gap-3 sm:grid-cols-2'>
                {(['trueDescription', 'falseDescription'] as const).map(
                  field => (
                    <div key={field}>
                      <label
                        htmlFor={`${id}-${field}`}
                        className={modalLabelClass}
                      >
                        {t(
                          field === 'trueDescription'
                            ? 'chat.decision.yesMeans'
                            : 'chat.decision.noMeans'
                        )}
                      </label>
                      <input
                        id={`${id}-${field}`}
                        dir='auto'
                        value={draft[field]}
                        onChange={event =>
                          update(index, current => ({
                            ...current,
                            [field]: event.target.value,
                          }))
                        }
                        className={modalFieldClass}
                      />
                    </div>
                  )
                )}
              </div>
            )}

            {draft.type === 'choice' && (
              <div className='space-y-2'>
                <p className={modalLabelClass}>{t('chat.decision.options')}</p>
                {draft.options.map((option, optionIndex) => (
                  <div key={optionIndex} className='flex gap-2'>
                    <input
                      dir='auto'
                      aria-label={t('chat.decision.optionName', {
                        number: optionIndex + 1,
                      })}
                      placeholder={t('chat.decision.optionNamePlaceholder')}
                      value={option.name}
                      onChange={event =>
                        update(index, current => ({
                          ...current,
                          options: current.options.map((entry, i) =>
                            i === optionIndex
                              ? { ...entry, name: event.target.value }
                              : entry
                          ),
                        }))
                      }
                      className={cn(modalFieldClass, 'w-2/5')}
                    />
                    <input
                      dir='auto'
                      aria-label={t('chat.decision.optionDescription', {
                        number: optionIndex + 1,
                      })}
                      placeholder={t(
                        'chat.decision.optionDescriptionPlaceholder'
                      )}
                      value={option.description}
                      onChange={event =>
                        update(index, current => ({
                          ...current,
                          options: current.options.map((entry, i) =>
                            i === optionIndex
                              ? { ...entry, description: event.target.value }
                              : entry
                          ),
                        }))
                      }
                      className={modalFieldClass}
                    />
                    <button
                      type='button'
                      aria-label={t('chat.decision.removeOption', {
                        number: optionIndex + 1,
                      })}
                      onClick={() =>
                        update(index, current => ({
                          ...current,
                          options: current.options.filter(
                            (_, i) => i !== optionIndex
                          ),
                        }))
                      }
                      className='shrink-0 rounded-lg p-1.5 text-ink-muted hover:bg-interactive-hover hover:text-ink'
                    >
                      <X className='h-4 w-4' />
                    </button>
                  </div>
                ))}
                {draft.options.length < DECISION_EDITOR_LIMITS.maxOptions && (
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() =>
                      update(index, current => ({
                        ...current,
                        options: [
                          ...current.options,
                          { name: '', description: '' },
                        ],
                      }))
                    }
                  >
                    <Plus className='me-1 h-3.5 w-3.5' />
                    {t('chat.decision.addOption')}
                  </Button>
                )}
              </div>
            )}

            {draft.type === 'score' && (
              <div className='space-y-2'>
                <p className={modalLabelClass}>{t('chat.decision.levels')}</p>
                {draft.levels.map((level, levelIndex) => (
                  <div key={levelIndex} className='flex items-center gap-2'>
                    <span className='w-5 shrink-0 text-end text-xs tabular-nums text-ink-muted'>
                      {levelIndex + 1}
                    </span>
                    <input
                      dir='auto'
                      aria-label={t('chat.decision.levelLabel', {
                        number: levelIndex + 1,
                      })}
                      placeholder={t('chat.decision.levelPlaceholder')}
                      value={level}
                      onChange={event =>
                        update(index, current => ({
                          ...current,
                          levels: current.levels.map((entry, i) =>
                            i === levelIndex ? event.target.value : entry
                          ),
                        }))
                      }
                      className={modalFieldClass}
                    />
                    <button
                      type='button'
                      aria-label={t('chat.decision.removeLevel', {
                        number: levelIndex + 1,
                      })}
                      onClick={() =>
                        update(index, current => ({
                          ...current,
                          levels: current.levels.filter(
                            (_, i) => i !== levelIndex
                          ),
                        }))
                      }
                      className='shrink-0 rounded-lg p-1.5 text-ink-muted hover:bg-interactive-hover hover:text-ink'
                    >
                      <X className='h-4 w-4' />
                    </button>
                  </div>
                ))}
                {draft.levels.length < DECISION_EDITOR_LIMITS.maxLevels && (
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() =>
                      update(index, current => ({
                        ...current,
                        levels: [...current.levels, ''],
                      }))
                    }
                  >
                    <Plus className='me-1 h-3.5 w-3.5' />
                    {t('chat.decision.addLevel')}
                  </Button>
                )}
              </div>
            )}
          </fieldset>
        );
      })}

      {drafts.length < DECISION_EDITOR_LIMITS.maxQuestions && (
        <Button
          variant='outline'
          onClick={() =>
            setDrafts(current => [...current, emptyDecisionQuestionDraft()])
          }
          data-testid='decision-questions-add'
        >
          <Plus className='me-1 h-4 w-4' />
          {t('chat.decision.addQuestion')}
        </Button>
      )}

      {error && (
        <p role='alert' className='text-sm text-red-600 dark:text-red-400'>
          {error}
        </p>
      )}
    </ModalShell>
  );
};

export default DecisionQuestionsBar;
