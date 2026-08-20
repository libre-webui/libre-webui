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

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ModalShell,
  Switch,
  modalFieldClass,
  modalLabelClass,
} from '@/components/ui';
import type {
  ToolServerAccessMode,
  ToolServerAuthMode,
  ToolServerInput,
  ToolServerKind,
  ToolServerView,
} from '@/utils/api/toolsApi';

const KINDS: ToolServerKind[] = ['openapi', 'mcp'];
const AUTH_MODES: ToolServerAuthMode[] = ['none', 'bearer', 'header'];
const ACCESS_MODES: ToolServerAccessMode[] = [
  'admins-only',
  'all-users',
  'granted',
];

interface ToolServerFormModalProps {
  open: boolean;
  /** Null registers a new server; a server switches the form to edit mode. */
  server: ToolServerView | null;
  /** Starter values for a new registration; ignored in edit mode. */
  prefill?: ToolServerInput | null;
  saving: boolean;
  onClose: () => void;
  onSave: (payload: ToolServerInput | Partial<ToolServerInput>) => void;
}

export function ToolServerFormModal({
  open,
  server,
  prefill = null,
  saving,
  onClose,
  onSave,
}: ToolServerFormModalProps) {
  if (!open) return null;
  return (
    <ToolServerForm
      key={server?.id ?? (prefill ? `template-${prefill.name}` : 'new')}
      server={server}
      prefill={prefill}
      saving={saving}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

// The guard above remounts this form per target so its state initializes
// directly from props.
function ToolServerForm({
  server,
  prefill,
  saving,
  onClose,
  onSave,
}: Omit<ToolServerFormModalProps, 'open'>) {
  const { t } = useTranslation();
  const editing = server !== null;
  const seed = server ?? prefill;
  const [name, setName] = useState(seed?.name ?? '');
  const [description, setDescription] = useState(seed?.description ?? '');
  const [kind, setKind] = useState<ToolServerKind>(seed?.kind ?? 'openapi');
  const [baseUrl, setBaseUrl] = useState(seed?.baseUrl ?? '');
  const [specUrl, setSpecUrl] = useState(prefill?.specUrl ?? '');
  const [authMode, setAuthMode] = useState<ToolServerAuthMode>(
    seed?.authMode ?? 'none'
  );
  const [authHeader, setAuthHeader] = useState(seed?.authHeader ?? '');
  const [accessMode, setAccessMode] = useState<ToolServerAccessMode>(
    seed?.accessMode ?? 'admins-only'
  );
  const [enabled, setEnabled] = useState(seed?.enabled ?? true);
  const [timeoutMs, setTimeoutMs] = useState(
    server?.timeoutMs ? String(server.timeoutMs) : ''
  );
  const [maxResponseBytes, setMaxResponseBytes] = useState(
    server?.maxResponseBytes ? String(server.maxResponseBytes) : ''
  );

  const valid =
    name.trim().length > 0 &&
    (editing || baseUrl.trim().length > 0) &&
    (authMode !== 'header' || authHeader.trim().length > 0);

  const numberOrUndefined = (value: string): number | undefined => {
    const parsed = Number(value);
    return value.trim() && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : undefined;
  };

  const handleSave = () => {
    if (!valid) return;
    const shared = {
      name: name.trim(),
      description: description.trim() || undefined,
      authMode,
      authHeader: authMode === 'header' ? authHeader.trim() : undefined,
      accessMode,
      enabled,
      timeoutMs: numberOrUndefined(timeoutMs),
      maxResponseBytes: numberOrUndefined(maxResponseBytes),
    };
    if (editing) {
      onSave(shared);
      return;
    }
    onSave({
      ...shared,
      kind,
      baseUrl: baseUrl.trim(),
      specUrl:
        kind === 'openapi' && specUrl.trim() ? specUrl.trim() : undefined,
    });
  };

  return (
    <ModalShell
      titleId='tool-server-modal-title'
      title={
        editing ? t('toolsPage.editServer') : t('toolsPage.registerServer')
      }
      subtitle={editing ? undefined : t('toolsPage.registerHint')}
      onClose={onClose}
      widthClassName='max-w-2xl'
      testId='tool-server-modal'
      footer={
        <>
          <Button variant='ghost' size='sm' onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size='sm'
            onClick={handleSave}
            disabled={saving || !valid}
            data-testid='tool-server-save'
          >
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className='grid gap-3 sm:grid-cols-2'>
        <div>
          <label htmlFor='tool-server-name' className={modalLabelClass}>
            {t('toolsPage.form.name')}
          </label>
          <input
            id='tool-server-name'
            data-testid='tool-server-name'
            type='text'
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder={t('toolsPage.form.namePlaceholder')}
            className={modalFieldClass}
            maxLength={200}
            autoFocus
          />
        </div>
        <div>
          <label htmlFor='tool-server-kind' className={modalLabelClass}>
            {t('toolsPage.form.kind')}
          </label>
          <select
            id='tool-server-kind'
            value={kind}
            disabled={editing}
            onChange={event => setKind(event.target.value as ToolServerKind)}
            className={modalFieldClass}
          >
            {KINDS.map(option => (
              <option key={option} value={option}>
                {t(`toolsPage.kinds.${option}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor='tool-server-description' className={modalLabelClass}>
          {t('toolsPage.form.description')}
        </label>
        <input
          id='tool-server-description'
          type='text'
          value={description}
          onChange={event => setDescription(event.target.value)}
          placeholder={t('toolsPage.form.descriptionPlaceholder')}
          className={modalFieldClass}
          maxLength={500}
        />
      </div>

      {!editing && (
        <div className='grid gap-3 sm:grid-cols-2'>
          <div>
            <label htmlFor='tool-server-base-url' className={modalLabelClass}>
              {t('toolsPage.form.baseUrl')}
            </label>
            <input
              id='tool-server-base-url'
              data-testid='tool-server-base-url'
              type='url'
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
              placeholder='https://api.example.com'
              className={modalFieldClass}
            />
          </div>
          {kind === 'openapi' && (
            <div>
              <label htmlFor='tool-server-spec-url' className={modalLabelClass}>
                {t('toolsPage.form.specUrl')}
              </label>
              <input
                id='tool-server-spec-url'
                type='url'
                value={specUrl}
                onChange={event => setSpecUrl(event.target.value)}
                placeholder='https://api.example.com/openapi.json'
                className={modalFieldClass}
              />
              <p className='mt-1 text-[11px] text-gray-400 dark:text-dark-500'>
                {t('toolsPage.form.specUrlHint')}
              </p>
            </div>
          )}
        </div>
      )}

      <div className='grid gap-3 sm:grid-cols-2'>
        <div>
          <label htmlFor='tool-server-auth-mode' className={modalLabelClass}>
            {t('toolsPage.form.authMode')}
          </label>
          <select
            id='tool-server-auth-mode'
            value={authMode}
            onChange={event =>
              setAuthMode(event.target.value as ToolServerAuthMode)
            }
            className={modalFieldClass}
          >
            {AUTH_MODES.map(option => (
              <option key={option} value={option}>
                {t(`toolsPage.authModes.${option}`)}
              </option>
            ))}
          </select>
        </div>
        {authMode === 'header' && (
          <div>
            <label
              htmlFor='tool-server-auth-header'
              className={modalLabelClass}
            >
              {t('toolsPage.form.authHeader')}
            </label>
            <input
              id='tool-server-auth-header'
              type='text'
              value={authHeader}
              onChange={event => setAuthHeader(event.target.value)}
              placeholder='X-Api-Key'
              className={modalFieldClass}
              maxLength={120}
            />
          </div>
        )}
      </div>

      <div>
        <label htmlFor='tool-server-access-mode' className={modalLabelClass}>
          {t('toolsPage.form.accessMode')}
        </label>
        <select
          id='tool-server-access-mode'
          value={accessMode}
          onChange={event =>
            setAccessMode(event.target.value as ToolServerAccessMode)
          }
          className={modalFieldClass}
        >
          {ACCESS_MODES.map(option => (
            <option key={option} value={option}>
              {t(`toolsPage.accessModes.${option}`)}
            </option>
          ))}
        </select>
      </div>

      <div className='grid gap-3 sm:grid-cols-2'>
        <div>
          <label htmlFor='tool-server-timeout' className={modalLabelClass}>
            {t('toolsPage.form.timeoutMs')}
          </label>
          <input
            id='tool-server-timeout'
            type='number'
            min={1}
            value={timeoutMs}
            onChange={event => setTimeoutMs(event.target.value)}
            placeholder={t('toolsPage.form.serverDefault')}
            className={modalFieldClass}
          />
        </div>
        <div>
          <label htmlFor='tool-server-max-bytes' className={modalLabelClass}>
            {t('toolsPage.form.maxResponseBytes')}
          </label>
          <input
            id='tool-server-max-bytes'
            type='number'
            min={1}
            value={maxResponseBytes}
            onChange={event => setMaxResponseBytes(event.target.value)}
            placeholder={t('toolsPage.form.serverDefault')}
            className={modalFieldClass}
          />
        </div>
      </div>

      <div className='flex items-center justify-between gap-4 rounded-xl border border-black/[0.06] px-3 py-2.5 dark:border-white/[0.07]'>
        <div>
          <p className='text-[13px] font-medium text-gray-900 dark:text-dark-900'>
            {t('toolsPage.form.enabled')}
          </p>
          <p className='text-[11px] text-gray-400 dark:text-dark-500'>
            {t('toolsPage.form.enabledHint')}
          </p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>
    </ModalShell>
  );
}
