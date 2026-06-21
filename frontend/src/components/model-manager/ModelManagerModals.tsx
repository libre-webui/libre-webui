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
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Copy, FileCode, RefreshCw, TestTube, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils';
import type { ModelDetails } from './types';

type StringSetter = React.Dispatch<React.SetStateAction<string>>;

interface ModelOption {
  name: string;
}

interface ModelManagerModalsProps {
  models: ModelOption[];
  showDetailsModal: boolean;
  setShowDetailsModal: React.Dispatch<React.SetStateAction<boolean>>;
  selectedModelName: string;
  selectedModelDetails: ModelDetails | null;
  loadingDetails: boolean;
  showCopyModal: boolean;
  setShowCopyModal: React.Dispatch<React.SetStateAction<boolean>>;
  copySource: string;
  setCopySource: StringSetter;
  copyDestination: string;
  setCopyDestination: StringSetter;
  copying: boolean;
  handleCopyModel: () => void;
  showCreateModal: boolean;
  setShowCreateModal: React.Dispatch<React.SetStateAction<boolean>>;
  createModelName: string;
  setCreateModelName: StringSetter;
  createModelfile: string;
  setCreateModelfile: StringSetter;
  creating: boolean;
  handleCreateModel: () => void;
  showEmbeddingsModal: boolean;
  setShowEmbeddingsModal: React.Dispatch<React.SetStateAction<boolean>>;
  embeddingsModel: string;
  setEmbeddingsModel: StringSetter;
  embeddingsInput: string;
  setEmbeddingsInput: StringSetter;
  embeddingsResult: number[] | null;
  generatingEmbeddings: boolean;
  handleGenerateEmbeddings: () => void;
}

