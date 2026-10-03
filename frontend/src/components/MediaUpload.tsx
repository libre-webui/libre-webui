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

import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, X, FileText, File, Loader2 } from 'lucide-react';
import { documentsApi } from '@/utils/api';
import { DocumentSummary } from '@/types';
import { cn } from '@/utils';
import toast from 'react-hot-toast';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:media-upload');

interface MediaUploadProps {
  images: string[];
  onImagesChange: (images: string[]) => void;
  maxImages?: number;
  sessionId?: string;
  onDocumentUploaded?: (document: DocumentSummary) => void;
  disabled?: boolean;
  className?: string;
}

export const MediaUpload: React.FC<MediaUploadProps> = ({
  images,
  onImagesChange,
  maxImages = 5,
  sessionId,
  onDocumentUploaded,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);
  const [uploadedDocuments, setUploadedDocuments] = useState<DocumentSummary[]>(
    []
  );

  const handleFileSelect = async (files: FileList | null) => {
    if (!files || disabled) return;
    // Collect every image from this selection and report them in one call;
    // `images` is a stale closure once the first file has been read.
    // Snapshot first: resetting the input after the first await empties the
    // live FileList in place.
    const selection = Array.from(files);
    const collected: string[] = [];
    for (const file of selection) {
      // Check if it's an image
      if (file.type.startsWith('image/')) {
        const dataUrl = await handleImageFile(
          file,
          maxImages - images.length - collected.length
        );
        if (dataUrl) collected.push(dataUrl);
      }
      // Check if it's a document (PDF or TXT)
      else if (file.type.includes('pdf') || file.type.includes('text')) {
        await handleDocumentFile(file);
      } else {
        toast.error(
          t('chat.mediaUpload.unsupportedFileType', { name: file.name })
        );
      }
    }
    if (collected.length > 0) {
      onImagesChange([...images, ...collected]);
    }
  };

  const handleImageFile = (
    file: File,
    remainingSlots: number
  ): Promise<string | null> => {
    if (remainingSlots <= 0) {
      toast.error(t('chat.mediaUpload.maxImagesAllowed', { count: maxImages }));
      return Promise.resolve(null);
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('chat.mediaUpload.imageTooLarge', { name: file.name }));
      return Promise.resolve(null);
    }

    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => {
        toast.error(t('chat.mediaUpload.readFailed', { name: file.name }));
        resolve(null);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleDocumentFile = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('documents.fileSizeTooLarge'));
      return;
    }

    setIsUploadingDoc(true);

    try {
      const response = await documentsApi.uploadDocument(file, sessionId);

      if (response.success && response.data) {
        const document = response.data;
        setUploadedDocuments(prev => [...prev, document]);
        onDocumentUploaded?.(document);
        toast.success(
          t('documents.uploadSuccessWithName', { name: file.name })
        );
      } else {
        toast.error(response.error || t('documents.uploadFailed'));
      }
    } catch (error) {
      logger.error('Document upload error:', error);
      toast.error(t('documents.uploadFailed'));
    } finally {
      setIsUploadingDoc(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) {
      setDragActive(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (!disabled) {
      void handleFileSelect(e.dataTransfer.files);
    }
  };

  const removeImage = (index: number) => {
    const newImages = images.filter((_, i) => i !== index);
    onImagesChange(newImages);
  };

  const handleRemoveDocument = async (documentId: string) => {
    try {
      const response = await documentsApi.deleteDocument(documentId);
      if (response.success) {
        setUploadedDocuments(prev => prev.filter(doc => doc.id !== documentId));
        toast.success(t('documents.removeSuccess'));
      } else {
        toast.error(response.error || t('documents.removeFailed'));
      }
    } catch (error) {
      logger.error('Error removing document:', error);
      toast.error(t('documents.removeFailed'));
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const hasContent = images.length > 0 || uploadedDocuments.length > 0;

  return (
    <div className={cn('space-y-3', className)}>
      {/* Unified Upload Area */}
      <div
        className={cn(
          'border-2 border-dashed rounded-xl p-6 transition-all duration-200 cursor-pointer',
          'border-gray-300 dark:border-gray-600',
          'hover:border-primary-400 dark:hover:border-primary-500',
          dragActive &&
            'border-primary-500 dark:border-primary-400 bg-primary-50/50 dark:bg-primary-900/10',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role='button'
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-label={`${t('chat.mediaUpload.dropImagesHere')} ${t('chat.mediaUpload.browse')}`}
        onClick={() => !disabled && fileInputRef.current?.click()}
        onKeyDown={e => {
          if (
            e.target === e.currentTarget &&
            (e.key === 'Enter' || e.key === ' ')
          ) {
            e.preventDefault();
            if (!disabled) fileInputRef.current?.click();
          }
        }}
      >
        <input
          ref={fileInputRef}
          type='file'
          multiple
          accept='image/*,.pdf,.txt'
          onChange={e => {
            void handleFileSelect(e.target.files);
            // Clear input to allow re-selecting same file
            e.target.value = '';
          }}
          className='hidden'
          disabled={disabled}
        />

        <div className='flex flex-col items-center text-center'>
          {isUploadingDoc ? (
            <Loader2
              className='h-8 w-8 text-gray-400 dark:text-gray-500 mb-2 animate-spin'
              role='status'
              aria-label={t('chat.mediaUpload.uploading')}
            />
          ) : (
            <Upload
              className='h-8 w-8 text-gray-400 dark:text-gray-500 mb-2'
              aria-hidden='true'
            />
          )}
          <p className='text-sm text-gray-700 dark:text-gray-300'>
            {t('chat.mediaUpload.dropImagesHere')}{' '}
            <span className='text-primary-600 dark:text-primary-400 font-medium'>
              {t('chat.mediaUpload.browse')}
            </span>
          </p>
          <p className='text-xs text-ink-muted mt-1'>
            {t('chat.mediaUpload.supportedFormats')}
          </p>
        </div>
      </div>

      {/* Preview Grid - Images and Documents Combined */}
      {hasContent && (
        <div className='flex flex-wrap gap-2'>
          {/* Image Previews */}
          {images.map((image, index) => (
            <div
              key={`img-${index}`}
              className='relative group w-16 h-16 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700'
            >
              <img
                src={image}
                alt={t('chat.mediaUpload.uploadAlt', { number: index + 1 })}
                className='w-full h-full object-cover'
              />
              <button
                type='button'
                onClick={e => {
                  e.stopPropagation();
                  removeImage(index);
                }}
                aria-label={t('chat.mediaUpload.removeImage', {
                  number: index + 1,
                })}
                className='absolute top-0.5 inset-e-0.5 p-0.5 rounded-full bg-black/60 hover:bg-black/80 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity'
              >
                <X className='h-3 w-3' aria-hidden='true' />
              </button>
            </div>
          ))}

          {/* Document Previews */}
          {uploadedDocuments.map(doc => (
            <div
              key={doc.id}
              className='relative group flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700'
            >
              {doc.fileType === 'pdf' ? (
                <FileText className='w-4 h-4 text-red-500 shrink-0' />
              ) : (
                <File className='w-4 h-4 text-blue-500 shrink-0' />
              )}
              <div className='min-w-0'>
                <p className='text-xs font-medium text-gray-900 dark:text-gray-100 truncate max-w-[100px]'>
                  {doc.filename}
                </p>
                <p className='text-[10px] text-ink-muted'>
                  {formatFileSize(doc.size)}
                </p>
              </div>
              <button
                type='button'
                onClick={e => {
                  e.stopPropagation();
                  handleRemoveDocument(doc.id);
                }}
                aria-label={t('chat.mediaUpload.removeDocument', {
                  name: doc.filename,
                })}
                className='p-0.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 hover:text-red-500 transition-colors'
              >
                <X className='h-3 w-3' aria-hidden='true' />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MediaUpload;
