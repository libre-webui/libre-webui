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

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type {
  Automation,
  AutomationTarget,
  AutomationTrigger,
  OllamaModel,
} from '@/types';
import type { AutomationPayload } from '@/utils/api/automationsApi';
import { isTriggerValid } from '@/utils/automationSchedule';
import { workApi } from '@/utils/api';
import type { WorkPolicy } from '@/types/work';
import { cn } from '@/utils';
import { TriggerEditor } from './TriggerEditor';

interface AutomationModalProps {
  open: boolean;
  automation: Automation | null;
  /** Prefill for a new automation (template); ignored while editing. */
  initial?: Partial<AutomationPayload> | null;
  /**
   * Bind the routine to an existing Work task (agent). Forces the work
   * target and hides target/policy/model controls: every fire runs inside
   * that task with the task's own model and runtime.
   */
  fixedWorkTaskId?: string;
  models: OllamaModel[];
  saving: boolean;
  onClose: () => void;
  onSave: (payload: AutomationPayload) => void;
}

const fieldClass =
  'w-full rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[13px] text-gray-900 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.08] dark:bg-dark-100 dark:text-dark-900';
const labelClass =
  'mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500';

/** `providerType[:providerId]` for a picked model; undefined means Auto. */
const providerOf = (model: OllamaModel): string => {
  if (model.isPlugin && model.pluginId) return `plugin:${model.pluginId}`;
  if (model.isAgent && model.agentId) return `agent:${model.agentId}`;
  return 'ollama';
};