export const ModelManagerModals: React.FC<ModelManagerModalsProps> = ({
  models,
  showDetailsModal,
  setShowDetailsModal,
  selectedModelName,
  selectedModelDetails,
  loadingDetails,
  showCopyModal,
  setShowCopyModal,
  copySource,
  setCopySource,
  copyDestination,
  setCopyDestination,
  copying,
  handleCopyModel,
  showCreateModal,
  setShowCreateModal,
  createModelName,
  setCreateModelName,
  createModelfile,
  setCreateModelfile,
  creating,
  handleCreateModel,
  showEmbeddingsModal,
  setShowEmbeddingsModal,
  embeddingsModel,
  setEmbeddingsModel,
  embeddingsInput,
  setEmbeddingsInput,
  embeddingsResult,
  generatingEmbeddings,
  handleGenerateEmbeddings,
}) => {
  const { t } = useTranslation();

  return (
    <>
      {showDetailsModal &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-4'>
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setShowDetailsModal(false)}
            />
            <div
              className={cn(
                'relative w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-xl border shadow-2xl',
                'bg-white dark:bg-dark-100',
                'border-gray-200 dark:border-dark-300'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between p-4 border-b',
                  'border-gray-200 dark:border-dark-300'
                )}
              >
                <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                  {t('modelManager.modals.details.title')}: {selectedModelName}
                </h3>
                <button
                  onClick={() => setShowDetailsModal(false)}
                  className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200'
                >
                  <X className='h-5 w-5 text-gray-500' />
                </button>
              </div>

              <div className='overflow-y-auto max-h-[calc(85vh-60px)] p-4 space-y-4'>
                {loadingDetails ? (
                  <div className='flex items-center justify-center py-8'>
                    <RefreshCw className='h-6 w-6 animate-spin text-gray-400' />
                  </div>
                ) : selectedModelDetails ? (
                  <>
                    {selectedModelDetails.details && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          {t('modelManager.modals.details.info')}
                        </h4>
                        <div
                          className={cn(
                            'p-3 rounded-lg text-sm',
                            'bg-gray-50 dark:bg-dark-50'
                          )}
                        >
                          <div className='grid grid-cols-2 gap-2'>
                            {selectedModelDetails.details.family && (
                              <div>
                                <span className='text-gray-500'>
                                  {t('modelManager.modals.details.family')}:
                                </span>{' '}
                                <span className='text-gray-900 dark:text-gray-100'>
                                  {selectedModelDetails.details.family}
                                </span>
                              </div>
                            )}
                            {selectedModelDetails.details.parameter_size && (
                              <div>
                                <span className='text-gray-500'>
                                  {t('modelManager.modals.details.parameters')}:
                                </span>{' '}
                                <span className='text-gray-900 dark:text-gray-100'>
                                  {selectedModelDetails.details.parameter_size}
                                </span>
                              </div>
                            )}
                            {selectedModelDetails.details
                              .quantization_level && (
                              <div>
                                <span className='text-gray-500'>
                                  {t(
                                    'modelManager.modals.details.quantization'
                                  )}
                                  :
                                </span>{' '}
                                <span className='text-gray-900 dark:text-gray-100'>
                                  {
                                    selectedModelDetails.details
                                      .quantization_level
                                  }
                                </span>
                              </div>
                            )}
                            {selectedModelDetails.details.format && (
                              <div>
                                <span className='text-gray-500'>
                                  {t('modelManager.modals.details.format')}:
                                </span>{' '}
                                <span className='text-gray-900 dark:text-gray-100'>
                                  {selectedModelDetails.details.format}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {selectedModelDetails.system && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          {t('modelManager.modals.details.systemPrompt')}
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto',
                            'bg-gray-50 dark:bg-dark-50',
                            'text-gray-700 dark:text-gray-300'
                          )}
                        >
                          {selectedModelDetails.system}
                        </pre>
                      </div>
                    )}

                    {selectedModelDetails.template && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          {t('modelManager.modals.details.template')}
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto max-h-40',
                            'bg-gray-50 dark:bg-dark-50',
                            'text-gray-700 dark:text-gray-300'
                          )}
                        >
                          {selectedModelDetails.template}
                        </pre>
                      </div>
                    )}

                    {selectedModelDetails.parameters && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          {t('modelManager.modals.details.parameters')}
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto',
                            'bg-gray-50 dark:bg-dark-50',
                            'text-gray-700 dark:text-gray-300'
                          )}
                        >
                          {selectedModelDetails.parameters}
                        </pre>
                      </div>
                    )}

                    {selectedModelDetails.license && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          {t('modelManager.modals.details.license')}
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto max-h-32',
                            'bg-gray-50 dark:bg-dark-50',
                            'text-gray-700 dark:text-gray-300'
                          )}
                        >
                          {selectedModelDetails.license}
                        </pre>
                      </div>
                    )}

                    {selectedModelDetails.modelfile && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          {t('modelManager.modals.details.modelfile')}
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto max-h-60',
                            'bg-gray-50 dark:bg-dark-50',
                            'text-gray-700 dark:text-gray-300'
                          )}
                        >
                          {selectedModelDetails.modelfile}
                        </pre>
                      </div>
                    )}
                  </>
                ) : (
                  <p className='text-center text-gray-500'>
                    {t('modelManager.modals.details.noDetails')}
                  </p>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

      {showCopyModal &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-4'>
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setShowCopyModal(false)}
            />
            <div
              className={cn(
                'relative w-full max-w-md rounded-xl border shadow-2xl',
                'bg-white dark:bg-dark-100',
                'border-gray-200 dark:border-dark-300'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between p-4 border-b',
                  'border-gray-200 dark:border-dark-300'
                )}
              >
                <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                  {t('modelManager.modals.copy.title')}
                </h3>
                <button
                  onClick={() => setShowCopyModal(false)}
                  className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200'
                >
                  <X className='h-5 w-5 text-gray-500' />
                </button>
              </div>

              <div className='p-4 space-y-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('modelManager.modals.copy.source')}
                  </label>
                  <select
                    value={copySource}
                    onChange={e => setCopySource(e.target.value)}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50',
                      'border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100'
                    )}
                  >
                    <option value=''>
                      {t('modelManager.modals.copy.selectModel')}
                    </option>
                    {models.map(model => (
                      <option key={model.name} value={model.name}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('modelManager.modals.copy.newName')}
                  </label>
                  <input
                    type='text'
                    value={copyDestination}
                    onChange={e => setCopyDestination(e.target.value)}
                    placeholder={t('modelManager.modals.copy.placeholder')}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50',
                      'border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100',
                      'placeholder-gray-500'
                    )}
                  />
                </div>

                <Button
                  onClick={handleCopyModel}
                  disabled={
                    !copySource.trim() || !copyDestination.trim() || copying
                  }
                  className={cn('w-full gap-2', '')}
                >
                  {copying ? (
                    <RefreshCw className='h-4 w-4 animate-spin' />
                  ) : (
                    <Copy className='h-4 w-4' />
                  )}
                  {copying
                    ? t('modelManager.modals.copy.copying')
                    : t('modelManager.modals.copy.button')}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {showCreateModal &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-4'>
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setShowCreateModal(false)}
            />
            <div
              className={cn(
                'relative w-full max-w-lg rounded-xl border shadow-2xl',
                'bg-white dark:bg-dark-100',
                'border-gray-200 dark:border-dark-300'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between p-4 border-b',
                  'border-gray-200 dark:border-dark-300'
                )}
              >
                <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                  {t('modelManager.modals.create.title')}
                </h3>
                <button
                  onClick={() => setShowCreateModal(false)}
                  className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200'
                >
                  <X className='h-5 w-5 text-gray-500' />
                </button>
              </div>

              <div className='p-4 space-y-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('modelManager.modals.create.name')}
                  </label>
                  <input
                    type='text'
                    value={createModelName}
                    onChange={e => setCreateModelName(e.target.value)}
                    placeholder={t(
                      'modelManager.modals.create.namePlaceholder'
                    )}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50',
                      'border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100',
                      'placeholder-gray-500'
                    )}
                  />
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('modelManager.modals.create.modelfile')}
                  </label>
                  <textarea
                    value={createModelfile}
                    onChange={e => setCreateModelfile(e.target.value)}
                    placeholder={t(
                      'modelManager.modals.create.modelfilePlaceholder'
                    )}
                    rows={8}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm font-mono',
                      'bg-gray-50 dark:bg-dark-50',
                      'border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100',
                      'placeholder-gray-500',
                      'resize-none'
                    )}
                  />
                  <p className='mt-1 text-xs text-gray-500'>
                    {t('modelManager.modals.create.see')}{' '}
                    <a
                      href='https://github.com/ollama/ollama/blob/main/docs/modelfile.md'
                      target='_blank'
                      rel='noopener noreferrer'
                      className='text-primary-600 hover:underline'
                    >
                      {t('modelManager.modals.create.docs')}
                    </a>{' '}
                    {t('modelManager.modals.create.docsLink')}
                  </p>
                </div>

                <Button
                  onClick={handleCreateModel}
                  disabled={
                    !createModelName.trim() ||
                    !createModelfile.trim() ||
                    creating
                  }
                  className={cn('w-full gap-2', '')}
                >
                  {creating ? (
                    <RefreshCw className='h-4 w-4 animate-spin' />
                  ) : (
                    <FileCode className='h-4 w-4' />
                  )}
                  {creating
                    ? t('modelManager.modals.create.creating')
                    : t('modelManager.modals.create.button')}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {showEmbeddingsModal &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-4'>
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setShowEmbeddingsModal(false)}
            />
            <div
              className={cn(
                'relative w-full max-w-lg rounded-xl border shadow-2xl',
                'bg-white dark:bg-dark-100',
                'border-gray-200 dark:border-dark-300'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between p-4 border-b',
                  'border-gray-200 dark:border-dark-300'
                )}
              >
                <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                  {t('modelManager.modals.embeddings.title')}
                </h3>
                <button
                  onClick={() => setShowEmbeddingsModal(false)}
                  className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200'
                >
                  <X className='h-5 w-5 text-gray-500' />
                </button>
              </div>

              <div className='p-4 space-y-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('modelManager.modals.embeddings.model')}
                  </label>
                  <select
                    value={embeddingsModel}
                    onChange={e => setEmbeddingsModel(e.target.value)}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50',
                      'border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100'
                    )}
                  >
                    <option value=''>
                      {t('modelManager.modals.embeddings.selectModel')}
                    </option>
                    {models.map(model => (
                      <option key={model.name} value={model.name}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <p className='mt-1 text-xs text-gray-500'>
                    {t('modelManager.modals.embeddings.recommended')}
                  </p>
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('modelManager.modals.embeddings.input')}
                  </label>
                  <textarea
                    value={embeddingsInput}
                    onChange={e => setEmbeddingsInput(e.target.value)}
                    placeholder={t(
                      'modelManager.modals.embeddings.placeholder'
                    )}
                    rows={3}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50',
                      'border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100',
                      'placeholder-gray-500',
                      'resize-none'
                    )}
                  />
                </div>

                <Button
                  onClick={handleGenerateEmbeddings}
                  disabled={
                    !embeddingsModel.trim() ||
                    !embeddingsInput.trim() ||
                    generatingEmbeddings
                  }
                  className={cn('w-full gap-2', '')}
                >
                  {generatingEmbeddings ? (
                    <RefreshCw className='h-4 w-4 animate-spin' />
                  ) : (
                    <TestTube className='h-4 w-4' />
                  )}
                  {generatingEmbeddings
                    ? t('modelManager.modals.embeddings.generating')
                    : t('modelManager.modals.embeddings.button')}
                </Button>

                {embeddingsResult && (
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                      {t('modelManager.modals.embeddings.result', {
                        count: embeddingsResult.length,
                      })}
                    </label>
                    <pre
                      className={cn(
                        'p-3 rounded-lg text-xs overflow-x-auto max-h-32',
                        'bg-gray-50 dark:bg-dark-50',
                        'text-gray-700 dark:text-gray-300'
                      )}
                    >
                      [{embeddingsResult.slice(0, 10).join(', ')}
                      {embeddingsResult.length > 10 && ', ...'} ]
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

export default ModelManagerModals;
