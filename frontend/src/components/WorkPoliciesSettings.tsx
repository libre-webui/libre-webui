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
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import type { WorkPolicy, WorkPolicyInput } from '@/types/work';
import { workApi } from '@/utils/api/workApi';

interface PolicyFormState {
  name: string;
  image: string;
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: string;
  workspaceSize: string;
  idleMinutes: string;
  networkDefault: 'inherit' | 'on' | 'off';
  guiEnabled: boolean;
}

const emptyForm: PolicyFormState = {
  name: '',
  image: '',
  memoryLimit: '',
  cpuLimit: '',
  pidsLimit: '',
  workspaceSize: '',
  idleMinutes: '',
  networkDefault: 'inherit',
  guiEnabled: false,
};

const formFromPolicy = (policy: WorkPolicy): PolicyFormState => ({
  name: policy.name,
  guiEnabled: policy.guiEnabled === true,
  image: policy.image ?? '',
  memoryLimit: policy.memoryLimit ?? '',
  cpuLimit: policy.cpuLimit ?? '',
  pidsLimit: policy.pidsLimit === undefined ? '' : String(policy.pidsLimit),
  workspaceSize: policy.workspaceSize ?? '',
  // Exact minutes, fractional if needed: rounding here would silently
  // rewrite a sub-minute timeout on the next save.
  idleMinutes:
    policy.idleTimeoutMs === undefined
      ? ''
      : String(policy.idleTimeoutMs / 60_000),
  networkDefault:
    policy.networkDefault === undefined
      ? 'inherit'
      : policy.networkDefault
        ? 'on'
        : 'off',
});

// A non-numeric PID limit or idle stop would serialize NaN as JSON null,
// which the backend reads as "clear this field" — a typo would silently
// remove the limit. Refuse to submit instead.
const invalidNumericInput = (form: PolicyFormState): boolean =>
  [form.pidsLimit, form.idleMinutes].some(
    raw => raw.trim() !== '' && !Number.isFinite(Number(raw))
  );

const inputFromForm = (form: PolicyFormState): WorkPolicyInput => ({
  name: form.name.trim(),
  image: form.image.trim() || null,
  memoryLimit: form.memoryLimit.trim() || null,
  cpuLimit: form.cpuLimit.trim() || null,
  pidsLimit: form.pidsLimit.trim() ? Number(form.pidsLimit) : null,
  workspaceSize: form.workspaceSize.trim() || null,
  idleTimeoutMs: form.idleMinutes.trim()
    ? Math.round(Number(form.idleMinutes) * 60_000)
    : null,
  networkDefault:
    form.networkDefault === 'inherit' ? null : form.networkDefault === 'on',
  guiEnabled: form.guiEnabled ? true : null,
});

/**
 * Admin management of named Work runtime policies. Every field except the
 * name is optional and inherits the deployment's global runtime defaults.
 */
