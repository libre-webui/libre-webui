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

import type { OllamaModel } from '@/types';
import { isAvailableOllamaModel } from './chatModelSelection';

export type ModelSourceKind =
  'legacy' | 'unavailable' | 'personas' | 'ollama' | 'plugin' | 'agent';

/** One selectable source of models: a provider, an agent harness, or a fixed bucket. */
export interface ModelSource {
  key: string;
  kind: ModelSourceKind;
  label: string;
  models: OllamaModel[];
}

export interface ModelSourceLabels {
  legacy: string;
  unavailable: string;
  personas: string;
  ollama: string;
  plugins: string;
  agents: string;
}

/** Groups past this size show a short preview in the combined view. */
export const SOURCE_PREVIEW_THRESHOLD = 8;
export const SOURCE_PREVIEW_SIZE = 5;

const AGENT_NAME_SEPARATOR = ' · ';
const STRANDS_PLUGIN_PREFIX = 'strands:plugin:';

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function agentKey(model: OllamaModel): string {
  return model.agentId || model.name.split(':')[0] || model.name;
}

/** The bare harness entry, which runs the harness's own default model. */
export function isDefaultAgentEntry(model: OllamaModel): boolean {
  return Boolean(
    model.isAgent && model.agentId && model.name === model.agentId
  );
}

function harnessName(models: OllamaModel[], fallback: string): string {
  const bare = models.find(isDefaultAgentEntry);
  if (bare?.agentName) return bare.agentName;
  for (const model of models) {
    const name = model.agentName ?? '';
    const cut = name.indexOf(AGENT_NAME_SEPARATOR);
    if (cut > 0) return name.slice(0, cut);
  }
  return fallback;
}

export interface AgentRowParts {
  title: string;
  /** The provider behind an engine model, e.g. "Amazon Bedrock". */
  provider?: string;
  isDefault: boolean;
}

/**
 * Split "Strands · model-id (Provider)" into its parts once the group header
 * already names the harness, so rows are not all prefixed with it.
 */
export function agentRowParts(
  model: OllamaModel,
  harness: string
): AgentRowParts {
  const name = model.agentName || model.name;
  if (isDefaultAgentEntry(model)) {
    return { title: name, isDefault: true };
  }
  const prefix = `${harness}${AGENT_NAME_SEPARATOR}`;
  let title = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  let provider: string | undefined;
  if (model.name.startsWith(STRANDS_PLUGIN_PREFIX)) {
    const match = /^(.*\S)\s+\(([^()]+)\)$/.exec(title);
    if (match) {
      title = match[1];
      provider = match[2];
    }
  }
  return { title, ...(provider ? { provider } : {}), isDefault: false };
}

function sortCatalog(
  models: OllamaModel[],
  sortName: (model: OllamaModel) => string
): OllamaModel[] {
  return [...models].sort((a, b) => {
    const aDefault = isDefaultAgentEntry(a);
    const bDefault = isDefaultAgentEntry(b);
    if (aDefault !== bDefault) return aDefault ? -1 : 1;
    return collator.compare(sortName(a), sortName(b));
  });
}

/**
 * Split the flat model list into sources. Each plugin and each agent harness
 * gets its own group, so a large catalog from one provider no longer buries
 * everything else. Models come before agents; group order is otherwise the
 * order in which each source first appears.
 */
export function buildModelSources(
  models: OllamaModel[],
  labels: ModelSourceLabels
): ModelSource[] {
  const legacy: OllamaModel[] = [];
  const unavailable: OllamaModel[] = [];
  const personas: OllamaModel[] = [];
  const ollama: OllamaModel[] = [];
  const plugins = new Map<string, OllamaModel[]>();
  const agents = new Map<string, OllamaModel[]>();

  for (const model of models) {
    if (model.isLegacySelection) {
      legacy.push(model);
    } else if (model.isUnavailable) {
      unavailable.push(model);
    } else if (model.isPersona) {
      personas.push(model);
    } else if (model.isAgent) {
      const key = agentKey(model);
      agents.set(key, [...(agents.get(key) ?? []), model]);
    } else if (model.isPlugin) {
      const key = model.pluginId || model.pluginName || '';
      plugins.set(key, [...(plugins.get(key) ?? []), model]);
    } else if (isAvailableOllamaModel(model) && !model.name.includes('embed')) {
      ollama.push(model);
    }
  }

  const sources: ModelSource[] = [
    { key: 'legacy', kind: 'legacy', label: labels.legacy, models: legacy },
    {
      key: 'unavailable',
      kind: 'unavailable',
      label: labels.unavailable,
      models: unavailable,
    },
    {
      key: 'personas',
      kind: 'personas',
      label: labels.personas,
      models: personas,
    },
    { key: 'ollama', kind: 'ollama', label: labels.ollama, models: ollama },
  ];

  for (const [pluginKey, group] of plugins) {
    sources.push({
      key: `plugin:${pluginKey}`,
      kind: 'plugin',
      label: group[0]?.pluginName || pluginKey || labels.plugins,
      models: sortCatalog(group, model => model.name),
    });
  }

  for (const [harnessKey, group] of agents) {
    const label = harnessName(group, harnessKey || labels.agents);
    sources.push({
      key: `agent:${harnessKey}`,
      kind: 'agent',
      label,
      models: sortCatalog(group, model => agentRowParts(model, label).title),
    });
  }

  return sources.filter(source => source.models.length > 0);
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\-_./:·()[\],]+/g, ' ')
    .trim();
}

/**
 * Every word of the query must appear in the model's names or its source's
 * label, so "bedrock opus" and "opus 5.5" both find anthropic.claude-opus-5-5.
 * Separators are ignored, so "gpt4o" matches "gpt-4o".
 */
export function modelMatchesSearch(
  model: OllamaModel,
  source: Pick<ModelSource, 'label'>,
  query: string,
  displayLabel = ''
): boolean {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = normalizeSearchText(
    [
      model.name,
      displayLabel,
      model.personaName,
      model.pluginName,
      model.agentName,
      source.label,
    ]
      .filter(Boolean)
      .join(' ')
  );
  const compact = haystack.replace(/ /g, '');
  return terms.every(term => haystack.includes(term) || compact.includes(term));
}

/**
 * The rows a group shows in the combined view. Large groups are cut to a
 * preview, which always keeps the current selection visible.
 */
export function previewSourceModels(
  models: OllamaModel[],
  isSelected: (model: OllamaModel) => boolean
): { visible: OllamaModel[]; hidden: number } {
  if (models.length <= SOURCE_PREVIEW_THRESHOLD) {
    return { visible: models, hidden: 0 };
  }
  const visible = models.slice(0, SOURCE_PREVIEW_SIZE);
  if (!visible.some(isSelected)) {
    const selected = models.find(isSelected);
    if (selected) visible[visible.length - 1] = selected;
  }
  return { visible, hidden: models.length - visible.length };
}
