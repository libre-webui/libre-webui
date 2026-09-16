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
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Mail } from 'lucide-react';
import { Button, Input, Select } from '@/components/ui';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { emailApi } from '@/utils/api';
import type { EmailSettingsResponse, SmtpSecurity } from '@/utils/api/emailApi';

const SECURITY_MODES: SmtpSecurity[] = ['starttls', 'tls', 'none'];

interface Draft {
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  password: string;
  from: string;
  appUrl: string;
  rejectUnauthorized: boolean;
}

const draftFrom = (settings: EmailSettingsResponse): Draft => ({
  host: settings.host ?? '',
  port: settings.port ? String(settings.port) : '',
  security: settings.security ?? 'starttls',
  username: settings.username ?? '',
  password: '',
  from: settings.from ?? '',
  appUrl: settings.appUrl ?? '',
  rejectUnauthorized: settings.rejectUnauthorized !== false,
});

/**
 * Administrator configuration of the outbound mail server. Users only get
 * the per-notification email switches once this is enabled, and every
 * message goes through the server configured here. Environment variables
 * seed the fields; a value saved here takes precedence, and clearing it
 * restores the environment default.
 */
export const EmailNotificationSettings: React.FC = () => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<EmailSettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testRecipient, setTestRecipient] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    emailApi
      .getSettings()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setSettings(response.data);
          setDraft(draftFrom(response.data));
          setTestRecipient(response.data.recipient ?? '');
        } else {
          setLoadFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const applySettings = (next: EmailSettingsResponse) => {
    setSettings(next);
    setDraft(draftFrom(next));
    setClearPassword(false);
  };

  // Non-2xx replies arrive as HttpError; the server's explanation lives in
  // the response body, which is what the administrator needs to see.
  const failureMessage = (error: unknown, fallback: string) => {
    const body = (
      error as { response?: { data?: { error?: string; message?: string } } }
    ).response?.data;
    if (body?.error) return body.error;
    if (body?.message) return body.message;
    return error instanceof Error && error.message ? error.message : fallback;
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await emailApi.updateSettings({
        host: draft.host.trim(),
        port: draft.port.trim(),
        security: draft.security,
        username: draft.username.trim(),
        from: draft.from.trim(),
        appUrl: draft.appUrl.trim(),
        rejectUnauthorized: draft.rejectUnauthorized,
        ...(draft.password
          ? { password: draft.password }
          : clearPassword
            ? { password: '' }
            : {}),
      });
      if (!response.success || !response.data) {
        throw new Error(
          response.error || t('userManager.emailNotifications.saveFailed')
        );
      }
      applySettings(response.data);
      toast.success(t('userManager.emailNotifications.saved'));
    } catch (error) {
      toast.error(
        failureMessage(error, t('userManager.emailNotifications.saveFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    setSaving(true);
    try {
      const response = await emailApi.updateSettings({ enabled });
      if (!response.success || !response.data) {
        throw new Error(
          response.error || t('userManager.emailNotifications.saveFailed')
        );
      }
      applySettings(response.data);
      toast.success(
        enabled
          ? t('userManager.emailNotifications.enabledToast')
          : t('userManager.emailNotifications.disabledToast')
      );
    } catch (error) {
      toast.error(
        failureMessage(error, t('userManager.emailNotifications.saveFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const response = await emailApi.test(testRecipient.trim() || undefined);
      if (!response.success || !response.data?.ok) {
        throw new Error(
          response.error || t('userManager.emailNotifications.testFailed')
        );
      }
      toast.success(
        response.data.sentTo
          ? t('userManager.emailNotifications.testSent', {
              address: response.data.sentTo,
            })
          : t('userManager.emailNotifications.testConnected')
      );
    } catch (error) {
      toast.error(
        failureMessage(error, t('userManager.emailNotifications.testFailed'))
      );
    } finally {
      setTesting(false);
    }
  };

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft(current => (current ? { ...current, [key]: value } : current));

  const sourceHint = (
    key: NonNullable<EmailSettingsResponse['sources']> extends Record<
      infer Key,
      unknown
    >
      ? Key
      : never
  ) =>
    settings?.sources?.[key] === 'env'
      ? t('userManager.emailNotifications.fromEnvironment')
      : null;

  const dirty =
    settings !== null &&
    draft !== null &&
    (JSON.stringify(draftFrom(settings)) !==
      JSON.stringify({ ...draft, password: '' }) ||
      draft.password.length > 0 ||
      clearPassword);

  const fieldLabel =
    'mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100';
  const fieldHint = 'mb-2 block text-xs text-gray-500 dark:text-gray-400';

  return (
    <div
      className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 space-y-4'
      data-testid='email-notification-settings'
    >
      <div className='flex items-start justify-between gap-4'>
        <div>
          <h3 className='flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100'>
            <Mail className='h-4 w-4 text-primary-500' />
            {t('userManager.emailNotifications.title')}
          </h3>
          <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
            {t('userManager.emailNotifications.description')}
          </p>
        </div>
        <div data-testid='email-notifications-enabled'>
          <SettingsToggle
            checked={settings?.enabled === true}
            onChange={checked => void toggleEnabled(checked)}
            disabled={
              saving ||
              settings === null ||
              (!settings.enabled && !settings.configured)
            }
          />
        </div>
      </div>

      {loadFailed && (
        <div className='flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'>
          <span>{t('userManager.emailNotifications.loadFailed')}</span>
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              setLoadFailed(false);
              setLoadAttempt(attempt => attempt + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}

      {draft && (
        <>
          <div className='grid gap-3 sm:grid-cols-[2fr_1fr]'>
            <label className='block'>
              <span className={fieldLabel}>
                {t('userManager.emailNotifications.hostLabel')}
              </span>
              <span className={fieldHint}>
                {sourceHint('host') ??
                  t('userManager.emailNotifications.hostHint')}
              </span>
              <Input
                value={draft.host}
                onChange={event => update('host', event.target.value)}
                placeholder='smtp.example.com'
                spellCheck={false}
                dir='ltr'
                data-testid='email-smtp-host'
              />
            </label>
            <label className='block'>
              <span className={fieldLabel}>
                {t('userManager.emailNotifications.portLabel')}
              </span>
              <span className={fieldHint}>
                {sourceHint('port') ??
                  t('userManager.emailNotifications.portHint')}
              </span>
              <Input
                type='number'
                min={1}
                max={65535}
                value={draft.port}
                onChange={event => update('port', event.target.value)}
                placeholder={draft.security === 'tls' ? '465' : '587'}
                dir='ltr'
                data-testid='email-smtp-port'
              />
            </label>
          </div>

          <div className='grid gap-3 sm:grid-cols-2'>
            <label className='block'>
              <span className={fieldLabel}>
                {t('userManager.emailNotifications.securityLabel')}
              </span>
              <span className={fieldHint}>
                {sourceHint('security') ??
                  t('userManager.emailNotifications.securityHint')}
              </span>
              <Select
                value={draft.security}
                onChange={event =>
                  update('security', event.target.value as SmtpSecurity)
                }
                options={SECURITY_MODES.map(mode => ({
                  value: mode,
                  label: t(`userManager.emailNotifications.security.${mode}`),
                }))}
                data-testid='email-smtp-security'
              />
            </label>
            <div className='flex items-start justify-between gap-4 sm:pt-1'>
              <div>
                <span className={fieldLabel}>
                  {t('userManager.emailNotifications.verifyLabel')}
                </span>
                <span className='block text-xs text-gray-500 dark:text-gray-400'>
                  {t('userManager.emailNotifications.verifyHint')}
                </span>
              </div>
              <SettingsToggle
                checked={draft.rejectUnauthorized}
                onChange={checked => update('rejectUnauthorized', checked)}
                disabled={saving || draft.security === 'none'}
              />
            </div>
          </div>

          <div className='grid gap-3 sm:grid-cols-2'>
            <label className='block'>
              <span className={fieldLabel}>
                {t('userManager.emailNotifications.usernameLabel')}
              </span>
              <span className={fieldHint}>
                {sourceHint('username') ??
                  t('userManager.emailNotifications.usernameHint')}
              </span>
              <Input
                value={draft.username}
                onChange={event => update('username', event.target.value)}
                autoComplete='off'
                spellCheck={false}
                dir='ltr'
                data-testid='email-smtp-username'
              />
            </label>
            <label className='block'>
              <span className={fieldLabel}>
                {t('userManager.emailNotifications.passwordLabel')}
              </span>
              <span className={fieldHint}>
                {sourceHint('password') ??
                  (settings?.passwordConfigured
                    ? t('userManager.emailNotifications.passwordStored')
                    : t('userManager.emailNotifications.passwordHint'))}
              </span>
              <Input
                type='password'
                value={draft.password}
                onChange={event => {
                  update('password', event.target.value);
                  if (event.target.value) setClearPassword(false);
                }}
                autoComplete='new-password'
                placeholder={settings?.passwordConfigured ? '••••••••' : ''}
                dir='ltr'
                data-testid='email-smtp-password'
              />
              {settings?.passwordConfigured &&
                settings.sources?.password === 'stored' &&
                !draft.password && (
                  <label className='mt-2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400'>
                    <input
                      type='checkbox'
                      checked={clearPassword}
                      onChange={event => setClearPassword(event.target.checked)}
                    />
                    {t('userManager.emailNotifications.clearPassword')}
                  </label>
                )}
            </label>
          </div>

          <div className='grid gap-3 sm:grid-cols-2'>
            <label className='block'>
              <span className={fieldLabel}>
                {t('userManager.emailNotifications.fromLabel')}
              </span>
              <span className={fieldHint}>
                {sourceHint('from') ??
                  t('userManager.emailNotifications.fromHint')}
              </span>
              <Input
                value={draft.from}
                onChange={event => update('from', event.target.value)}
                placeholder='Libre WebUI <notifications@example.com>'
                spellCheck={false}
                dir='ltr'
                data-testid='email-smtp-from'
              />
            </label>
            <label className='block'>
              <span className={fieldLabel}>
                {t('userManager.emailNotifications.appUrlLabel')}
              </span>
              <span className={fieldHint}>
                {sourceHint('appUrl') ??
                  t('userManager.emailNotifications.appUrlHint')}
              </span>
              <Input
                value={draft.appUrl}
                onChange={event => update('appUrl', event.target.value)}
                placeholder='https://chat.example.com'
                spellCheck={false}
                dir='ltr'
                data-testid='email-app-url'
              />
            </label>
          </div>

          <div className='flex flex-col gap-3 border-t border-gray-200 dark:border-dark-300 pt-3 sm:flex-row sm:items-end sm:justify-between'>
            <label className='block sm:max-w-xs sm:flex-1'>
              <span className={fieldLabel}>
                {t('userManager.emailNotifications.testRecipientLabel')}
              </span>
              <span className={fieldHint}>
                {t('userManager.emailNotifications.testRecipientHint')}
              </span>
              <Input
                type='email'
                value={testRecipient}
                onChange={event => setTestRecipient(event.target.value)}
                placeholder='you@example.com'
                spellCheck={false}
                dir='ltr'
                data-testid='email-test-recipient'
              />
            </label>
            <div className='flex justify-end gap-2'>
              <Button
                size='sm'
                variant='outline'
                onClick={() => void test()}
                disabled={testing || saving || !settings?.configured || dirty}
                title={
                  dirty
                    ? t('userManager.emailNotifications.saveBeforeTest')
                    : undefined
                }
                data-testid='email-test-button'
              >
                {testing
                  ? t('userManager.emailNotifications.testing')
                  : t('userManager.emailNotifications.test')}
              </Button>
              <Button
                size='sm'
                onClick={() => void save()}
                disabled={saving || !dirty}
                data-testid='email-save-button'
              >
                {saving
                  ? t('userManager.emailNotifications.saving')
                  : t('userManager.emailNotifications.save')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default EmailNotificationSettings;