export const WorkPoliciesSettings: React.FC = () => {
  const { t } = useTranslation();
  const [policies, setPolicies] = useState<WorkPolicy[]>([]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<PolicyFormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    try {
      const response = await workApi.listPolicies();
      if (response.success && response.data) setPolicies(response.data);
    } catch {
      // The card stays usable with a stale list; mutations surface errors.
    }
  };

  useEffect(() => {
    let cancelled = false;
    workApi
      .listPolicies()
      .then(response => {
        if (!cancelled && response.success && response.data) {
          setPolicies(response.data);
        }
      })
      .catch(() => {
        // The card stays usable with a stale list; mutations surface errors.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  type TextFieldKey = Exclude<keyof PolicyFormState, 'guiEnabled'>;
  const field = (key: TextFieldKey) => ({
    value: form[key],
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
    ) => setForm(current => ({ ...current, [key]: event.target.value })),
  });

  const submit = async () => {
    if (invalidNumericInput(form)) {
      toast.error(t('userManager.workPolicies.invalidNumber'));
      return;
    }
    setSaving(true);
    try {
      const input = inputFromForm(form);
      const response =
        editing === 'new'
          ? await workApi.createPolicy(input)
          : await workApi.updatePolicy(editing as string, input);
      if (!response.success) {
        throw new Error(response.error || 'Policy save failed.');
      }
      toast.success(t('userManager.workPolicies.saved'));
      setEditing(null);
      setForm(emptyForm);
      await reload();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('userManager.workPolicies.failed')
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (policy: WorkPolicy) => {
    if (!window.confirm(t('userManager.workPolicies.deleteConfirm'))) return;
    try {
      const response = await workApi.deletePolicy(policy.id);
      if (!response.success) {
        throw new Error(response.error || 'Policy delete failed.');
      }
      toast.success(t('userManager.workPolicies.deleted'));
      await reload();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('userManager.workPolicies.failed')
      );
    }
  };

  const textField = (key: TextFieldKey, label: string, placeholder: string) => (
    <label className='block text-xs'>
      <span className='mb-1 block font-medium text-gray-700 dark:text-gray-300'>
        {label}
      </span>
      <input
        {...field(key)}
        placeholder={placeholder}
        spellCheck={false}
        className='w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-900 outline-none focus:border-primary-500 dark:border-dark-300 dark:bg-dark-50 dark:text-gray-100'
      />
    </label>
  );

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.workPolicies.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.workPolicies.description')}
          </p>
        </div>
        {editing === null && (
          <Button
            size='sm'
            variant='outline'
            className='shrink-0 whitespace-nowrap'
            onClick={() => {
              setForm(emptyForm);
              setEditing('new');
            }}
          >
            <Plus size={14} className='shrink-0' />
            <span className='ms-1.5'>{t('userManager.workPolicies.add')}</span>
          </Button>
        )}
      </div>

      {policies.length === 0 && editing === null && (
        <p className='mt-3 text-xs text-gray-500 dark:text-gray-400'>
          {t('userManager.workPolicies.empty')}
        </p>
      )}

      {policies.length > 0 && (
        <ul className='mt-3 divide-y divide-gray-100 dark:divide-dark-300'>
          {policies.map(policy => (
            <li
              key={policy.id}
              className='flex items-center justify-between gap-3 py-2'
            >
              <div className='min-w-0'>
                <div className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                  {policy.name}
                </div>
                <div className='mt-0.5 truncate font-mono text-[11px] text-gray-500 dark:text-gray-400'>
                  {[
                    policy.memoryLimit,
                    policy.cpuLimit && `cpu ${policy.cpuLimit}`,
                    policy.pidsLimit && `pids ${policy.pidsLimit}`,
                    policy.workspaceSize,
                    policy.idleTimeoutMs !== undefined &&
                      `idle ${Math.round(policy.idleTimeoutMs / 60_000)}m`,
                    policy.networkDefault !== undefined &&
                      `net ${policy.networkDefault ? 'on' : 'off'}`,
                    policy.image,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </div>
              </div>
              <div className='flex shrink-0 items-center gap-1'>
                <Button
                  size='sm'
                  variant='ghost'
                  aria-label={t('userManager.workPolicies.edit')}
                  onClick={() => {
                    setForm(formFromPolicy(policy));
                    setEditing(policy.id);
                  }}
                >
                  <Pencil size={14} />
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  aria-label={t('userManager.workPolicies.delete')}
                  onClick={() => void remove(policy)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing !== null && (
        <div className='mt-4 rounded-lg border border-gray-200 p-3 dark:border-dark-300'>
          <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
            {textField('name', t('userManager.workPolicies.name'), 'heavy')}
            {textField(
              'memoryLimit',
              t('userManager.workPolicies.memory'),
              '4g'
            )}
            {textField('cpuLimit', t('userManager.workPolicies.cpu'), '4')}
            {textField('pidsLimit', t('userManager.workPolicies.pids'), '512')}
            {textField(
              'workspaceSize',
              t('userManager.workPolicies.workspaceSize'),
              '20Gi'
            )}
            {textField(
              'idleMinutes',
              t('userManager.workPolicies.idleMinutes'),
              '30'
            )}
            <label className='block text-xs'>
              <span className='mb-1 block font-medium text-gray-700 dark:text-gray-300'>
                {t('userManager.workPolicies.networkDefault')}
              </span>
              <select
                {...field('networkDefault')}
                className='w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-900 outline-none focus:border-primary-500 dark:border-dark-300 dark:bg-dark-50 dark:text-gray-100'
              >
                <option value='inherit'>
                  {t('userManager.workPolicies.networkInherit')}
                </option>
                <option value='on'>
                  {t('userManager.workPolicies.networkOn')}
                </option>
                <option value='off'>
                  {t('userManager.workPolicies.networkOff')}
                </option>
              </select>
            </label>
            <label className='flex items-center gap-2 text-xs'>
              <input
                type='checkbox'
                data-testid='work-policy-gui'
                checked={form.guiEnabled}
                onChange={event =>
                  setForm(current => ({
                    ...current,
                    guiEnabled: event.target.checked,
                  }))
                }
                className='h-3.5 w-3.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500'
              />
              <span className='font-medium text-gray-700 dark:text-gray-300'>
                {t('userManager.workPolicies.guiEnabled')}
              </span>
            </label>
            {textField(
              'image',
              t('userManager.workPolicies.image'),
              'node:22-bookworm@sha256:…'
            )}
          </div>
          <div className='mt-3 flex justify-end gap-2'>
            <Button
              size='sm'
              variant='ghost'
              disabled={saving}
              onClick={() => {
                setEditing(null);
                setForm(emptyForm);
              }}
            >
              {t('userManager.workPolicies.cancel')}
            </Button>
            <Button
              size='sm'
              disabled={saving || !form.name.trim()}
              onClick={() => void submit()}
            >
              {t('userManager.workPolicies.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkPoliciesSettings;
