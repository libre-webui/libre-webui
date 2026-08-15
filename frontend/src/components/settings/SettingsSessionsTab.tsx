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
import { MonitorSmartphone } from 'lucide-react';
import { Button } from '@/components/ui';
import { authApi } from '@/utils/api';
import type { AuthSession } from '@/utils/api';

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleString() : '—';

/**
 * Where the account is signed in. Lists every active session and lets the
 * user revoke individual ones or everything except the current session.
 * Revoking is reversible by signing in again, so no confirmation step.
 */
export const SettingsSessionsTab: React.FC = () => {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const response = await authApi.getSessions();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to load sessions.');
      }
      setSessions(response.data);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevoke = async (session: AuthSession) => {
    setRevokingId(session.id);
    try {
      const response = await authApi.revokeSession(session.id);
      if (!response.success) {
        throw new Error(response.error || 'Session revoke failed.');
      }
      toast.success(t('settings.sessions.revoked', 'Session signed out.'));
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(
              'settings.sessions.revokeFailed',
              'The session could not be signed out.'
            )
      );
    } finally {
      setRevokingId(null);
    }
  };

  const handleRevokeOthers = async () => {
    setRevokingOthers(true);
    try {
      const response = await authApi.revokeOtherSessions();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Session revoke failed.');
      }
      toast.success(
        t('settings.sessions.othersRevoked', {
          count: response.data.revokedCount,
          defaultValue: 'Other sessions signed out: {{count}}',
        })
      );
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(
              'settings.sessions.revokeFailed',
              'The session could not be signed out.'
            )
      );
    } finally {
      setRevokingOthers(false);
    }
  };

  const otherActiveSessions = sessions.filter(
    session => !session.current && !session.revokedAt
  );

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100'>
          <MonitorSmartphone className='h-5 w-5 text-primary-500' />
          {t('settings.sessions.title', 'Sessions')}
        </h3>
        <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
          {t(
            'settings.sessions.description',
            'Everywhere this account is signed in. Signing a session out takes effect immediately; signing in again restores access.'
          )}
        </p>
      </div>

      <div className='flex justify-end'>
        <Button
          size='sm'
          variant='outline'
          onClick={() => void handleRevokeOthers()}
          disabled={
            revokingOthers || loading || otherActiveSessions.length === 0
          }
        >
          {revokingOthers
            ? t('settings.sessions.signingOutOthers', 'Signing out…')
            : t('settings.sessions.signOutOthers', 'Sign out other sessions')}
        </Button>
      </div>

      {loading ? (
        <p className='text-sm text-gray-500 dark:text-gray-400'>
          {t('common.loading')}
        </p>
      ) : loadFailed ? (
        <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 flex items-center justify-between gap-4'>
          <p className='text-sm text-gray-500 dark:text-gray-400'>
            {t(
              'settings.sessions.loadFailed',
              'The sessions could not be loaded.'
            )}
          </p>
          <Button size='sm' variant='outline' onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : sessions.length === 0 ? (
        <p className='text-sm text-gray-500 dark:text-gray-400'>
          {t('settings.sessions.empty', 'No sessions found.')}
        </p>
      ) : (
        <div className='space-y-3'>
          {sessions.map(session => (
            <div
              key={session.id}
              className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'
            >
              <div className='min-w-0'>
                <div className='flex flex-wrap items-center gap-2'>
                  <span className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                    {session.kind}
                  </span>
                  {session.current && (
                    <span className='rounded-full bg-primary-100 dark:bg-primary-900/30 px-2 py-0.5 text-xs font-medium text-primary-700 dark:text-primary-300'>
                      {t('settings.sessions.current', 'This session')}
                    </span>
                  )}
                  {session.revokedAt && (
                    <span className='rounded-full bg-gray-100 dark:bg-dark-200 px-2 py-0.5 text-xs font-medium text-gray-500 dark:text-gray-400'>
                      {t('settings.sessions.revokedBadge', 'Signed out')}
                    </span>
                  )}
                </div>
                <p className='mt-1 truncate text-xs text-gray-500 dark:text-gray-400'>
                  {session.userAgent ||
                    t('settings.sessions.unknownDevice', 'Unknown device')}
                </p>
                <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
                  {t('settings.sessions.createdAt', 'Signed in')}:{' '}
                  {formatDate(session.createdAt)}
                  {' · '}
                  {t('settings.sessions.lastSeenAt', 'Last active')}:{' '}
                  {formatDate(session.lastSeenAt)}
                  {session.expiresAt && (
                    <>
                      {' · '}
                      {t('settings.sessions.expiresAt', 'Expires')}:{' '}
                      {formatDate(session.expiresAt)}
                    </>
                  )}
                </p>
              </div>
              {!session.current && !session.revokedAt && (
                <div className='shrink-0'>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void handleRevoke(session)}
                    disabled={revokingId === session.id || revokingOthers}
                  >
                    {revokingId === session.id
                      ? t('settings.sessions.signingOut', 'Signing out…')
                      : t('settings.sessions.signOut', 'Sign out')}
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

export default SettingsSessionsTab;
