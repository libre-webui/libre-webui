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

import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstance } from 'i18next';
import type { OllamaModel } from '@/types';
import en from '../i18n/locales/en.json';
import de from '../i18n/locales/de.json';
import {
  modelDisplayName,
  modelOptionLabel,
  modelProviderLabel,
} from './modelPresentation';

const i18n = createInstance();
await i18n.init({
  lng: 'en',
  fallbackLng: false,
  resources: {
    en: { translation: en },
    de: { translation: de },
  },
});
const t = i18n.getFixedT('en');
const model = (
  name: string,
  extra: Partial<OllamaModel> = {}
): OllamaModel => ({
  name,
  size: 0,
  digest: '',
  modified_at: '',
  ...extra,
});

test('settings labels distinguish agents, plugins, personas and real Ollama models', () => {
  const cases: Array<[OllamaModel, string, string]> = [
    [model('codex'), 'codex', 'Ollama'],
    [model('codex', { isAgent: true, agentName: 'Codex' }), 'Codex', 'Agent'],
    [
      model('dsh', { isAgent: true, agentName: 'DeepSeek Harness' }),
      'DeepSeek Harness',
      'Agent',
    ],
    [
      model('claude-code:sonnet', {
        isAgent: true,
        agentName: 'Claude Code · Sonnet',
      }),
      'Claude Code · Sonnet',
      'Agent',
    ],
    [
      model('opencode:provider/model', {
        isAgent: true,
        agentName: 'OpenCode · Model',
      }),
      'OpenCode · Model',
      'Agent',
    ],
    [model('pi', { isAgent: true, agentName: 'Pi' }), 'Pi', 'Agent'],
    [
      model('gpt-5.6-sol', {
        isPlugin: true,
        pluginId: 'codex-oauth',
        pluginName: 'Codex (ChatGPT)',
      }),
      'gpt-5.6-sol',
      'Codex (ChatGPT)',
    ],
    [
      model('persona:helper', { isPersona: true, personaName: 'Helper' }),
      'Helper',
      'Persona',
    ],
    [
      model('old-model', { isLegacySelection: true }),
      'old-model',
      'provider not recorded',
    ],
  ];
  for (const [entry, name, provider] of cases) {
    assert.equal(modelDisplayName(entry), name);
    assert.equal(modelProviderLabel(entry, t), provider);
    assert.equal(modelOptionLabel(entry, t), `${name} (${provider})`);
    assert.equal(
      modelOptionLabel(entry, t, 'separator'),
      `${name} · ${provider}`
    );
  }
});

test('unavailable entries retain their recorded provider and translated status', () => {
  const entry = model('codex:gpt-5.6-sol', {
    isAgent: true,
    isUnavailable: true,
  });
  assert.equal(
    modelOptionLabel(entry, t),
    'codex:gpt-5.6-sol (Agent, unavailable)'
  );
  assert.equal(
    modelOptionLabel(entry, i18n.getFixedT('de'), 'separator'),
    'codex:gpt-5.6-sol · Agent (nicht verfügbar)'
  );
  assert.equal(
    modelOptionLabel(
      model('old', { isLegacySelection: true, isUnavailable: true }),
      i18n.getFixedT('de')
    ),
    'old (Anbieter nicht erfasst, nicht verfügbar)'
  );
  assert.equal(
    modelOptionLabel(model('dsh', { isUnavailable: true }), t),
    'dsh (Ollama, unavailable)'
  );
});

test('missing display metadata does not turn an agent or plugin into Ollama', () => {
  assert.equal(
    modelOptionLabel(model('dsh', { isAgent: true }), t),
    'dsh (Agent)'
  );
  assert.equal(
    modelOptionLabel(
      model('remote', { isPlugin: true, pluginId: 'gateway' }),
      t
    ),
    'remote (gateway)'
  );
  assert.equal(
    modelOptionLabel(model('remote', { isPlugin: true }), t),
    'remote (Provider)'
  );
  assert.equal(
    modelOptionLabel(model('persona:gone', { isPersona: true }), t),
    'persona:gone (Persona)'
  );
});
