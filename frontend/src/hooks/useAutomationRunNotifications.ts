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

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { AutomationRunsSummary } from '@/utils/api/automationsApi';
import { automationsApi } from '@/utils/api';

/**
 * Polls the automation run summary for the signed-in user: powers the
 * sidebar badge and raises a toast when new runs finish while the app is
 * open. The Runs tab marks runs seen, which clears the badge.
 */
export function useAutomationRunNotifications(enabled: boolean) {
  const { t } = useTranslation();
  const previousUnseenRef = useRef<number | null>(null);
  const query = useQuery({
    queryKey: ['automations', 'runs-summary'],
    enabled,
    queryFn: async (): Promise<AutomationRunsSummary> => {
      const response = await automationsApi.getRunsSummary();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Could not load automation runs');
      }
      return response.data;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!query.data) return;
    const previous = previousUnseenRef.current;
    const unseen = query.data.unseenCount;
    // Only a growing count while the app is open deserves a toast; the
    // initial value would re-announce runs from before this session.
    if (previous !== null && unseen > previous) {
      toast(t('automations.finishedNotification', { n: unseen }), {
        icon: '⚡',
      });
    }
    previousUnseenRef.current = unseen;
  }, [query.data, t]);

  return {
    ...query,
    unseenRunCount: query.data?.unseenCount ?? 0,
  };
}
