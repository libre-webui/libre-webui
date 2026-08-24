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
import { Plus, Wrench } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button, ModalShell } from '@/components/ui';
import { SettingsTabHeader } from './SettingsTabHeader';
import { ToolApprovalsSection } from '@/components/tools/ToolApprovalsSection';
import { ToolServerCard } from '@/components/tools/ToolServerCard';
import { ToolServerFormModal } from '@/components/tools/ToolServerFormModal';
import { WorkspaceTemplateGrid } from './WorkspaceTemplateGrid';
import { TOOL_SERVER_TEMPLATES } from '@/utils/toolServerTemplates';
import { useAuthStore } from '@/store/authStore';
import { toolsApi } from '@/utils/api';
import type {
  ToolApprovalView,
  ToolServerInput,
  ToolServerView,
} from '@/utils/api/toolsApi';
import { createLogger } from '@/utils/logger';

const logger = createLogger('pages:tools');

/** The backend's explanation for a failed request (e.g. the egress guard
 * refusing a private address) — far more useful than a generic toast. */
const apiErrorMessage = (error: unknown): string | undefined =>
  (error as { response?: { data?: { error?: string } } }).response?.data?.error;

export const SettingsToolsTab: React.FC = () => {
  const { t } = useTranslation();
  const isAdmin = useAuthStore(state => state.isAdmin());
  const [servers, setServers] = useState<ToolServerView[]>([]);
  const [approvals, setApprovals] = useState<ToolApprovalView[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ToolServerView | null>(null);
  const [templatePrefill, setTemplatePrefill] =
    useState<ToolServerInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<ToolServerView | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const [refreshCounter, setRefreshCounter] = useState(0);
  const refresh = useCallback(
    () => setRefreshCounter(counter => counter + 1),
    []
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([toolsApi.listServers(), toolsApi.listApprovals()])
      .then(([serversResponse, approvalsResponse]) => {
        if (cancelled) return;
        if (serversResponse.success && serversResponse.data) {
          setServers(serversResponse.data);
        } else {
          toast.error(serversResponse.error || t('toolsPage.loadFailed'));
        }
        if (approvalsResponse.success && approvalsResponse.data) {
          setApprovals(approvalsResponse.data.standing);
        }
      })
      .catch(error => {
        if (cancelled) return;
        logger.error('Failed to load tool servers:', error);
        toast.error(t('toolsPage.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshCounter, t]);

  const handleSave = async (
    payload: ToolServerInput | Partial<ToolServerInput>
  ) => {
    setSaving(true);
    try {
      const response = editing
        ? await toolsApi.updateServer(editing.id, payload)
        : await toolsApi.registerServer(payload as ToolServerInput);
      if (response.success) {
        setModalOpen(false);
        setTemplatePrefill(null);
        toast.success(t('toolsPage.saved'));
        refresh();
      } else {
        toast.error(response.error || t('toolsPage.saveFailed'));
      }
    } catch (error) {
      logger.error('Failed to save the tool server:', error);
      toast.error(apiErrorMessage(error) || t('toolsPage.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      const response = await toolsApi.deleteServer(target.id);
      if (!response.success) throw new Error(response.error);
      toast.success(t('toolsPage.deleted'));
      refresh();
    } catch (error) {
      logger.error('Failed to delete the tool server:', error);
      toast.error(apiErrorMessage(error) || t('toolsPage.deleteFailed'));
    }
  };

  const handleRevoke = async (approvalId: string) => {
    setRevoking(approvalId);
    try {
      const response = await toolsApi.revokeApproval(approvalId);
      if (!response.success) throw new Error(response.error);
      setApprovals(current => current.filter(item => item.id !== approvalId));
      toast.success(t('toolsPage.approvals.revoked'));
    } catch (error) {
      logger.error('Failed to revoke the approval:', error);
      toast.error(t('toolsPage.approvals.revokeFailed'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div data-testid='tools-page' className='pb-2'>
      <SettingsTabHeader
        title={t('toolsPage.title')}
        description={t('toolsPage.description')}
        actions={
          isAdmin ? (
            <Button
              size='sm'
              onClick={() => {
                setEditing(null);
                setTemplatePrefill(null);
                setModalOpen(true);
              }}
              data-testid='tool-server-new'
            >
              <Plus className='me-1.5 h-3.5 w-3.5' />
              {t('toolsPage.registerServer')}
            </Button>
          ) : undefined
        }
      />

      <p className='mb-5 rounded-xl border border-black/[0.06] bg-black/[0.02] px-3.5 py-2.5 text-[12px] leading-5 text-gray-500 dark:border-white/[0.07] dark:bg-white/[0.03] dark:text-dark-500'>
        {t('toolsPage.approvalNotice')}
      </p>

      {loading ? null : servers.length === 0 ? (
        <div className='px-3 py-16 text-center'>
          <Wrench className='mx-auto mb-3 h-6 w-6 text-gray-300 dark:text-dark-400' />
          <p className='text-sm text-gray-500 dark:text-dark-500'>
            {t('toolsPage.empty')}
          </p>
          <p className='mx-auto mt-2 max-w-md text-[13px] leading-6 text-gray-400 dark:text-dark-500'>
            {isAdmin
              ? t('toolsPage.emptyHintAdmin')
              : t('toolsPage.emptyHintUser')}
          </p>
        </div>
      ) : (
        <div className='space-y-2'>
          {servers.map(server => (
            <ToolServerCard
              key={server.id}
              server={server}
              isAdmin={isAdmin}
              onEdit={target => {
                setEditing(target);
                setModalOpen(true);
              }}
              onDelete={setDeleting}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      <ToolApprovalsSection
        approvals={approvals}
        servers={servers}
        revoking={revoking}
        onRevoke={approvalId => void handleRevoke(approvalId)}
      />

      {isAdmin && !loading && (
        <WorkspaceTemplateGrid
          title={t('toolsPage.templatesTitle')}
          testId='tool-server-template'
          cards={TOOL_SERVER_TEMPLATES.map(template => ({
            id: template.id,
            name: t(`toolsPage.templates.${template.id}.name`),
            description: t(`toolsPage.templates.${template.id}.description`),
            meta: template.input.baseUrl,
          }))}
          onPick={id => {
            const template = TOOL_SERVER_TEMPLATES.find(
              entry => entry.id === id
            );
            if (!template) return;
            setEditing(null);
            setTemplatePrefill(template.input);
            setModalOpen(true);
          }}
        />
      )}

      <ToolServerFormModal
        open={modalOpen}
        server={editing}
        prefill={templatePrefill}
        saving={saving}
        onClose={() => {
          setModalOpen(false);
          setTemplatePrefill(null);
        }}
        onSave={payload => void handleSave(payload)}
      />

      {deleting && (
        <ModalShell
          titleId='tool-server-delete-title'
          title={t('toolsPage.deleteTitle')}
          subtitle={t('toolsPage.deleteConfirm', { name: deleting.name })}
          onClose={() => setDeleting(null)}
          widthClassName='max-w-sm'
          testId='tool-server-delete-modal'
          footer={
            <>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setDeleting(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant='danger'
                size='sm'
                onClick={() => void handleDelete()}
                data-testid='tool-server-delete-confirm'
              >
                {t('common.delete')}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
};

export default SettingsToolsTab;
