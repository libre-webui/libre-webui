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
import { useDialogFocus } from '@/hooks/useDialogFocus';
import type { AppNotification } from '@/types';

const logger = createLogger('notification-bell');

interface NotificationBellProps {
  sidebarCompact: boolean;
}

interface NotificationPanelProps {
  items: AppNotification[] | null;
  loadFailed: boolean;
  onRetry: () => void;
  onClose: () => void;
  onOpenItem: (item: AppNotification) => void;
  onMarkRead: (item: AppNotification) => void;
  onMarkAllRead: () => void;
}

// Mounted only while open so focus capture, trapping and restore track the
// panel's lifetime.
const NotificationPanel: React.FC<NotificationPanelProps> = ({
  items,
  loadFailed,
  onRetry,
  onClose,
  onOpenItem,
  onMarkRead,
  onMarkAllRead,
}) => {
  const { t, i18n } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef, { onClose });

  return (
    <div className='fixed inset-0 z-[2147483646]' onClick={onClose}>
      <div
        ref={panelRef}
        role='dialog'
        aria-modal='true'
        aria-label={t('notifications.title')}
        tabIndex={-1}
        className='absolute bottom-16 start-4 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_18px_60px_rgba(0,0,0,0.22)] dark:border-white/[0.1] dark:bg-dark-25'
        onClick={event => event.stopPropagation()}
        data-testid='notification-panel'
      >
        <div className='flex items-center gap-2 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.06]'>
          <span className='flex-1 text-xs font-semibold uppercase tracking-wide text-ink-muted'>
            {t('notifications.title')}
          </span>
          <button
            type='button'
            onClick={onMarkAllRead}
            className='rounded-md p-1 text-ink-muted hover:text-ink'
            title={t('notifications.markAllRead')}
            aria-label={t('notifications.markAllRead')}
            data-testid='notification-mark-all'
          >
            <CheckCheck className='h-3.5 w-3.5' aria-hidden='true' />
          </button>
          <button
            type='button'
            onClick={onClose}
            className='rounded-md p-1 text-ink-muted hover:text-ink'
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X className='h-3.5 w-3.5' aria-hidden='true' />
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto scrollbar-thin'>
          {loadFailed && items === null ? (
            <div role='alert' className='px-4 py-6 text-center'>
              <p className='text-xs text-ink-muted'>
                {t('notifications.loadFailed')}
              </p>
              <button
                type='button'
                onClick={onRetry}
                className='mt-2 rounded-md px-2 py-1 text-xs font-medium text-ink underline underline-offset-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                data-testid='notification-retry'
              >
                {t('common.retry')}
              </button>
            </div>
          ) : items === null ? (
            <div role='status' className='py-6'>
              <Loader2
                className='mx-auto h-4 w-4 animate-spin text-ink-muted motion-reduce:animate-none'
                aria-hidden='true'
              />
              <span className='sr-only'>{t('common.loading')}</span>
            </div>
          ) : items.length === 0 ? (
            <p className='py-8 text-center text-xs text-ink-muted'>
              {t('notifications.empty')}
            </p>
          ) : (
            items.map(item => (
              <div
                key={item.id}
                className={cn(
                  'group flex items-start border-b border-black/[0.04] last:border-b-0 hover:bg-black/[0.03] dark:border-white/[0.04] dark:hover:bg-white/[0.04]',
                  !item.readAt && 'bg-primary-500/[0.04]'
                )}
                data-testid='notification-item'
              >
                <button
                  type='button'
                  onClick={() => onOpenItem(item)}
                  className='flex min-w-0 flex-1 items-start gap-2 px-3 py-2.5 text-start'
                >
                  <span
                    className={cn(
                      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      item.readAt ? 'bg-transparent' : 'bg-primary-500'
                    )}
                    aria-hidden='true'
                  />
                  <span className='min-w-0 flex-1'>
                    {!item.readAt && (
                      <span className='sr-only'>
                        {t('notifications.unread')}
                      </span>
                    )}
                    <span className='block text-[13px] font-medium leading-snug text-ink'>
                      {item.title}
                    </span>
                    {item.body && (
                      <span className='mt-0.5 block truncate text-[12px] text-ink-muted'>
                        {item.body}
                      </span>
                    )}
                    <span className='mt-0.5 block text-[11px] text-ink-muted'>
                      {formatTimestamp(item.createdAt, i18n.language)}
                    </span>
                  </span>
                </button>
                {!item.readAt && (
                  <button
                    type='button'
                    onClick={() => onMarkRead(item)}
                    className='me-2 mt-1.5 hidden rounded p-1.5 text-ink-muted hover:text-success-700 focus-visible:block group-focus-within:block group-hover:block [@media(pointer:coarse)]:block dark:hover:text-success-400'
                    title={t('notifications.markRead')}
                    aria-label={t('notifications.markRead')}
                    data-testid='notification-mark-read'
                  >
                    <Check className='h-3.5 w-3.5' aria-hidden='true' />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * The durable notification inbox: an unread badge fed by the live
 * per-user stream (with a polling fallback) and a panel listing the
 * newest notifications with read/dismiss controls.
 */
export const NotificationBell: React.FC<NotificationBellProps> = ({
  sidebarCompact,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

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

  const loadItems = () => {
    setLoadFailed(false);
    notificationsApi
      .list({ limit: 50 })
      .then(response => {
        if (response.success && response.data) setItems(response.data);
        else setLoadFailed(true);
      })
      .catch(error => {
        logger.error('Failed to load notifications:', error);
        setLoadFailed(true);
      });
  };

  const openPanel = () => {
    setOpen(true);
    loadItems();
  };

  const handleOpenItem = (item: AppNotification) => {
    void notificationsApi.markRead(item.id).then(refreshUnread);
    setOpen(false);
    if (item.href) navigate(item.href);
  };

  const handleMarkRead = (item: AppNotification) => {
    void notificationsApi.markRead(item.id).then(() => {
      refreshUnread();
      setItems(current =>
        current
          ? current.map(entry =>
              entry.id === item.id ? { ...entry, readAt: Date.now() } : entry
            )
          : current
      );
    });
  };

  const handleMarkAllRead = () => {
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
    });
  };

  const bellLabel =
    unread > 0
      ? t('notifications.titleWithUnread', { unread })
      : t('notifications.title');

  return (
    <>
      <button
        type='button'
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-expanded={open}
        className={cn(
          'relative flex items-center gap-2 rounded-lg text-[13px] text-gray-600 hover:bg-black/[0.04] dark:text-dark-700 dark:hover:bg-white/[0.06]',
          sidebarCompact ? 'mx-auto h-9 w-9 justify-center' : 'mx-2 px-2 py-1.5'
        )}
        title={bellLabel}
        aria-label={bellLabel}
        data-testid='notification-bell'
      >
        <Bell className='h-4 w-4 shrink-0' aria-hidden='true' />
        {!sidebarCompact && <span>{t('notifications.title')}</span>}
        {unread > 0 && (
          <span
            className={cn(
              'rounded-full bg-primary-600 px-1.5 text-[10px] font-semibold leading-4 text-white',
              sidebarCompact && 'absolute -end-0.5 -top-0.5'
            )}
            data-testid='notification-unread-badge'
            aria-hidden='true'
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <NotificationPanel
            items={items}
            loadFailed={loadFailed}
            onRetry={loadItems}
            onClose={() => setOpen(false)}
            onOpenItem={handleOpenItem}
            onMarkRead={handleMarkRead}
            onMarkAllRead={handleMarkAllRead}
          />,
          document.body
        )}
    </>
  );
};
