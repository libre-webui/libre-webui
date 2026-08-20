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
import { Loader2, Share2, Users, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button, ModalShell, modalFieldClass } from '@/components/ui';
import { accessApi, type ResourceGrant } from '@/utils/api/accessApi';
import { createLogger } from '@/utils/logger';

const logger = createLogger('share-dialog');

export interface ShareDialogProps {
  /** Grant resource family, e.g. 'session', 'persona', 'calendar'. */
  resourceType: string;
  resourceId: string;
  /** Human name of the thing being shared, for the dialog title. */
  resourceLabel: string;
  onClose: () => void;
}

/**
 * The one share surface used by every shareable resource: exact-match
 * user or group principals, read/write permission, and revocation. The
 * server resolves display names for existing grants.
 */
export const ShareDialog: React.FC<ShareDialogProps> = ({
  resourceType,
  resourceId,
  resourceLabel,
  onClose,
}) => {
  const { t } = useTranslation();
  const [grants, setGrants] = useState<ResourceGrant[] | null>(null);
  const [principalKind, setPrincipalKind] = useState<'user' | 'group'>('user');
  const [principalName, setPrincipalName] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('read');
  const [sharing, setSharing] = useState(false);

  const loadGrants = useCallback(() => {
    accessApi
      .listGrants(resourceType, resourceId)
      .then(response => {
        if (response.success && Array.isArray(response.data)) {
          setGrants(response.data);
        }
      })
      .catch(error => logger.error('Failed to load shares:', error));
  }, [resourceType, resourceId]);

  useEffect(() => {
    loadGrants();
  }, [loadGrants]);

  const handleShare = async () => {
    const name = principalName.trim();
    if (!name) return;
    setSharing(true);
    try {
      const principal =
        principalKind === 'user'
          ? await accessApi.resolvePrincipal(name)
          : await accessApi.resolveGroup(name);
      if (!principal.success || !principal.data) {
        toast.error(
          principalKind === 'user'
            ? t('share.userNotFound')
            : t('share.groupNotFound')
        );
        return;
      }
      const response = await accessApi.createGrant({
        resourceType,
        resourceId,
        principalType: principalKind,
        principalId: principal.data.id,
        permission,
      });
      if (response.success) {
        setPrincipalName('');
        loadGrants();
        toast.success(t('share.added', { name }));
      } else {
        toast.error(response.error || t('share.failed'));
      }
    } catch (error) {
      logger.error('Failed to share resource:', error);
      toast.error(t('share.failed'));
    } finally {
      setSharing(false);
    }
  };

  const handleRevoke = async (grantId: string) => {
    try {
      const response = await accessApi.deleteGrant(grantId);
      if (response.success) loadGrants();
    } catch (error) {
      logger.error('Failed to revoke share:', error);
    }
  };

  return (
    <ModalShell
      titleId='share-dialog-title'
      title={t('share.title', { name: resourceLabel })}
      subtitle={t('share.subtitle')}
      onClose={onClose}
      testId='share-dialog'
    >
      <div className='flex gap-1.5'>
        <select
          value={principalKind}
          onChange={event =>
            setPrincipalKind(event.target.value as 'user' | 'group')
          }
          className={`${modalFieldClass} w-auto`}
          data-testid='share-principal-kind'
        >
          <option value='user'>{t('share.kindUser')}</option>
          <option value='group'>{t('share.kindGroup')}</option>
        </select>
        <input
          type='text'
          value={principalName}
          onChange={event => setPrincipalName(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void handleShare();
          }}
          placeholder={
            principalKind === 'user'
              ? t('share.usernamePlaceholder')
              : t('share.groupPlaceholder')
          }
          className={`${modalFieldClass} min-w-0 flex-1`}
          data-testid='share-principal-name'
        />
        <select
          value={permission}
          onChange={event =>
            setPermission(event.target.value as 'read' | 'write')
          }
          className={`${modalFieldClass} w-auto`}
          data-testid='share-permission'
        >
          <option value='read'>{t('share.permissionRead')}</option>
          <option value='write'>{t('share.permissionWrite')}</option>
        </select>
        <Button
          size='sm'
          disabled={sharing || !principalName.trim()}
          onClick={() => void handleShare()}
          data-testid='share-submit'
        >
          {sharing ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            t('share.action')
          )}
        </Button>
      </div>
      {grants === null ? (
        <Loader2 className='mx-auto h-4 w-4 animate-spin text-gray-400' />
      ) : grants.length === 0 ? (
        <p className='text-center text-xs text-gray-400 dark:text-dark-500'>
          {t('share.empty')}
        </p>
      ) : (
        <div className='space-y-2'>
          {grants.map(grant => (
            <div
              key={grant.id}
              className='flex items-center gap-2 rounded-lg border border-black/[0.06] px-2.5 py-2 dark:border-white/[0.08]'
              data-testid='share-item'
            >
              {grant.principalType === 'group' ? (
                <Users className='h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-dark-500' />
              ) : (
                <Share2 className='h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-dark-500' />
              )}
              <span className='min-w-0 flex-1 truncate text-[13px] text-gray-800 dark:text-dark-800'>
                {grant.principalName ?? grant.principalId}
              </span>
              <span className='shrink-0 text-[11px] uppercase text-gray-400 dark:text-dark-500'>
                {grant.permission}
              </span>
              <button
                type='button'
                onClick={() => void handleRevoke(grant.id)}
                className='rounded-md p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                title={t('share.revoke')}
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </div>
          ))}
        </div>
      )}
      <p className='text-[11px] leading-relaxed text-gray-400 dark:text-dark-500'>
        {t('share.hint')}
      </p>
    </ModalShell>
  );
};

export default ShareDialog;
