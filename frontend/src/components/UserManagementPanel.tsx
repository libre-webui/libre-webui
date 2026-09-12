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

import React, { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserManager } from '@/components/UserManager';
import { AgentAccessSettings } from '@/components/AgentAccessSettings';
import { DefaultThemeSettings } from '@/components/DefaultThemeSettings';
import { ToolAccessSettings } from '@/components/ToolAccessSettings';
import { VoiceAccessSettings } from '@/components/VoiceAccessSettings';
import { MfaPolicySettings } from '@/components/MfaPolicySettings';
import { GroupManager } from '@/components/GroupManager';
import { SecurityAuditLog } from '@/components/SecurityAuditLog';
import { ModelDownloadSettings } from '@/components/ModelDownloadSettings';
import { OllamaProviderSettings } from '@/components/OllamaProviderSettings';
import { WebSearchAccessSettings } from '@/components/WebSearchAccessSettings';
import { WorkAccessSettings } from '@/components/WorkAccessSettings';
import { WorkPoliciesSettings } from '@/components/WorkPoliciesSettings';
import { cn } from '@/utils';

const sections = [
  { id: 'users', label: 'userManager.sections.users' },
  { id: 'groups', label: 'userManager.groups.title' },
  { id: 'access', label: 'userManager.sections.access' },
  { id: 'security', label: 'userManager.sections.security' },
  { id: 'defaults', label: 'userManager.sections.defaults' },
] as const;

type SectionId = (typeof sections)[number]['id'];

const renderSection = (section: SectionId) => {
  switch (section) {
    case 'users':
      return <UserManager />;
    case 'groups':
      return <GroupManager />;
    case 'access':
      return (
        <div className='space-y-4'>
          <WorkAccessSettings />
          <WorkPoliciesSettings />
          <OllamaProviderSettings />
          <ModelDownloadSettings />
          <WebSearchAccessSettings />
          <AgentAccessSettings />
          <ToolAccessSettings />
          <VoiceAccessSettings />
        </div>
      );
    case 'security':
      return (
        <div className='space-y-4'>
          <MfaPolicySettings />
          <SecurityAuditLog />
        </div>
      );
    case 'defaults':
      return <DefaultThemeSettings />;
  }
};

/**
 * Start with account management, and load other administrator controls when
 * requested. Visited sections stay mounted so navigation preserves drafts.
 */
export const UserManagementPanel: React.FC = () => {
  const { t } = useTranslation();
  const navigationId = useId();
  const tabRefs = useRef<Partial<Record<SectionId, HTMLButtonElement | null>>>(
    {}
  );
  const [activeSection, setActiveSection] = useState<SectionId>('users');
  const [visitedSections, setVisitedSections] = useState<SectionId[]>([
    'users',
  ]);

  const selectSection = (section: SectionId) => {
    setActiveSection(section);
    setVisitedSections(visited =>
      visited.includes(section) ? visited : [...visited, section]
    );
  };

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    section: SectionId
  ) => {
    const isRtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const currentIndex = sections.findIndex(item => item.id === section);
    let nextIndex: number;

    switch (event.key) {
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = sections.length - 1;
        break;
      case 'ArrowRight':
        nextIndex = currentIndex + (isRtl ? -1 : 1);
        break;
      case 'ArrowLeft':
        nextIndex = currentIndex + (isRtl ? 1 : -1);
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextSection =
      sections[(nextIndex + sections.length) % sections.length].id;
    selectSection(nextSection);
    tabRefs.current[nextSection]?.focus();
  };

  return (
    <div className='min-w-0 space-y-5'>
      <div
        role='tablist'
        aria-label={t('userManager.title')}
        aria-orientation='horizontal'
        className='-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1 pb-3 pt-1 scrollbar-thin'
      >
        {sections.map(section => (
          <button
            key={section.id}
            ref={element => {
              tabRefs.current[section.id] = element;
            }}
            type='button'
            role='tab'
            id={`${navigationId}-tab-${section.id}`}
            aria-controls={`${navigationId}-panel-${section.id}`}
            aria-selected={activeSection === section.id}
            tabIndex={activeSection === section.id ? 0 : -1}
            onClick={() => selectSection(section.id)}
            onKeyDown={event => handleTabKeyDown(event, section.id)}
            className={cn(
              'min-h-11 shrink-0 rounded-xl border px-3 py-2 text-sm font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface motion-reduce:transition-none',
              activeSection === section.id
                ? 'border-line bg-nav-active text-ink'
                : 'border-transparent text-ink-muted hover:bg-hover-solid hover:text-ink'
            )}
          >
            {t(section.label)}
          </button>
        ))}
      </div>
      {sections.map(section => (
        <div
          key={section.id}
          id={`${navigationId}-panel-${section.id}`}
          role='tabpanel'
          aria-labelledby={`${navigationId}-tab-${section.id}`}
          hidden={activeSection !== section.id}
        >
          {visitedSections.includes(section.id) && renderSection(section.id)}
        </div>
      ))}
    </div>
  );
};

export default UserManagementPanel;
