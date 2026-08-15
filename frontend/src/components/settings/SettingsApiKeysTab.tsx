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
import { Copy, KeyRound } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { useAuthStore } from '@/store/authStore';
import { authApi, API_TOKEN_SCOPES } from '@/utils/api';
import type { ApiTokenRecord } from '@/utils/api';

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleString() : '—';

/**
 * Personal API tokens with scoped permissions. The plaintext token is shown
 * exactly once after creation; only the prefix is stored for display.
 */
export const SettingsApiKeysTab: React.FC = () => {
  const { t } = useTranslation();
  const isAdmin = useAuthStore(state => state.isAdmin)();
  const [tokens, setTokens] = useState<ApiTokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const availableScopes = API_TOKEN_SCOPES.filter(
    scope => scope !== 'admin' || isAdmin
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const response = await authApi.listApiTokens();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to load API keys.');
      }
      setTokens(response.data);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleScope = (scope: string) => {
    setScopes(previous =>
      previous.includes(scope)
        ? previous.filter(entry => entry !== scope)
        : [...previous, scope]
    );
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      toast.error(t('settings.apiKeys.nameRequired', 'Give the key a name.'));
      return;
    }
    if (scopes.length === 0) {
      toast.error(
        t('settings.apiKeys.scopesRequired', 'Select at least one scope.')
      );
      return;
    }
    let expiry: number | undefined;
    if (expiresInDays.trim()) {
      const parsed = Number(expiresInDays);
      if (!Number.isInteger(parsed) || parsed < 1) {
        toast.error(
          t(
            'settings.apiKeys.expiryInvalid',
            'Expiry must be a whole number of days.'
          )
        );
        return;
      }
      expiry = parsed;
    }
    setCreating(true);
    try {
      const response = await authApi.createApiToken({
        name: name.trim(),
        scopes,
        expiresInDays: expiry,
      });
      if (!response.success || !response.data) {
        throw new Error(response.error || 'API key creation failed.');
      }
      setCreatedToken(response.data.token);
      setName('');
      setScopes([]);
      setExpiresInDays('');
      toast.success(t('settings.apiKeys.created', 'API key created.'));
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(
              'settings.apiKeys.createFailed',
              'The API key could not be created.'
            )
      );
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      toast.success(t('settings.apiKeys.copied', 'Copied to clipboard.'));
    } catch {
      toast.error(t('settings.apiKeys.copyFailed', 'Copy failed.'));
    }
  };

  const handleRevoke = async (token: ApiTokenRecord) => {
    setRevokingId(token.id);
    try {
      const response = await authApi.revokeApiToken(token.id);
      if (!response.success) {
        throw new Error(response.error || 'API key revoke failed.');
      }
      toast.success(t('settings.apiKeys.revoked', 'API key revoked.'));
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(
              'settings.apiKeys.revokeFailed',
              'The API key could not be revoked.'
            )
      );
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100'>
          <KeyRound className='h-5 w-5 text-primary-500' />
          {t('settings.apiKeys.title', 'API keys')}
        </h3>
        <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
          {t(
            'settings.apiKeys.description',
            'Scoped tokens for scripts and integrations. Each key only has access to the scopes you pick.'
          )}
        </p>
      </div>

      {createdToken && (
        <div className='rounded-lg border border-primary-500/40 bg-primary-50 dark:bg-primary-900/20 p-4 space-y-2'>
          <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('settings.apiKeys.newKeyTitle', 'Your new API key')}
          </p>
          <div className='flex items-center gap-2'>
            <code
              dir='ltr'
              className='min-w-0 flex-1 overflow-x-auto rounded-md bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300 px-3 py-2 text-xs text-gray-900 dark:text-gray-100'
              data-testid='new-api-key'
            >
              {createdToken}
            </code>
            <Button
              size='sm'
              variant='outline'
              onClick={() => void handleCopy()}
              className='shrink-0 gap-1.5'
            >
              <Copy size={14} />
              {t('settings.apiKeys.copy', 'Copy')}
            </Button>
          </div>
          <p className='text-xs text-warning-700 dark:text-warning-400'>
            {t(
              'settings.apiKeys.showOnceWarning',
              'Copy it now — it will not be shown again.'
            )}
          </p>
          <div className='flex justify-end'>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => setCreatedToken(null)}
            >
              {t('settings.apiKeys.dismiss', 'Done')}
            </Button>
          </div>
        </div>
      )}

      <form
        onSubmit={handleCreate}
        className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 space-y-3'
      >
        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
          {t('settings.apiKeys.createTitle', 'Create a key')}
        </h4>
        <div className='grid gap-3 sm:grid-cols-2'>
          <label className='block'>
            <span className='mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100'>
              {t('settings.apiKeys.nameLabel', 'Name')}
            </span>
            <Input
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={t(
                'settings.apiKeys.namePlaceholder',
                'e.g. CI pipeline'
              )}
            />
          </label>
          <label className='block'>
            <span className='mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100'>
              {t('settings.apiKeys.expiryLabel', 'Expires in days (optional)')}
            </span>
            <Input
              type='number'
              min={1}
              value={expiresInDays}
              onChange={event => setExpiresInDays(event.target.value)}
              placeholder={t('settings.apiKeys.expiryPlaceholder', 'Never')}
              dir='ltr'
            />
          </label>
        </div>
        <div>
          <span className='mb-2 block text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('settings.apiKeys.scopesLabel', 'Scopes')}
          </span>
          <div className='flex flex-wrap gap-x-4 gap-y-2'>
            {availableScopes.map(scope => (
              <label
                key={scope}
                className='flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100'
              >
                <input
                  type='checkbox'
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  className='h-4 w-4 rounded border-gray-300 dark:border-dark-300 text-primary-600 focus:ring-primary-500'
                />
                {scope}
              </label>
            ))}
          </div>
        </div>
        <div className='flex justify-end'>
          <Button size='sm' type='submit' disabled={creating}>
            {creating
              ? t('settings.apiKeys.creating', 'Creating…')
              : t('settings.apiKeys.create', 'Create key')}
          </Button>
        </div>
      </form>

      {loading ? (
        <p className='text-sm text-gray-500 dark:text-gray-400'>
          {t('common.loading')}
        </p>
      ) : loadFailed ? (
        <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 flex items-center justify-between gap-4'>
          <p className='text-sm text-gray-500 dark:text-gray-400'>
            {t(
              'settings.apiKeys.loadFailed',
              'The API keys could not be loaded.'
            )}
          </p>
          <Button size='sm' variant='outline' onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : tokens.length === 0 ? (
        <p className='text-sm text-gray-500 dark:text-gray-400'>
          {t('settings.apiKeys.empty', 'No API keys yet.')}
        </p>
      ) : (
        <div className='space-y-3'>
          {tokens.map(token => (
            <div
              key={token.id}
              className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'
            >
              <div className='min-w-0'>
                <div className='flex flex-wrap items-center gap-2'>
                  <span className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                    {token.name}
                  </span>
                  <code
                    dir='ltr'
                    className='rounded bg-gray-100 dark:bg-dark-200 px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300'
                  >
                    {token.tokenPrefix}…
                  </code>
                  {token.revokedAt && (
                    <span className='rounded-full bg-gray-100 dark:bg-dark-200 px-2 py-0.5 text-xs font-medium text-gray-500 dark:text-gray-400'>
                      {t('settings.apiKeys.revokedBadge', 'Revoked')}
                    </span>
                  )}
                </div>
                <div className='mt-1.5 flex flex-wrap gap-1'>
                  {token.scopes.map(scope => (
                    <span
                      key={scope}
                      className='rounded-full bg-primary-100 dark:bg-primary-900/30 px-2 py-0.5 text-xs text-primary-700 dark:text-primary-300'
                    >
                      {scope}
                    </span>
                  ))}
                </div>
                <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
                  {t('settings.apiKeys.createdAt', 'Created')}:{' '}
                  {formatDate(token.createdAt)}
                  {' · '}
                  {t('settings.apiKeys.lastUsedAt', 'Last used')}:{' '}
                  {formatDate(token.lastUsedAt)}
                  {' · '}
                  {t('settings.apiKeys.expiresAt', 'Expires')}:{' '}
                  {token.expiresAt
                    ? formatDate(token.expiresAt)
                    : t('settings.apiKeys.neverExpires', 'Never')}
                </p>
              </div>
              {!token.revokedAt && (
                <div className='shrink-0'>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void handleRevoke(token)}
                    disabled={revokingId === token.id}
                  >
                    {revokingId === token.id
                      ? t('settings.apiKeys.revoking', 'Revoking…')
                      : t('settings.apiKeys.revoke', 'Revoke')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SettingsApiKeysTab;
