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
import { Button } from '@/components/ui/Button';
import { personaApi } from '@/utils/api';
import { Persona } from '@/types';
import toast from 'react-hot-toast';

interface PersonaImportExportProps {
  personas: Persona[];
  onImport: () => void;
  onClose: () => void;
}

const PersonaImportExport: React.FC<PersonaImportExportProps> = ({
  personas,
  onImport,
  onClose,
}) => {
  const [importing, setImporting] = useState(false);
  const [importData, setImportData] = useState('');

  const handleExport = async (persona: Persona) => {
    try {
      const exportData = await personaApi.exportPersona(persona.id);

      // Create and trigger download
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${persona.name}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Persona "${persona.name}" exported successfully`);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to export persona: ' + errorMessage);
    }
  };

  const handleExportAll = async () => {
    try {
      const exportPromises = personas.map(persona =>
        personaApi.exportPersona(persona.id)
      );
      const exportResults = await Promise.all(exportPromises);

      // Create combined export
      const combinedExport = {
        personas: exportResults,
        exportedAt: Date.now(),
        version: '1.0.0',
        count: exportResults.length,
      };

      const blob = new Blob([JSON.stringify(combinedExport, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `personas-export-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`All ${personas.length} personas exported successfully`);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to export personas: ' + errorMessage);
    }
  };

  const handleImport = async () => {
    if (!importData.trim()) {
      toast.error('Please paste the persona JSON data');
      return;
    }

    setImporting(true);
    try {
      const data = JSON.parse(importData);

      // Check if it's a single persona or multiple personas
      if (data.personas && Array.isArray(data.personas)) {
        // Multiple personas import
        let successCount = 0;
        let failCount = 0;

        for (const personaData of data.personas) {
          try {
            await personaApi.importPersona(personaData);
            successCount++;
          } catch (error) {
            failCount++;
            console.error('Failed to import persona:', error);
          }
        }

        if (successCount > 0) {
          toast.success(`Successfully imported ${successCount} personas`);
          if (failCount > 0) {
            toast.error(`Failed to import ${failCount} personas`);
          }
        } else {
          toast.error('Failed to import any personas');
        }
      } else {
        // Single persona import
        await personaApi.importPersona(data);
        toast.success('Persona imported successfully');
      }

      setImportData('');
      onImport();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to import persona: ' + errorMessage);
    } finally {
      setImporting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = event => {
        const result = event.target?.result;
        if (typeof result === 'string') {
          setImportData(result);
        }
      };
      reader.readAsText(file);
    }
  };

  return (
    <div className='max-w-4xl mx-auto'>
      <div className='mb-6'>
        <h1 className='text-2xl font-bold text-gray-900 dark:text-dark-800'>
          Import & Export Personas
        </h1>
        <p className='text-gray-600 dark:text-dark-600 mt-1'>
          Export your personas to share them or import personas from others
        </p>
      </div>

      <div className='grid grid-cols-1 lg:grid-cols-2 gap-6'>
        {/* Export Section */}
        <div className='bg-white dark:bg-dark-100 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-dark-300'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 mb-4'>
            Export Personas
          </h3>

          {personas.length === 0 ? (
            <p className='text-gray-600 dark:text-dark-600 text-center py-8'>
              No personas to export
            </p>
          ) : (
            <div className='space-y-4'>
              <div className='flex justify-between items-center'>
                <span className='text-sm text-gray-600 dark:text-dark-600'>
                  {personas.length} persona{personas.length !== 1 ? 's' : ''}{' '}
                  available
                </span>
                <Button
                  onClick={handleExportAll}
                  variant='outline'
                  size='sm'
                  className='px-3 py-1'
                >
                  Export All
                </Button>
              </div>

              <div className='space-y-2 max-h-80 overflow-y-auto'>
                {personas.map(persona => (
                  <div
                    key={persona.id}
                    className='flex items-center justify-between p-3 bg-gray-50 dark:bg-dark-200 rounded-md'
                  >
                    <div className='flex items-center gap-3'>
                      <img
                        src={
                          persona.avatar ||
                          `https://ui-avatars.com/api/?name=${encodeURIComponent(persona.name)}&background=6366f1&color=fff&size=32`
                        }
                        alt={persona.name}
                        className='w-8 h-8 rounded-full'
                      />
                      <div>
                        <div className='font-medium text-gray-900 dark:text-dark-800'>
                          {persona.name}
                        </div>
                        <div className='text-sm text-gray-500 dark:text-dark-500'>
                          {persona.model}
                        </div>
                      </div>
                    </div>
                    <Button
                      onClick={() => handleExport(persona)}
                      variant='outline'
                      size='sm'
                      className='px-3 py-1'
                    >
                      Export
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Import Section */}
        <div className='bg-white dark:bg-dark-100 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-dark-300'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 mb-4'>
            Import Personas
          </h3>

          <div className='space-y-4'>
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Upload JSON File
              </label>
              <input
                type='file'
                accept='.json'
                onChange={handleFileUpload}
                className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
              />
            </div>

            <div className='text-center text-gray-500 dark:text-dark-500'>
              OR
            </div>

            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Paste JSON Data
              </label>
              <textarea
                value={importData}
                onChange={e => setImportData(e.target.value)}
                className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
                rows={8}
                placeholder='Paste persona JSON data here...'
              />
            </div>

            <Button
              onClick={handleImport}
              disabled={!importData.trim() || importing}
              className='w-full'
            >
              {importing ? 'Importing...' : 'Import Persona(s)'}
            </Button>
          </div>
        </div>
      </div>

      {/* JSON Format Example */}
      <div className='mt-6 bg-gray-50 dark:bg-dark-200 rounded-lg p-4'>
        <h4 className='text-sm font-medium text-gray-900 dark:text-dark-800 mb-2'>
          Expected JSON Format:
        </h4>
        <pre className='text-xs text-gray-600 dark:text-dark-600 overflow-x-auto'>
          {`{
  "name": "Assistant",
  "description": "Playful assistant with emotional depth",
  "model": "llama3.3:latest",
  "params": {
    "temperature": 0.8,
    "top_p": 0.9,
    "context_window": 4096,
    "system_prompt": "You are a clever and cheeky assistant..."
  },
  "avatar": "/images/ophelia.png",
  "background": "/backgrounds/cosmos.png"
}`}
        </pre>
      </div>

      {/* Actions */}
      <div className='mt-6 flex justify-end'>
        <Button onClick={onClose} variant='outline'>
          Close
        </Button>
      </div>
    </div>
  );
};

export { PersonaImportExport };
export default PersonaImportExport;
