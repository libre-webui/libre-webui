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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Bell, Check, CheckCheck, Loader2, X } from 'lucide-react';
import { notificationsApi } from '@/utils/api';
import { streamTeamEvents } from '@/utils/api/teamEventStream';
import { cn, formatTimestamp } from '@/utils';
import { createLogger } from '@/utils/logger';
import type { AppNotification } from '@/types';

const logger = createLogger('notification-bell');

interface NotificationBellProps {
  sidebarCompact: boolean;
}

/**
 * The durable notification inbox: an unread badge fed by the live
 * per-user stream (with a polling fallback) and a panel listing the
 * newest notifications with read/dismiss controls.
 */
export const NotificationBell: React.FC<NotificationBellProps> = ({
  sidebarCompact,
}) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refreshUnread = useCallback(() => {
    notificationsApi
      .unreadCount()
      .then(response => {
        if (response.success && response.data) setUnread(response.data.count);
      })
      .catch(error => logger.debug('Unread poll failed:', error));
  }, []);

  useEffect(() => {
    refreshUnread();
    const interval = window.setInterval(refreshUnread, 60_000);
    const abort = new AbortController();
    void streamTeamEvents({
      path: '/notifications/events',
      signal: abort.signal,
      onEvent: () => refreshUnread(),
    });
    return () => {
      window.clearInterval(interval);
      abort.abort();
    };
  }, [refreshUnread]);

  const openPanel = () => {
    setOpen(true);
    notificationsApi
      .list({ limit: 50 })
      .then(response => {
        if (response.success && response.data) setItems(response.data);
      })
      .catch(error => logger.error('Failed to load notifications:', error));
  };

  const handleOpenItem = (item: AppNotification) => {
    void notificationsApi.markRead(item.id).then(refreshUnread);
    setOpen(false);
    if (item.href) navigate(item.href);
  };

  return (
    <>
      <button
        type='button'
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={cn(
          'relative flex items-center gap-2 rounded-lg text-[13px] text-gray-600 hover:bg-black/[0.04] dark:text-dark-700 dark:hover:bg-white/[0.06]',
          sidebarCompact ? 'mx-auto h-9 w-9 justify-center' : 'mx-2 px-2 py-1.5'
        )}
        title={t('notifications.title')}
        aria-label={t('notifications.title')}
        data-testid='notification-bell'
      >
        <Bell className='h-4 w-4 shrink-0' />
        {!sidebarCompact && <span>{t('notifications.title')}</span>}
        {unread > 0 && (
          <span
            className={cn(
              'rounded-full bg-primary-500 px-1.5 text-[10px] font-semibold leading-4 text-white',
              sidebarCompact && 'absolute -right-0.5 -top-0.5'
            )}
            data-testid='notification-unread-badge'
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            className='fixed inset-0 z-[2147483646]'
            onClick={() => setOpen(false)}
          >
            <div
              ref={panelRef}
              role='dialog'
              aria-label={t('notifications.title')}
              className='absolute bottom-16 left-4 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_18px_60px_rgba(0,0,0,0.22)] dark:border-white/[0.1] dark:bg-dark-25'
              onClick={event => event.stopPropagation()}
              data-testid='notification-panel'
            >
              <div className='flex items-center gap-2 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.06]'>
                <span className='flex-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-dark-600'>
                  {t('notifications.title')}
                </span>
                <button
                  type='button'
                  onClick={() =>
                    void notificationsApi.markAllRead().then(() => {
                      refreshUnread();
                      setItems(current =>
                        current
                          ? current.map(item => ({
                              ...item,
                              readAt: item.readAt ?? Date.now(),
                            }))
                          : current
                      );
                    })
                  }
                  className='rounded-md p-1 text-gray-400 hover:text-gray-700 dark:hover:text-dark-800'
                  title={t('notifications.markAllRead')}
                  data-testid='notification-mark-all'
                >
                  <CheckCheck className='h-3.5 w-3.5' />
                </button>
                <button
                  type='button'
                  onClick={() => setOpen(false)}
                  className='rounded-md p-1 text-gray-400 hover:text-gray-700 dark:hover:text-dark-800'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
              <div className='min-h-0 flex-1 overflow-y-auto scrollbar-thin'>
                {items === null ? (
                  <Loader2 className='mx-auto my-6 h-4 w-4 animate-spin text-gray-400' />
                ) : items.length === 0 ? (
                  <p className='py-8 text-center text-xs text-gray-400 dark:text-dark-500'>
                    {t('notifications.empty')}
                  </p>
                ) : (
                  items.map(item => (
                    <div
                      key={item.id}
                      className={cn(
                        'group flex cursor-pointer items-start gap-2 border-b border-black/[0.04] px-3 py-2.5 last:border-b-0 hover:bg-black/[0.03] dark:border-white/[0.04] dark:hover:bg-white/[0.04]',
                        !item.readAt && 'bg-primary-500/[0.04]'
                      )}
                      onClick={() => handleOpenItem(item)}
                      data-testid='notification-item'
                    >
                      <span
                        className={cn(
                          'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                          item.readAt ? 'bg-transparent' : 'bg-primary-500'
                        )}
                      />
                      <div className='min-w-0 flex-1'>
                        <p className='text-[13px] font-medium leading-snug text-gray-900 dark:text-dark-900'>
                          {item.title}
                        </p>
                        {item.body && (
                          <p className='mt-0.5 truncate text-[12px] text-gray-500 dark:text-dark-600'>
                            {item.body}
                          </p>
                        )}
                        <p className='mt-0.5 text-[11px] text-gray-400 dark:text-dark-500'>
                          {formatTimestamp(item.createdAt, i18n.language)}
                        </p>
                      </div>
                      {!item.readAt && (
                        <button
                          type='button'
                          onClick={event => {
                            event.stopPropagation();
                            void notificationsApi.markRead(item.id).then(() => {
                              refreshUnread();
                              setItems(current =>
                                current
                                  ? current.map(entry =>
                                      entry.id === item.id
                                        ? { ...entry, readAt: Date.now() }
                                        : entry
                                    )
                                  : current
                              );
                            });
                          }}
                          className='hidden rounded p-1 text-gray-400 hover:text-emerald-600 group-hover:block'
                          title={t('notifications.markRead')}
                          data-testid='notification-mark-read'
                        >
                          <Check className='h-3.5 w-3.5' />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
