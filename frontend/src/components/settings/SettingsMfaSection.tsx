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

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import { authApi } from '@/utils/api';
import type { MfaStatusResponse } from '@/utils/api';
import {
  createPasskeyCredential,
  passkeysSupported,
} from '@/utils/webauthnClient';

const apiErrorMessage = (error: unknown): string | undefined =>
  (error as { response?: { data?: { message?: string } } }).response?.data
    ?.message;

const formatDate = (value: number | null): string =>
  value ? new Date(value).toLocaleString() : '—';

/**
 * Account security: TOTP two-factor authentication with one-time recovery
 * codes, and passkeys for passwordless sign-in.
 */
export const SettingsMfaSection: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MfaStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    otpauthUrl: string;
  } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    'disable' | 'regenerate' | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authApi.getMfaStatus();
      if (response.success && response.data) {
        setStatus(response.data);
      }
    } catch {
      // Leave the section collapsed on failure; the tab is still usable.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const handleEnroll = async () => {
    setBusy(true);
    try {
      const response = await authApi.mfaEnroll();
      if (response.success && response.data) {
        setEnrollment(response.data);
        setCode('');
      } else {
        toast.error(response.message || t('auth.mfa.enrollFailed'));
      }
    } catch (error) {
      toast.error(apiErrorMessage(error) || t('auth.mfa.enrollFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    try {
      const response = await authApi.mfaActivate({ code: code.trim() });
      if (response.success && response.data) {
        setEnrollment(null);
        setRecoveryCodes(response.data.recoveryCodes);
        toast.success(t('auth.mfa.enabled'));
        await load();
      } else {
        toast.error(response.message || t('auth.mfa.invalidCode'));
      }
    } catch (error) {
      toast.error(apiErrorMessage(error) || t('auth.mfa.invalidCode'));
    } finally {
      setCode('');
      setBusy(false);
    }
  };

  const handleConfirmedAction = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!code.trim() || !confirmAction) return;
    setBusy(true);
    try {
      if (confirmAction === 'disable') {
        const response = await authApi.mfaDisable({ code: code.trim() });
        if (response.success) {
          toast.success(t('auth.mfa.disabled'));
          setRecoveryCodes(null);
        } else {
          toast.error(response.message || t('auth.mfa.invalidCode'));
        }
      } else {
        const response = await authApi.mfaRegenerateRecoveryCodes({
          code: code.trim(),
        });
        if (response.success && response.data) {
          setRecoveryCodes(response.data.recoveryCodes);
          toast.success(t('auth.mfa.recoveryCodesRegenerated'));
        } else {
          toast.error(response.message || t('auth.mfa.invalidCode'));
        }
      }
      setConfirmAction(null);
      await load();
    } catch (error) {
      toast.error(apiErrorMessage(error) || t('auth.mfa.invalidCode'));
    } finally {
      setCode('');
      setBusy(false);
    }
  };

  const handleAddPasskey = async () => {
    setBusy(true);
    try {
      const optionsResponse = await authApi.passkeyRegisterOptions();
      if (!optionsResponse.success || !optionsResponse.data) {
        toast.error(
          optionsResponse.message || t('auth.passkeys.registerFailed')
        );
        return;
      }
      const credential = await createPasskeyCredential(
        optionsResponse.data.publicKey
      );
      const response = await authApi.passkeyRegister({
        challengeToken: optionsResponse.data.challengeToken,
        credential,
      });
      if (response.success) {
        toast.success(t('auth.passkeys.registered'));
        await load();
      } else {
        toast.error(response.message || t('auth.passkeys.registerFailed'));
      }
    } catch (error) {
      const domError = error as { name?: string };
      if (
        domError.name === 'NotAllowedError' ||
        domError.name === 'AbortError'
      ) {
        return;
      }
      toast.error(apiErrorMessage(error) || t('auth.passkeys.registerFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleDeletePasskey = async (id: string) => {
    setBusy(true);
    try {
      const response = await authApi.deletePasskey(id);
      if (response.success) {
        toast.success(t('auth.passkeys.removed'));
        await load();
      } else {
        toast.error(response.message || t('auth.passkeys.removeFailed'));
      }
    } catch (error) {
      toast.error(apiErrorMessage(error) || t('auth.passkeys.removeFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (loading || !status) return null;

  const codeInputClass =
    'h-9 w-40 rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-primary-500/35';

  return (
    <div className='space-y-6' data-testid='settings-mfa-section'>
      <div>
        <h3 className='flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100'>
          <ShieldCheck className='h-5 w-5 text-primary-500' />
          {t('auth.mfa.sectionTitle')}
        </h3>
        <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
          {t('auth.mfa.sectionDescription')}
        </p>
      </div>

      <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 space-y-4'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div>
            <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
              {t('auth.mfa.totpTitle')}
            </p>
            <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
              {status.totpEnabled
                ? t('auth.mfa.totpEnabledHint', {
                    count: status.recoveryCodesRemaining,
                  })
                : t('auth.mfa.totpDisabledHint')}
            </p>
          </div>
          {status.totpEnabled ? (
            <div className='flex gap-2'>
              <Button
                size='sm'
                variant='outline'
                disabled={busy}
                onClick={() => {
                  setConfirmAction('regenerate');
                  setCode('');
                }}
              >
                {t('auth.mfa.regenerateCodes')}
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={busy}
                onClick={() => {
                  setConfirmAction('disable');
                  setCode('');
                }}
              >
                {t('auth.mfa.disableButton')}
              </Button>
            </div>
          ) : (
            !enrollment && (
              <Button size='sm' disabled={busy} onClick={handleEnroll}>
                {t('auth.mfa.enableButton')}
              </Button>
            )
          )}
        </div>

        {enrollment && (
          <form onSubmit={handleActivate} className='space-y-3'>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              {t('auth.mfa.secretHint')}
            </p>
            <code
              dir='ltr'
              className='block break-all rounded-lg bg-gray-50 dark:bg-dark-200 p-3 font-mono text-sm text-gray-900 dark:text-gray-100'
            >
              {enrollment.secret}
            </code>
            <a
              href={enrollment.otpauthUrl}
              dir='ltr'
              className='inline-block text-xs font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400'
            >
              {t('auth.mfa.openAuthenticator')}
            </a>
            <div className='flex flex-wrap items-center gap-2'>
              <input
                type='text'
                inputMode='numeric'
                autoComplete='one-time-code'
                dir='ltr'
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder={t('auth.mfa.codePlaceholder')}
                className={codeInputClass}
              />
              <Button size='sm' type='submit' disabled={busy || !code.trim()}>
                {t('auth.mfa.activateButton')}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                type='button'
                onClick={() => setEnrollment(null)}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        )}

        {confirmAction && (
          <form
            onSubmit={handleConfirmedAction}
            className='flex flex-wrap items-center gap-2'
          >
            <label className='text-xs text-gray-500 dark:text-gray-400'>
              {t('auth.mfa.confirmWithCode')}
            </label>
            <input
              type='text'
              inputMode='numeric'
              autoComplete='one-time-code'
              dir='ltr'
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder={t('auth.mfa.codePlaceholder')}
              className={codeInputClass}
            />
            <Button size='sm' type='submit' disabled={busy || !code.trim()}>
              {confirmAction === 'disable'
                ? t('auth.mfa.disableButton')
                : t('auth.mfa.regenerateCodes')}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              type='button'
              onClick={() => setConfirmAction(null)}
            >
              {t('common.cancel')}
            </Button>
          </form>
        )}

        {recoveryCodes && (
          <div className='space-y-2'>
            <p className='text-xs font-medium text-gray-900 dark:text-gray-100'>
              {t('auth.mfa.recoveryCodesTitle')}
            </p>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              {t('auth.mfa.recoveryCodesHint')}
            </p>
            <div className='grid grid-cols-2 gap-2 rounded-lg bg-gray-50 dark:bg-dark-200 p-3 font-mono text-sm text-gray-900 dark:text-gray-100'>
              {recoveryCodes.map(recoveryCode => (
                <span key={recoveryCode} dir='ltr'>
                  {recoveryCode}
                </span>
              ))}
            </div>
            <Button
              size='sm'
              variant='outline'
              onClick={() => setRecoveryCodes(null)}
            >
              {t('auth.mfa.recoveryCodesSaved')}
            </Button>
          </div>
        )}
      </div>

      <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 space-y-3'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div>
            <p className='flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100'>
              <KeyRound className='h-4 w-4 text-primary-500' />
              {t('auth.passkeys.sectionTitle')}
            </p>
            <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
              {t('auth.passkeys.sectionDescription')}
            </p>
          </div>
          {passkeysSupported() && (
            <Button size='sm' disabled={busy} onClick={handleAddPasskey}>
              {t('auth.passkeys.addButton')}
            </Button>
          )}
        </div>
        {status.passkeys.length === 0 ? (
          <p className='text-xs text-gray-500 dark:text-gray-400'>
            {t('auth.passkeys.empty')}
          </p>
        ) : (
          <div className='space-y-2'>
            {status.passkeys.map(passkey => (
              <div
                key={passkey.id}
                className='flex items-center justify-between gap-3 rounded-lg bg-gray-50 dark:bg-dark-200 px-3 py-2'
              >
                <div className='min-w-0'>
                  <p className='truncate text-sm text-gray-900 dark:text-gray-100'>
                    {passkey.name || t('auth.passkeys.unnamed')}
                  </p>
                  <p className='text-xs text-gray-500 dark:text-gray-400'>
                    {t('auth.passkeys.createdAt')}:{' '}
                    {formatDate(passkey.createdAt)}
                    {' · '}
                    {t('auth.passkeys.lastUsedAt')}:{' '}
                    {formatDate(passkey.lastUsedAt)}
                  </p>
                </div>
                <Button
                  size='sm'
                  variant='ghost'
                  disabled={busy}
                  onClick={() => void handleDeletePasskey(passkey.id)}
                  aria-label={t('auth.passkeys.removeButton')}
                >
                  <Trash2 className='h-4 w-4' />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsMfaSection;
