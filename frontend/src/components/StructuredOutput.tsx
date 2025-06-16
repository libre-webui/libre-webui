import React, { useState } from 'react';
import { Code, FileText, Settings } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/utils';

interface StructuredOutputProps {
  format: string | Record<string, any> | null;
  onFormatChange: (format: string | Record<string, any> | null) => void;
  className?: string;
}

const PRESET_FORMATS = [
  {
    label: 'None (Natural Language)',
    value: null,
    description: 'Default natural language response',
  },
  {
    label: 'JSON',
    value: 'json',
    description: 'Structured JSON format',
  },
  {
    label: 'List',
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
    description: 'Array of items',
  },
  {
    label: 'Summary',
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
    description: 'Document summary with key points',
  },
  {
    label: 'Analysis',
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
    description: 'Structured analysis with pros/cons',
  },
  {
    label: 'Custom Schema',
    value: 'custom',
    description: 'Define your own JSON schema',
  },
];

export const StructuredOutput: React.FC<StructuredOutputProps> = ({
  format,
  onFormatChange,
  className,
}) => {
  const [showCustom, setShowCustom] = useState(false);
  const [customSchema, setCustomSchema] = useState('');

  const getCurrentPreset = () => {
    if (format === null) return PRESET_FORMATS[0];
    if (format === 'json') return PRESET_FORMATS[1];
    if (typeof format === 'object') {
      const preset = PRESET_FORMATS.find(
        p =>
          typeof p.value === 'object' &&
          JSON.stringify(p.value) === JSON.stringify(format)
      );
      if (preset) return preset;
      return {
        label: 'Custom',
        value: format,
        description: 'Custom JSON schema',
      };
    }
    return PRESET_FORMATS[0];
  };

  const handlePresetChange = (value: string) => {
    const preset = PRESET_FORMATS.find(p => p.label === value);
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
    } catch (error) {
      // Handle JSON parse error
      console.error('Invalid JSON schema:', error);
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
            Schema Preview
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
            Response Format
          </span>
        </div>
      </div>

      <Select
        value={getCurrentPreset().label}
        onChange={e => handlePresetChange(e.target.value)}
        options={PRESET_FORMATS.map(preset => ({
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
              Apply Schema
            </Button>
            <Button
              onClick={() => {
                setShowCustom(false);
                setCustomSchema('');
              }}
              variant='outline'
              size='sm'
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {renderFormatPreview()}

      {format && (
        <div className='flex items-center text-xs text-green-600 dark:text-green-400'>
          <FileText className='h-3 w-3 mr-1' />
          Structured output enabled
        </div>
      )}
    </div>
  );
};

export default StructuredOutput;
