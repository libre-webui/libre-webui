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
import { UserManager } from '@/components/UserManager';
import { AgentAccessSettings } from '@/components/AgentAccessSettings';
import { GroupManager } from '@/components/GroupManager';
import { SecurityAuditLog } from '@/components/SecurityAuditLog';
import { ModelDownloadSettings } from '@/components/ModelDownloadSettings';
import { WebSearchAccessSettings } from '@/components/WebSearchAccessSettings';
import { WorkAccessSettings } from '@/components/WorkAccessSettings';
import { WorkPoliciesSettings } from '@/components/WorkPoliciesSettings';
import { PageHeader, PageShell } from '@/components/ui';

export const UserManagementPage: React.FC = () => {
  const { t } = useTranslation();

  return (
    <PageShell>
      <PageHeader
        title={t('userManager.title')}
        description={t('userManager.pageDescription')}
      />
      <div className='mb-4 space-y-4'>
        <WorkAccessSettings />
        <WorkPoliciesSettings />
        <ModelDownloadSettings />
        <WebSearchAccessSettings />
        <AgentAccessSettings />
        <GroupManager />
        <SecurityAuditLog />
      </div>
      <UserManager />
    </PageShell>
  );
};

export default UserManagementPage;
