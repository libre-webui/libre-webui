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
import { Code, FileText, Settings } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/utils';

interface StructuredOutputProps {
  format: string | Record<string, unknown> | null;
  onFormatChange: (format: string | Record<string, unknown> | null) => void;
  className?: string;
}

// Keys for translation lookup
const PRESET_FORMAT_KEYS = [
  { key: 'none', value: null },
  { key: 'json', value: 'json' },
  {
    key: 'list',
    value: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['items'],
    },
  },
  {
    key: 'summary',
    value: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        key_points: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['title', 'summary', 'key_points'],
    },
  },
  {
    key: 'analysis',
    value: {
      type: 'object',
      properties: {
        analysis: { type: 'string' },
        pros: {
          type: 'array',
          items: { type: 'string' },
        },
        cons: {
          type: 'array',
          items: { type: 'string' },
        },
        recommendation: { type: 'string' },
      },
      required: ['analysis', 'pros', 'cons', 'recommendation'],
    },
  },
  { key: 'custom', value: 'custom' },
];

export const StructuredOutput: React.FC<StructuredOutputProps> = ({
  format,
  onFormatChange,
  className,
}) => {
  const { t } = useTranslation();
  const [showCustom, setShowCustom] = useState(false);
  const [customSchema, setCustomSchema] = useState('');

  // Build translated presets
  const getPresetFormats = () =>
    PRESET_FORMAT_KEYS.map(preset => ({
      key: preset.key,
      label: t(`chat.structuredOutput.${preset.key}`),
      value: preset.value,
      description: t(`chat.structuredOutput.${preset.key}Description`),
    }));

  const getCurrentPreset = () => {
    const presets = getPresetFormats();
    if (format === null) return presets[0];
    if (format === 'json') return presets[1];
    if (typeof format === 'object') {
      const preset = presets.find(
        p =>
          typeof p.value === 'object' &&
          JSON.stringify(p.value) === JSON.stringify(format)
      );
      if (preset) return preset;
      return {
        key: 'customSchema',
        label: t('chat.structuredOutput.custom'),
        value: format,
        description: t('chat.structuredOutput.customSchema'),
      };
    }
    return presets[0];
  };

  const handlePresetChange = (value: string) => {
    const presets = getPresetFormats();
    const preset = presets.find(p => p.label === value);
    if (!preset) return;

    if (preset.value === 'custom') {
      setShowCustom(true);
      return;
    }

    setShowCustom(false);
    onFormatChange(preset.value);
  };

  const handleCustomApply = () => {
    try {
      const parsed = JSON.parse(customSchema);
      onFormatChange(parsed);
      setShowCustom(false);
    } catch (_error) {
      // Handle JSON parse error
      console.error('Invalid JSON schema:', _error);
    }
  };

  const renderFormatPreview = () => {
    const current = getCurrentPreset();
    if (!current.value || current.value === 'json') return null;

    return (
      <div className='mt-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-md'>
        <div className='flex items-center mb-2'>
          <Code className='h-4 w-4 text-gray-500 mr-2' />
          <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
            {t('chat.structuredOutput.schemaPreview')}
          </span>
        </div>
        <pre className='text-xs text-gray-700 dark:text-gray-300 overflow-x-auto'>
          {JSON.stringify(current.value, null, 2)}
        </pre>
      </div>
    );
  };

  return (
    <div className={cn('space-y-3', className)}>
      <div className='flex items-center justify-between'>
        <div className='flex items-center'>
          <Settings className='h-4 w-4 text-gray-500 mr-2' />
          <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
            {t('chat.structuredOutput.title')}
          </span>
        </div>
      </div>

      <Select
        value={getCurrentPreset().label}
        onChange={e => handlePresetChange(e.target.value)}
        options={getPresetFormats().map(preset => ({
          value: preset.label,
          label: preset.label,
        }))}
      />

      <p className='text-xs text-gray-500 dark:text-gray-400'>
        {getCurrentPreset().description}
      </p>

      {showCustom && (
        <div className='space-y-3'>
          <Textarea
            value={customSchema}
            onChange={e => setCustomSchema(e.target.value)}
            placeholder={`{
  "type": "object",
  "properties": {
    "field1": { "type": "string" },
    "field2": { "type": "number" }
  },
  "required": ["field1"]
}`}
            rows={8}
            className='font-mono text-sm'
          />
          <div className='flex gap-2'>
            <Button
              onClick={handleCustomApply}
              size='sm'
              disabled={!customSchema.trim()}
            >
              {t('chat.structuredOutput.applySchema')}
            </Button>
            <Button
              onClick={() => {
                setShowCustom(false);
                setCustomSchema('');
              }}
              variant='outline'
              size='sm'
            >
              {t('chat.structuredOutput.cancel')}
            </Button>
          </div>
        </div>
      )}

      {renderFormatPreview()}

      {format && (
        <div className='flex items-center text-xs text-green-600 dark:text-green-400'>
          <FileText className='h-3 w-3 mr-1' />
          {t('chat.structuredOutput.enabled')}
        </div>
      )}
    </div>
  );
};

export default StructuredOutput;
