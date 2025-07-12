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

import React, { useState, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Persona } from '@/types';
import { Upload, Dna, AlertCircle, CheckCircle } from 'lucide-react';
import { personaApi } from '@/utils/api';
import toast from 'react-hot-toast';

interface PersonaDNAManagerProps {
  onPersonaImported?: (persona: Persona) => void;
}

const PersonaDNAManager: React.FC<PersonaDNAManagerProps> = ({
  onPersonaImported,
}) => {
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<Persona | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.name.endsWith('.dna') && !file.name.endsWith('.json')) {
      toast.error('Please select a .dna or .json file');
      return;
    }

    setIsImporting(true);
    setImportResult(null);

    try {
      const response = await personaApi.importPersonaDNA(file);

      if (response.success && response.data) {
        setImportResult(response.data);
        toast.success('Persona DNA imported successfully!');
        onPersonaImported?.(response.data);
      } else {
        toast.error(response.error || 'Failed to import persona DNA');
      }
    } catch (error) {
      toast.error('Failed to import persona DNA');
      console.error('Import error:', error);
    } finally {
      setIsImporting(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const resetImportState = () => {
    setImportResult(null);
  };

  return (
    <div className='bg-white dark:bg-dark-100 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-dark-300'>
      <div className='flex items-center gap-3 mb-6'>
        <div className='p-2 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg'>
          <Dna className='h-5 w-5 text-white' />
        </div>
        <div>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
            Persona DNA Manager
          </h3>
          <p className='text-sm text-gray-500 dark:text-dark-500'>
            Import complete persona packages with memories and state
          </p>
        </div>
      </div>

      {/* Import Section */}
      <div className='space-y-4'>
        <div className='border-2 border-dashed border-gray-300 dark:border-dark-300 rounded-lg p-6 text-center'>
          <Upload className='h-8 w-8 text-gray-400 mx-auto mb-3' />
          <h4 className='text-sm font-medium text-gray-900 dark:text-dark-800 mb-2'>
            Import Persona DNA
          </h4>
          <p className='text-xs text-gray-500 dark:text-dark-500 mb-4'>
            Select a .dna file to restore a complete persona with all its
            memories and learned behaviors
          </p>

          <Button
            onClick={handleFileSelect}
            disabled={isImporting}
            className='bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600'
          >
            {isImporting ? (
              <>
                <div className='animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2' />
                Importing...
              </>
            ) : (
              <>
                <Upload className='h-4 w-4 mr-2' />
                Select DNA File
              </>
            )}
          </Button>

          <input
            ref={fileInputRef}
            type='file'
            accept='.dna,.json'
            onChange={handleFileChange}
            className='hidden'
          />
        </div>

        {/* Import Result */}
        {importResult && (
          <div className='bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4'>
            <div className='flex items-start gap-3'>
              <CheckCircle className='h-5 w-5 text-green-500 mt-0.5' />
              <div className='flex-1'>
                <h4 className='text-sm font-medium text-green-800 dark:text-green-400 mb-2'>
                  Import Successful!
                </h4>
                <div className='text-sm text-green-700 dark:text-green-300 space-y-1'>
                  <p>
                    <strong>Name:</strong> {importResult.name}
                  </p>
                  <p>
                    <strong>Model:</strong> {importResult.model}
                  </p>
                  <p>
                    <strong>Embedding Model:</strong>{' '}
                    {importResult.embedding_model}
                  </p>
                  <div className='flex gap-4 mt-2'>
                    <span
                      className={`text-xs px-2 py-1 rounded ${
                        importResult.memory_settings?.enabled
                          ? 'bg-green-100 text-green-800 dark:bg-green-800/30 dark:text-green-400'
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-800/30 dark:text-gray-400'
                      }`}
                    >
                      Memory:{' '}
                      {importResult.memory_settings?.enabled
                        ? 'Enabled'
                        : 'Disabled'}
                    </span>
                    <span
                      className={`text-xs px-2 py-1 rounded ${
                        importResult.mutation_settings?.enabled
                          ? 'bg-primary-100 text-primary-800 dark:bg-primary-800/30 dark:text-primary-400'
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-800/30 dark:text-gray-400'
                      }`}
                    >
                      Adaptive Learning:{' '}
                      {importResult.mutation_settings?.enabled
                        ? 'Enabled'
                        : 'Disabled'}
                    </span>
                  </div>
                </div>
                <div className='mt-3'>
                  <Button
                    onClick={resetImportState}
                    variant='outline'
                    size='sm'
                    className='border-green-300 text-green-700 hover:bg-green-100 dark:border-green-600 dark:text-green-400 dark:hover:bg-green-800/20'
                  >
                    Import Another
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Information Section */}
        <div className='bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800 rounded-lg p-4'>
          <div className='flex items-start gap-3'>
            <AlertCircle className='h-5 w-5 text-primary-500 mt-0.5' />
            <div className='text-sm text-primary-700 dark:text-primary-300'>
              <h4 className='font-medium mb-2'>About Persona DNA</h4>
              <ul className='space-y-1 text-xs'>
                <li>
                  • Complete persona packages including configuration, memories,
                  and learned behaviors
                </li>
                <li>
                  • Maintains conversation context and personality adaptations
                </li>
                <li>
                  • Cross-compatible between different Libre WebUI instances
                </li>
                <li>• Includes integrity verification to ensure data safety</li>
              </ul>
            </div>
          </div>
        </div>

        {/* DNA Format Info */}
        <div className='text-xs text-gray-500 dark:text-dark-500 space-y-1'>
          <p>
            <strong>Supported formats:</strong> .dna (recommended), .json
          </p>
          <p>
            <strong>File size limit:</strong> 10MB
          </p>
          <p>
            <strong>Security:</strong> All DNA files are verified for integrity
            before import
          </p>
        </div>
      </div>
    </div>
  );
};

export { PersonaDNAManager };
export default PersonaDNAManager;
