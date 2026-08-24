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

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Button, IconAction, Switch, modalFieldClass } from '@/components/ui';
import { toolsApi } from '@/utils/api';
import type { ToolServerToolView, ToolServerView } from '@/utils/api/toolsApi';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:tools');

/** The backend's explanation for a failed request (e.g. the egress guard
 * refusing a private address) — far more useful than a generic toast. */
const apiErrorMessage = (error: unknown): string | undefined => {
  const backendError = (error as { response?: { data?: { error?: string } } })
    .response?.data?.error;
  if (backendError) return backendError;
  // A locally thrown Error carries the API's message; an Axios error's own
  // message is just the status line, so skip it.
  return error instanceof Error && !('response' in error) && error.message
    ? error.message
    : undefined;
};

interface ToolServerCardProps {
  server: ToolServerView;
  isAdmin: boolean;
  onEdit: (server: ToolServerView) => void;
  onDelete: (server: ToolServerView) => void;
  /** Re-reads the server list after a mutation that changes it. */
  onChanged: () => void;
}

export const ToolServerCard: React.FC<ToolServerCardProps> = ({
  server,
  isAdmin,
  onEdit,
  onDelete,
  onChanged,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [tools, setTools] = useState<ToolServerToolView[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [savingSecret, setSavingSecret] = useState(false);

  const loadTools = async () => {
    setToolsLoading(true);
    try {
      const response = await toolsApi.getServer(server.id);
      if (response.success && response.data) {
        setTools(response.data.tools);
      } else {
        toast.error(response.error || t('toolsPage.toolsLoadFailed'));
      }
    } catch (error) {
      logger.error('Failed to load pinned tools:', error);
      toast.error(t('toolsPage.toolsLoadFailed'));
    } finally {
      setToolsLoading(false);
    }
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && tools.length === 0) void loadTools();
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const response = await toolsApi.refreshServer(server.id);
      if (!response.success) throw new Error(response.error);
      toast.success(t('toolsPage.refreshed'));
      await loadTools();
      onChanged();
    } catch (error) {
      logger.error('Failed to refresh the tool server:', error);
      toast.error(apiErrorMessage(error) || t('toolsPage.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  const overrideTool = async (
    tool: ToolServerToolView,
    overrides: { enabled?: boolean; sideEffect?: boolean }
  ) => {
    // Optimistic: these are switches, so a round trip of dead time reads as
    // a broken control. Reverted below on failure.
    setTools(current =>
      current.map(item =>
        item.name === tool.name ? { ...item, ...overrides } : item
      )
    );
    try {
      const response = await toolsApi.overrideServerTool(
        server.id,
        tool.name,
        overrides
      );
      if (!response.success) throw new Error(response.error);
    } catch (error) {
      logger.error('Failed to override the tool:', error);
      toast.error(t('toolsPage.overrideFailed'));
      setTools(current =>
        current.map(item => (item.name === tool.name ? tool : item))
      );
    }
  };

  const handleSaveCredential = async () => {
    if (!secret.trim()) return;
    setSavingSecret(true);
    try {
      const response = await toolsApi.setCredential(server.id, secret);
      if (!response.success) throw new Error(response.error);
      setSecret('');
      setCredentialOpen(false);
      toast.success(t('toolsPage.credentialSaved'));
      onChanged();
    } catch (error) {
      logger.error('Failed to save the credential:', error);
      toast.error(t('toolsPage.credentialSaveFailed'));
    } finally {
      setSavingSecret(false);
    }
  };

  const handleDeleteCredential = async () => {
    setSavingSecret(true);
    try {
      const response = await toolsApi.deleteCredential(server.id);
      if (!response.success) throw new Error(response.error);
      toast.success(t('toolsPage.credentialRemoved'));
      onChanged();
    } catch (error) {
      logger.error('Failed to remove the credential:', error);
      toast.error(t('toolsPage.credentialRemoveFailed'));
    } finally {
      setSavingSecret(false);
    }
  };

  return (
    <div
      data-testid='tool-server-row'
      className='rounded-2xl border border-black/[0.06] bg-white/60 px-4 py-3 dark:border-white/[0.07] dark:bg-dark-100/60'
    >
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'>
            <p className='truncate text-[14px] font-medium text-gray-900 dark:text-dark-900'>
              {server.name}
            </p>
            <span className='rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:bg-white/[0.06] dark:text-dark-500'>
              {t(`toolsPage.kinds.${server.kind}`)}
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                server.enabled
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-gray-500/10 text-gray-500 dark:text-dark-500'
              )}
            >
              {server.enabled ? t('common.enabled') : t('common.disabled')}
            </span>
            {server.authMode !== 'none' && (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                  server.hasCredential
                    ? 'bg-primary-500/10 text-primary-600 dark:text-primary-400'
                    : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                )}
              >
                {server.hasCredential
                  ? t('toolsPage.credentialSet')
                  : t('toolsPage.credentialMissing')}
              </span>
            )}
          </div>
          {server.description && (
            <p className='mt-1 text-[12px] text-gray-500 dark:text-dark-500'>
              {server.description}
            </p>
          )}
          {isAdmin && server.baseUrl && (
            <p className='mt-1 truncate text-[11px] text-gray-400 dark:text-dark-500'>
              {server.baseUrl}
              {' · '}
              {t('toolsPage.specRevision', { revision: server.specRevision })}
              {server.specDigest && ` · ${server.specDigest.slice(0, 12)}`}
            </p>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-1'>
          {server.authMode !== 'none' && (
            <IconAction
              icon={KeyRound}
              label={t('toolsPage.credential')}
              testId='tool-credential-toggle'
              onClick={() => setCredentialOpen(current => !current)}
            />
          )}
          {isAdmin && (
            <>
              <IconAction
                icon={RefreshCw}
                label={t('toolsPage.refresh')}
                testId='tool-server-refresh'
                disabled={refreshing}
                onClick={() => void handleRefresh()}
              />
              <IconAction
                icon={Pencil}
                label={t('common.edit')}
                testId='tool-server-edit'
                onClick={() => onEdit(server)}
              />
              <IconAction
                icon={Trash2}
                label={t('common.delete')}
                testId='tool-server-delete'
                destructive
                onClick={() => onDelete(server)}
              />
              <IconAction
                icon={expanded ? ChevronDown : ChevronRight}
                label={t('toolsPage.pinnedTools')}
                testId='tool-server-expand'
                onClick={toggleExpanded}
              />
            </>
          )}
        </div>
      </div>

      {credentialOpen && server.authMode !== 'none' && (
        <div
          data-testid='tool-credential-panel'
          className='mt-3 rounded-xl border border-black/[0.06] bg-black/[0.02] p-3 dark:border-white/[0.07] dark:bg-white/[0.03]'
        >
          <p className='mb-2 text-[11px] text-gray-500 dark:text-dark-500'>
            {t('toolsPage.credentialHint')}
          </p>
          <div className='flex flex-wrap items-center gap-2'>
            <input
              type='password'
              value={secret}
              onChange={event => setSecret(event.target.value)}
              placeholder={t('toolsPage.credentialPlaceholder')}
              aria-label={t('toolsPage.credential')}
              autoComplete='off'
              data-testid='tool-credential-secret'
              className={`${modalFieldClass} sm:w-72`}
            />
            <Button
              size='sm'
              disabled={savingSecret || !secret.trim()}
              onClick={() => void handleSaveCredential()}
              data-testid='tool-credential-save'
            >
              {t('common.save')}
            </Button>
            {server.hasCredential && (
              <Button
                size='sm'
                variant='outline'
                disabled={savingSecret}
                onClick={() => void handleDeleteCredential()}
                data-testid='tool-credential-remove'
              >
                {t('toolsPage.credentialRemove')}
              </Button>
            )}
          </div>
        </div>
      )}

      {isAdmin && expanded && (
        <div className='mt-3 rounded-xl border border-black/[0.06] p-3 dark:border-white/[0.07]'>
          <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500'>
            {t('toolsPage.pinnedTools')}
          </p>
          {toolsLoading ? (
            <div className='flex justify-center py-6'>
              <Loader2 className='h-4 w-4 animate-spin text-gray-400' />
            </div>
          ) : tools.length === 0 ? (
            <p className='py-4 text-center text-[12px] text-gray-400 dark:text-dark-500'>
              {t('toolsPage.noPinnedTools')}
            </p>
          ) : (
            <div className='space-y-1.5'>
              {tools.map(tool => (
                <div
                  key={tool.name}
                  data-testid='tool-server-tool'
                  className='flex flex-wrap items-center justify-between gap-3 rounded-lg bg-black/[0.02] px-2.5 py-2 dark:bg-white/[0.03]'
                >
                  <div className='min-w-0'>
                    <div className='flex items-center gap-2'>
                      <code className='text-[12px] text-gray-900 dark:text-dark-900'>
                        {tool.name}
                      </code>
                      {tool.sideEffect && (
                        <span className='rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400'>
                          {t('toolsPage.sideEffect')}
                        </span>
                      )}
                    </div>
                    {tool.description && (
                      <p className='mt-0.5 text-[11px] text-gray-500 dark:text-dark-500'>
                        {tool.description}
                      </p>
                    )}
                  </div>
                  <div className='flex items-center gap-4'>
                    <label className='flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-dark-500'>
                      {t('toolsPage.sideEffectOverride')}
                      <Switch
                        checked={tool.sideEffect}
                        onChange={checked =>
                          void overrideTool(tool, { sideEffect: checked })
                        }
                      />
                    </label>
                    <label className='flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-dark-500'>
                      {t('common.enabled')}
                      <Switch
                        checked={tool.enabled}
                        onChange={checked =>
                          void overrideTool(tool, { enabled: checked })
                        }
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
