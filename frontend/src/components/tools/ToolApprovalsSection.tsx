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

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import type { ToolApprovalView, ToolServerView } from '@/utils/api/toolsApi';
import { formatTimestamp } from '@/utils';

interface ToolApprovalsSectionProps {
  approvals: ToolApprovalView[];
  servers: ToolServerView[];
  revoking: string | null;
  onRevoke: (approvalId: string) => void;
}

/**
 * Standing approvals: the grants that let a side-effecting tool run without
 * asking again. Everything here is revocable, which is the point of showing
 * it at all.
 */
export const ToolApprovalsSection: React.FC<ToolApprovalsSectionProps> = ({
  approvals,
  servers,
  revoking,
  onRevoke,
}) => {
  const { t, i18n } = useTranslation();

  const serverName = (serverId?: string) =>
    servers.find(server => server.id === serverId)?.name ??
    t('toolsPage.builtinSource');

  return (
    <section className='mt-10'>
      <h2 className='mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500'>
        {t('toolsPage.approvals.title')}
      </h2>
      <p className='mb-3 text-[12px] text-gray-500 dark:text-dark-500'>
        {t('toolsPage.approvals.description')}
      </p>
      {approvals.length === 0 ? (
        <p className='rounded-2xl border border-dashed border-black/[0.08] px-4 py-6 text-center text-[12px] text-gray-400 dark:border-white/[0.08] dark:text-dark-500'>
          {t('toolsPage.approvals.empty')}
        </p>
      ) : (
        <div className='space-y-1.5' data-testid='tool-approvals'>
          {approvals.map(approval => (
            <div
              key={approval.id}
              data-testid='tool-approval-row'
              className='flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.05] bg-white/50 px-3 py-2 dark:border-white/[0.06] dark:bg-dark-100/50'
            >
              <div className='min-w-0'>
                <p className='truncate text-[13px] text-gray-900 dark:text-dark-900'>
                  <code>{approval.toolName}</code>
                  {' · '}
                  {serverName(approval.serverId)}
                </p>
                <p className='truncate text-[11px] text-gray-400 dark:text-dark-500'>
                  {t(`toolsPage.approvals.scope.${approval.scope}`)}
                  {' · '}
                  {formatTimestamp(approval.createdAt, i18n.language)}
                </p>
              </div>
              <Button
                size='sm'
                variant='outline'
                disabled={revoking === approval.id}
                onClick={() => onRevoke(approval.id)}
                data-testid='tool-approval-revoke'
              >
                {t('toolsPage.approvals.revoke')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