export function AutomationModal({
  open,
  automation,
  initial,
  fixedWorkTaskId,
  models,
  saving,
  onClose,
  onSave,
}: AutomationModalProps) {
  if (!open) return null;
  return (
    <AutomationModalForm
      key={automation?.id ?? initial?.name ?? 'new'}
      automation={automation}
      initial={initial}
      fixedWorkTaskId={fixedWorkTaskId}
      models={models}
      saving={saving}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

// The guard component above remounts this form per target so its state
// initializes directly from props.
function AutomationModalForm({
  automation,
  initial,
  fixedWorkTaskId,
  models,
  saving,
  onClose,
  onSave,
}: Omit<AutomationModalProps, 'open'>) {
  const { t } = useTranslation();
  const taskBound = Boolean(fixedWorkTaskId ?? automation?.workTaskId);
  const [name, setName] = useState(automation?.name ?? initial?.name ?? '');
  const [instructions, setInstructions] = useState(
    automation?.instructions ?? initial?.instructions ?? ''
  );
  const [triggers, setTriggers] = useState<AutomationTrigger[]>(
    automation?.triggers ??
      initial?.triggers ?? [{ kind: 'daily', hour: 8, minute: 0 }]
  );
  const [model, setModel] = useState(automation?.model ?? '');
  const [notify, setNotify] = useState<'app' | 'off'>(
    automation?.notify ?? 'app'
  );
  const [target, setTarget] = useState<AutomationTarget>(
    automation?.target ?? 'chat'
  );
  const [workPolicyId, setWorkPolicyId] = useState(
    automation?.workPolicyId ?? ''
  );
  // Named policies are optional server config; an empty list renders no
  // picker, mirroring the Work composer.
  const [policies, setPolicies] = useState<WorkPolicy[]>([]);
  useEffect(() => {
    if (target !== 'work' || taskBound) return;
    let cancelled = false;
    workApi
      .listPolicies()
      .then(response => {
        if (!cancelled && response.success && Array.isArray(response.data)) {
          setPolicies(response.data);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [target, taskBound]);

  const valid =
    name.trim().length > 0 &&
    instructions.trim().length > 0 &&
    triggers.length > 0 &&
    triggers.every(isTriggerValid);

  const handleSave = () => {
    if (!valid) return;
    if (taskBound) {
      // The bound task supplies model, provider, and runtime; none of the
      // automation-level routing fields apply.
      onSave({
        name: name.trim(),
        instructions: instructions.trim(),
        triggers,
        notify,
        target: 'work',
        workTaskId: fixedWorkTaskId ?? automation?.workTaskId,
      });
      return;
    }
    const picked = models.find(item => item.name === model);
    onSave({
      name: name.trim(),
      instructions: instructions.trim(),
      triggers,
      ...(picked ? { provider: providerOf(picked), model: picked.name } : {}),
      notify,
      target,
      ...(target === 'work' && workPolicyId ? { workPolicyId } : {}),
    });
  };

  return createPortal(
    <div
      className='fixed inset-0 z-[2147483647] flex items-center justify-center bg-gray-950/55 p-4 backdrop-blur-md'
      onClick={onClose}
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='automation-modal-title'
        data-testid='automation-modal'
        className='max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-black/[0.07] bg-white p-6 shadow-[0_24px_80px_rgba(0,0,0,0.24)] animate-scale-in scrollbar-thin dark:border-white/[0.08] dark:bg-dark-25'
        onClick={e => e.stopPropagation()}
      >
        <div className='mb-4 flex items-center justify-between'>
          <h3
            id='automation-modal-title'
            className='text-lg font-medium tracking-[-0.02em] text-gray-950 dark:text-dark-950'
          >
            {automation
              ? t('automations.editAutomation')
              : t('automations.newAutomation')}
          </h3>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className='rounded-xl p-2 transition-colors hover:bg-gray-100 dark:hover:bg-dark-200'
          >
            <X size={20} className='text-gray-500' />
          </button>
        </div>

        <div className='space-y-4'>
          <div>
            <label htmlFor='automation-name' className={labelClass}>
              {t('automations.form.name')}
            </label>
            <input
              id='automation-name'
              data-testid='automation-name'
              type='text'
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('automations.form.namePlaceholder')}
              className={fieldClass}
              maxLength={200}
              autoFocus
            />
          </div>

          <div>
            <span className={labelClass}>{t('automations.form.triggers')}</span>
            <div className='space-y-2'>
              {triggers.map((trigger, index) => (
                <TriggerEditor
                  key={index}
                  trigger={trigger}
                  onChange={next =>
                    setTriggers(current =>
                      current.map((item, position) =>
                        position === index ? next : item
                      )
                    )
                  }
                  onRemove={
                    triggers.length > 1
                      ? () =>
                          setTriggers(current =>
                            current.filter((_, position) => position !== index)
                          )
                      : undefined
                  }
                />
              ))}
              {triggers.length < 5 && (
                <button
                  type='button'
                  onClick={() =>
                    setTriggers(current => [
                      ...current,
                      { kind: 'daily', hour: 8, minute: 0 },
                    ])
                  }
                  data-testid='automation-add-trigger'
                  className='flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-primary-600 transition-colors hover:bg-primary-500/10 dark:text-primary-400'
                >
                  <Plus className='h-3.5 w-3.5' />
                  {t('automations.form.addTrigger')}
                </button>
              )}
            </div>
          </div>

          <div>
            <label htmlFor='automation-instructions' className={labelClass}>
              {t('automations.form.instructions')}
            </label>
            <textarea
              id='automation-instructions'
              data-testid='automation-instructions'
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              placeholder={t('automations.form.instructionsPlaceholder')}
              rows={5}
              className={fieldClass}
              maxLength={20_000}
            />
          </div>

          {taskBound && (
            <p
              data-testid='automation-task-bound-note'
              className='rounded-lg bg-primary-500/10 px-3 py-2 text-[12px] leading-relaxed text-primary-700 dark:text-primary-300'
            >
              {t('automations.form.taskBoundNote', {
                defaultValue:
                  "This routine runs inside the agent's own workspace and conversation, with the agent's model and runtime.",
              })}
            </p>
          )}

          <div className={cn('grid grid-cols-2 gap-3', taskBound && 'hidden')}>
            <div>
              <label htmlFor='automation-target' className={labelClass}>
                {t('automations.form.target')}
              </label>
              <select
                id='automation-target'
                data-testid='automation-target'
                value={target}
                onChange={e => setTarget(e.target.value as AutomationTarget)}
                className={fieldClass}
              >
                <option value='chat'>{t('automations.form.targetChat')}</option>
                <option value='work'>{t('automations.form.targetWork')}</option>
              </select>
            </div>
            {target === 'work' && policies.length > 0 && (
              <div>
                <label htmlFor='automation-work-policy' className={labelClass}>
                  {t('automations.form.workPolicy')}
                </label>
                <select
                  id='automation-work-policy'
                  data-testid='automation-work-policy'
                  value={workPolicyId}
                  onChange={e => setWorkPolicyId(e.target.value)}
                  className={fieldClass}
                >
                  <option value=''>
                    {t('automations.form.workPolicyDefault')}
                  </option>
                  {policies.map(policy => (
                    <option key={policy.id} value={policy.id}>
                      {policy.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className='grid grid-cols-2 gap-3'>
            <div className={cn(taskBound && 'hidden')}>
              <label htmlFor='automation-model' className={labelClass}>
                {t('automations.form.model')}
              </label>
              <select
                id='automation-model'
                value={model}
                onChange={e => setModel(e.target.value)}
                className={fieldClass}
              >
                <option value=''>{t('automations.form.modelAuto')}</option>
                {models.map(item => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor='automation-notify' className={labelClass}>
                {t('automations.form.notification')}
              </label>
              <select
                id='automation-notify'
                value={notify}
                onChange={e => setNotify(e.target.value as 'app' | 'off')}
                className={fieldClass}
              >
                <option value='app'>{t('automations.form.notifyApp')}</option>
                <option value='off'>{t('automations.form.notifyOff')}</option>
              </select>
            </div>
          </div>

          <div className='flex justify-end gap-3 border-t border-gray-200 pt-4 dark:border-dark-300'>
            <button
              onClick={onClose}
              className='rounded-xl px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-dark-700 dark:hover:bg-dark-200'
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !valid}
              data-testid='automation-save'
              className='rounded-xl bg-gray-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-100'
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
