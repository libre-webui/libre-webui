/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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
import type { PendingApprovalSummary } from '@/types';
import { usersApi } from '@/utils/api';

export function usePendingUserApprovals(enabled: boolean) {
  const { t } = useTranslation();
  const previousSummaryRef = useRef<PendingApprovalSummary | null>(null);
  const query = useQuery({
    queryKey: ['users', 'pending-approvals'],
    enabled,
    queryFn: async (): Promise<PendingApprovalSummary> => {
      const response = await usersApi.getPendingApprovals();
      if (!response.success || !response.data) {
        throw new Error(response.message || 'Could not load pending accounts');
      }
      return response.data;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!query.data) return;
    const previous = previousSummaryRef.current;
    const hasNewRegistration = previous
      ? Boolean(
          query.data.count > previous.count ||
          (query.data.latestCreatedAt &&
            query.data.latestCreatedAt !== previous.latestCreatedAt)
        )
      : query.data.count > 0;

    previousSummaryRef.current = query.data;
    if (hasNewRegistration) {
      toast(
        t('userManager.approval.notification', {
          count: query.data.count,
          defaultValue:
            '{{count}} registration(s) are waiting for your approval.',
        }),
        { icon: '👤' }
      );
    }
  }, [query.data, t]);

  return {
    ...query,
    pendingApprovalCount: query.data?.count ?? 0,
  };
}
