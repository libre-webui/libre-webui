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

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { documentsApi, promptsApi, skillsApi, toolsApi } from '@/utils/api';
import type { KnowledgeCollection, PersonaBindings } from '@/types';
import type { Prompt } from '@/utils/api/promptsApi';
import type { Skill } from '@/utils/api/skillsApi';
import type { ToolServerView } from '@/utils/api/toolsApi';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:persona-bindings');

/**
 * Tools the server implements itself, so there is no registry to read them
 * from. Leaving the selection empty offers all of them.
 */
const BUILTIN_TOOLS = ['web_search', 'search_documents', 'load_skill'];

interface PersonaBindingsTabProps {
  bindings: PersonaBindings | undefined;
  onChange: (bindings: PersonaBindings) => void;
}

/**
 * Binds a persona to the resources it composes: tool servers, built-in
 * tools, skills, a prompt and knowledge collections. Ids are stored as-is;
 * the backend revalidates them against the invoking user's permissions every
 * time the persona is used.
 */
export function PersonaBindingsTab({
  bindings,
  onChange,
}: PersonaBindingsTabProps) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<ToolServerView[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      toolsApi.listServers(),
      skillsApi.list(),
      promptsApi.list(),
      documentsApi.getCollections(),
    ])
      .then(([serversRes, skillsRes, promptsRes, collectionsRes]) => {
        if (cancelled) return;
        if (serversRes.success && serversRes.data) setServers(serversRes.data);
        if (skillsRes.success && skillsRes.data) setSkills(skillsRes.data);
        if (promptsRes.success && promptsRes.data) setPrompts(promptsRes.data);
        if (collectionsRes.success && collectionsRes.data) {
          setCollections(collectionsRes.data);
        }
      })
      .catch(error => {
        // A persona is still editable without the binding catalogue; the
        // lists simply render as empty.
        logger.error('Failed to load bindable resources:', error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (updates: Partial<PersonaBindings>) =>
    onChange({ ...(bindings ?? {}), ...updates });

  const toggleId = (
    key: 'tool_server_ids' | 'builtin_tools' | 'skill_ids',
    id: string
  ) => {
    const current = bindings?.[key] ?? [];
    patch({
      [key]: current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id],
    });
  };

  const toggleCollection = (id: string) => {
    const current = bindings?.knowledge_collection_ids ?? [];
    patch({
      knowledge_collection_ids: current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id],
    });
  };

  if (loading) {
    return (
      <div className='flex items-center justify-center py-10'>
        <Loader2 className='h-5 w-5 animate-spin text-gray-400' />
      </div>
    );
  }

  return (
    <div className='space-y-6' data-testid='persona-bindings-tab'>
      <CheckboxGroup
        title={t('personaForm.bindings.toolServers')}
        hint={t('personaForm.bindings.toolServersHint')}
        emptyLabel={t('personaForm.bindings.noToolServers')}
        options={servers.map(server => ({
          id: server.id,
          label: server.name,
          detail: server.description,
        }))}
        selected={bindings?.tool_server_ids ?? []}
        onToggle={id => toggleId('tool_server_ids', id)}
        testId='persona-binding-tool-servers'
      />

      <CheckboxGroup
        title={t('personaForm.bindings.builtinTools')}
        hint={t('personaForm.bindings.builtinToolsHint')}
        emptyLabel={t('personaForm.bindings.noBuiltinTools')}
        options={BUILTIN_TOOLS.map(name => ({
          id: name,
          label: t(`personaForm.bindings.builtin.${name}`),
          detail: name,
        }))}
        selected={bindings?.builtin_tools ?? []}
        onToggle={id => toggleId('builtin_tools', id)}
        testId='persona-binding-builtin-tools'
      />

      <CheckboxGroup
        title={t('personaForm.bindings.skills')}
        hint={t('personaForm.bindings.skillsHint')}
        emptyLabel={t('personaForm.bindings.noSkills')}
        options={skills.map(skill => ({
          id: skill.id,
          label: skill.name,
          detail: `$${skill.slug}`,
        }))}
        selected={bindings?.skill_ids ?? []}
        onToggle={id => toggleId('skill_ids', id)}
        testId='persona-binding-skills'
      />

      <CheckboxGroup
        title={t('personaForm.bindings.collections')}
        hint={t('personaForm.bindings.collectionsHint')}
        emptyLabel={t('personaForm.bindings.noCollections')}
        options={collections.map(collection => ({
          id: collection.id,
          label: collection.name,
        }))}
        selected={bindings?.knowledge_collection_ids ?? []}
        onToggle={toggleCollection}
        testId='persona-binding-collections'
      />

      <div>
        <h3 className='text-sm font-semibold text-gray-900 dark:text-dark-800'>
          {t('personaForm.bindings.prompt')}
        </h3>
        <p className='mb-2 mt-1 text-xs text-gray-500 dark:text-dark-600'>
          {t('personaForm.bindings.promptHint')}
        </p>
        <select
          value={bindings?.prompt_id ?? ''}
          onChange={event =>
            patch({ prompt_id: event.target.value || undefined })
          }
          data-testid='persona-binding-prompt'
          aria-label={t('personaForm.bindings.prompt')}
          className='w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:ring-2 focus:ring-primary-500/20 dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
        >
          <option value=''>{t('personaForm.bindings.noPrompt')}</option>
          {prompts.map(prompt => (
            <option key={prompt.id} value={prompt.id}>
              {prompt.title}
            </option>
          ))}
        </select>
      </div>

      <p className='text-xs text-gray-400 dark:text-dark-500'>
        {t('personaForm.bindings.version', {
          version: bindings?.version ?? 0,
        })}
      </p>
    </div>
  );
}

interface CheckboxGroupProps {
  title: string;
  hint: string;
  emptyLabel: string;
  options: { id: string; label: string; detail?: string }[];
  selected: string[];
  onToggle: (id: string) => void;
  testId: string;
}

function CheckboxGroup({
  title,
  hint,
  emptyLabel,
  options,
  selected,
  onToggle,
  testId,
}: CheckboxGroupProps) {
  return (
    <div data-testid={testId}>
      <h3 className='text-sm font-semibold text-gray-900 dark:text-dark-800'>
        {title}
      </h3>
      <p className='mb-2 mt-1 text-xs text-gray-500 dark:text-dark-600'>
        {hint}
      </p>
      {options.length === 0 ? (
        <p className='rounded-lg border border-dashed border-gray-200 px-3 py-4 text-center text-xs text-gray-400 dark:border-dark-300 dark:text-dark-500'>
          {emptyLabel}
        </p>
      ) : (
        <div className='space-y-1'>
          {options.map(option => (
            <label
              key={option.id}
              className='flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-gray-50 dark:hover:bg-dark-200'
            >
              <input
                type='checkbox'
                checked={selected.includes(option.id)}
                onChange={() => onToggle(option.id)}
                className='h-4 w-4 rounded border-gray-300 dark:border-dark-400'
              />
              <span className='text-sm text-gray-900 dark:text-dark-800'>
                {option.label}
              </span>
              {option.detail && (
                <span className='truncate text-xs text-gray-400 dark:text-dark-500'>
                  {option.detail}
                </span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
