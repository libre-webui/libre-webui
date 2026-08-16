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
import { ChevronDown, ChevronRight, RefreshCw, ScrollText } from 'lucide-react';
import { Button, Input, Select } from '@/components/ui';
import { adminSecurityApi } from '@/utils/api';
import type { AuditEvent } from '@/utils/api';

const RESULT_CHIP_CLASSES: Record<string, string> = {
  success:
    'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  denied:
    'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  failure: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
};

/**
 * Administrator view of the security audit log: recent authentication and
 * access events with simple server-side filters.
 */
export const SecurityAuditLog: React.FC = () => {
  const { t } = useTranslation();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [actionFilter, setActionFilter] = useState('');
  const [resultFilter, setResultFilter] = useState('');
  const [limit, setLimit] = useState('50');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const parsedLimit = Number(limit);
      const response = await adminSecurityApi.getAuditEvents({
        action: actionFilter.trim() || undefined,
        result: resultFilter || undefined,
        limit:
          Number.isInteger(parsedLimit) && parsedLimit > 0
            ? parsedLimit
            : undefined,
      });
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to load audit events.');
      }
      setEvents(response.data);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [actionFilter, resultFilter, limit]);

  useEffect(() => {
    // Deferred by a tick so the loader's first setState lands after this
    // commit instead of cascading a second synchronous render.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
    // Only refetch on demand or when filters change via the refresh button;
    // initial mount fetch is enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resultLabel = (result: string): string => {
    switch (result) {
      case 'success':
        return t('userManager.audit.resultSuccess', 'Success');
      case 'denied':
        return t('userManager.audit.resultDenied', 'Denied');
      case 'failure':
        return t('userManager.audit.resultFailure', 'Failure');
      default:
        return result;
    }
  };

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4 className='flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100'>
            <ScrollText className='h-4 w-4 text-primary-500' />
            {t('userManager.audit.title', 'Security audit log')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t(
              'userManager.audit.description',
              'Recent sign-ins, permission checks, and administrative changes on this instance.'
            )}
          </p>
        </div>
        <Button
          size='sm'
          variant='outline'
          onClick={() => void load()}
          disabled={loading}
          className='gap-1.5'
        >
          <RefreshCw
            size={14}
            className={loading ? 'animate-spin' : undefined}
          />
          {t('common.refresh')}
        </Button>
      </div>

      <div className='mt-4 grid gap-3 sm:grid-cols-3'>
        <label className='block'>
          <span className='mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400'>
            {t('userManager.audit.actionFilter', 'Action')}
          </span>
          <Input
            value={actionFilter}
            onChange={event => setActionFilter(event.target.value)}
            placeholder={t(
              'userManager.audit.actionPlaceholder',
              'e.g. auth.login'
            )}
            spellCheck={false}
            dir='ltr'
          />
        </label>
        <label className='block'>
          <span className='mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400'>
            {t('userManager.audit.resultFilter', 'Result')}
          </span>
          <Select
            value={resultFilter}
            onChange={event => setResultFilter(event.target.value)}
            options={[
              { value: '', label: t('common.all') },
              {
                value: 'success',
                label: t('userManager.audit.resultSuccess', 'Success'),
              },
              {
                value: 'denied',
                label: t('userManager.audit.resultDenied', 'Denied'),
              },
              {
                value: 'failure',
                label: t('userManager.audit.resultFailure', 'Failure'),
              },
            ]}
          />
        </label>
        <label className='block'>
          <span className='mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400'>
            {t('userManager.audit.limitFilter', 'Limit')}
          </span>
          <Input
            type='number'
            min={1}
            max={500}
            value={limit}
            onChange={event => setLimit(event.target.value)}
            dir='ltr'
          />
        </label>
      </div>

      <div className='mt-4 space-y-2'>
        {loading ? (
          <p className='text-sm text-gray-500 dark:text-gray-400'>
            {t('common.loading')}
          </p>
        ) : loadFailed ? (
          <div className='flex items-center justify-between gap-4'>
            <p className='text-sm text-gray-500 dark:text-gray-400'>
              {t(
                'userManager.audit.loadFailed',
                'The audit log could not be loaded.'
              )}
            </p>
            <Button size='sm' variant='outline' onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : events.length === 0 ? (
          <p className='text-sm text-gray-500 dark:text-gray-400'>
            {t('userManager.audit.empty', 'No audit events recorded yet.')}
          </p>
        ) : (
          events.map(event => {
            const expanded = expandedId === event.id;
            const hasDetails =
              event.details && Object.keys(event.details).length > 0;
            return (
              <div
                key={event.id}
                className='rounded-lg border border-gray-200 dark:border-dark-300 bg-gray-50 dark:bg-dark-50'
              >
                <button
                  type='button'
                  className='flex w-full items-center gap-3 px-3 py-2 text-start'
                  onClick={() => setExpandedId(expanded ? null : event.id)}
                  aria-expanded={expanded}
                >
                  {hasDetails ? (
                    expanded ? (
                      <ChevronDown className='h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400' />
                    ) : (
                      <ChevronRight className='h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400' />
                    )
                  ) : (
                    <span className='h-4 w-4 shrink-0' />
                  )}
                  <span className='min-w-0 flex-1'>
                    <span className='flex flex-wrap items-center gap-2'>
                      <span className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                        {event.action}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          RESULT_CHIP_CLASSES[event.result] ||
                          'bg-gray-100 dark:bg-dark-200 text-gray-600 dark:text-gray-300'
                        }`}
                      >
                        {resultLabel(event.result)}
                      </span>
                    </span>
                    <span className='mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400'>
                      {new Date(event.occurredAt).toLocaleString()}
                      {' · '}
                      {t('userManager.audit.actor', 'Actor')}:{' '}
                      {event.actorUserId || event.actorKind}
                      {event.targetType && (
                        <>
                          {' · '}
                          {t('userManager.audit.target', 'Target')}:{' '}
                          {event.targetType}
                          {event.targetId ? `/${event.targetId}` : ''}
                        </>
                      )}
                    </span>
                  </span>
                </button>
                {expanded && hasDetails && (
                  <pre
                    dir='ltr'
                    className='mx-3 mb-3 overflow-x-auto rounded-md bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300 p-3 text-xs text-gray-700 dark:text-gray-300'
                  >
                    {JSON.stringify(event.details, null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SecurityAuditLog;
