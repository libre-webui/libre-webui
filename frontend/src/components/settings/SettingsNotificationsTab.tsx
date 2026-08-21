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
import { BellRing } from 'lucide-react';
import { SettingsToggle } from './SettingsToggle';
import { pushApi } from '@/utils/api/pushApi';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:settings-notifications');

const pushSupported = (): boolean =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

const applicationServerKey = (base64Url: string): Uint8Array<ArrayBuffer> => {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/**
 * Notification delivery for this browser. Push requires the production
 * service worker; the toggle explains itself when the environment cannot
 * deliver push at all.
 */
export const SettingsNotificationsTab: React.FC = () => {
  const { t } = useTranslation();
  const [supported] = useState(pushSupported);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workerReady, setWorkerReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        setWorkerReady(false);
        setEnabled(false);
        return;
      }
      setWorkerReady(true);
      const subscription = await registration.pushManager.getSubscription();
      setEnabled(Boolean(subscription));
    } catch (error) {
      logger.debug('Push state read failed', error);
    }
  }, [supported]);

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  const enablePush = async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      toast.error(t('settings.notifications.workerMissing'));
      return;
    }
    const decision = await Notification.requestPermission();
    setPermission(decision);
    if (decision !== 'granted') {
      toast.error(t('settings.notifications.permissionDenied'));
      return;
    }
    const keyResponse = await pushApi.getPublicKey();
    if (!keyResponse.success || !keyResponse.data) {
      toast.error(
        keyResponse.message || t('settings.notifications.enableFailed')
      );
      return;
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(keyResponse.data.publicKey),
    });
    const saved = await pushApi.subscribe(subscription.toJSON());
    if (!saved.success) {
      await subscription.unsubscribe().catch(() => undefined);
      toast.error(saved.message || t('settings.notifications.enableFailed'));
      return;
    }
    setEnabled(true);
    toast.success(t('settings.notifications.enabled'));
  };

  const disablePush = async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await pushApi.unsubscribe(subscription.endpoint).catch(() => undefined);
      await subscription.unsubscribe().catch(() => undefined);
    }
    setEnabled(false);
    toast.success(t('settings.notifications.disabled'));
  };

  const handleToggle = async (checked: boolean) => {
    setBusy(true);
    try {
      if (checked) {
        await enablePush();
      } else {
        await disablePush();
      }
    } catch (error) {
      logger.error('Push toggle failed', error);
      toast.error(t('settings.notifications.enableFailed'));
    } finally {
      setBusy(false);
    }
  };

  const unavailableReason = !supported
    ? t('settings.notifications.unsupported')
    : !workerReady
      ? t('settings.notifications.workerMissing')
      : permission === 'denied'
        ? t('settings.notifications.permissionDenied')
        : null;

  return (
    <div className='space-y-6' data-testid='settings-notifications-tab'>
      <div>
        <h3 className='flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100'>
          <BellRing className='h-5 w-5 text-primary-500' />
          {t('settings.notifications.title')}
        </h3>
        <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
          {t('settings.notifications.description')}
        </p>
      </div>

      <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
        <div className='flex items-center justify-between gap-4'>
          <div>
            <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
              {t('settings.notifications.pushTitle')}
            </p>
            <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
              {unavailableReason ?? t('settings.notifications.pushHint')}
            </p>
          </div>
          <SettingsToggle
            checked={enabled}
            disabled={busy || Boolean(unavailableReason && !enabled)}
            onChange={handleToggle}
          />
        </div>
      </div>

      <p className='text-xs text-gray-500 dark:text-gray-400'>
        {t('settings.notifications.deviceNote')}
      </p>
    </div>
  );
};

export default SettingsNotificationsTab;
