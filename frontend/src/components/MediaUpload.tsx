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

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Check if it's an image
      if (file.type.startsWith('image/')) {
        await handleImageFile(file);
      }
      // Check if it's a document (PDF or TXT)
      else if (file.type.includes('pdf') || file.type.includes('text')) {
        await handleDocumentFile(file);
      } else {
        toast.error(`File type not supported: ${file.name}`);
      }
    }
  };

  const handleImageFile = async (file: File) => {
    const remainingSlots = maxImages - images.length;

    if (remainingSlots <= 0) {
      toast.error(`Maximum ${maxImages} images allowed`);
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error(`Image ${file.name} is too large (max 10MB)`);
      return;
    }

    const reader = new FileReader();
    reader.onload = e => {
      if (e.target?.result) {
        onImagesChange([...images, e.target.result as string]);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDocumentFile = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File size must be less than 10MB');
      return;
    }

    setIsUploadingDoc(true);

    try {
      const response = await documentsApi.uploadDocument(file, sessionId);

      if (response.success && response.data) {
        const document = response.data;
        setUploadedDocuments(prev => [...prev, document]);
        onDocumentUploaded?.(document);
        toast.success(`Document "${file.name}" uploaded`);
      } else {
        toast.error(response.error || 'Failed to upload document');
      }
    } catch (error) {
      console.error('Document upload error:', error);
      toast.error('Failed to upload document');
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
      handleFileSelect(e.dataTransfer.files);
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
        toast.success('Document removed');
      } else {
        toast.error(response.error || 'Failed to remove document');
      }
    } catch (error) {
      console.error('Error removing document:', error);
      toast.error('Failed to remove document');
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
          'border-gray-300 dark:border-gray-600 ophelia:border-[#3f3f46]',
          'hover:border-primary-400 dark:hover:border-primary-500 ophelia:hover:border-[#9333ea]',
          dragActive &&
            'border-primary-500 dark:border-primary-400 ophelia:border-[#a855f7] bg-primary-50/50 dark:bg-primary-900/10 ophelia:bg-[#9333ea]/10',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type='file'
          multiple
          accept='image/*,.pdf,.txt'
          onChange={e => {
            handleFileSelect(e.target.files);
            // Clear input to allow re-selecting same file
            e.target.value = '';
          }}
          className='hidden'
          disabled={disabled}
        />

        <div className='flex flex-col items-center text-center'>
          {isUploadingDoc ? (
            <Loader2 className='h-8 w-8 text-gray-400 dark:text-gray-500 ophelia:text-[#737373] mb-2 animate-spin' />
          ) : (
            <Upload className='h-8 w-8 text-gray-400 dark:text-gray-500 ophelia:text-[#737373] mb-2' />
          )}
          <p className='text-sm text-gray-700 dark:text-gray-300 ophelia:text-[#d4d4d4]'>
            {t('chat.mediaUpload.dropImagesHere')}{' '}
            <span className='text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7] font-medium'>
              {t('chat.mediaUpload.browse')}
            </span>
          </p>
          <p className='text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#737373] mt-1'>
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
              className='relative group w-16 h-16 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 ophelia:bg-[#1a1a1a] border border-gray-200 dark:border-gray-700 ophelia:border-[#262626]'
            >
              <img
                src={image}
                alt={`Upload ${index + 1}`}
                className='w-full h-full object-cover'
              />
              <button
                onClick={e => {
                  e.stopPropagation();
                  removeImage(index);
                }}
                className='absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/60 hover:bg-black/80 text-white opacity-0 group-hover:opacity-100 transition-opacity'
              >
                <X className='h-3 w-3' />
              </button>
            </div>
          ))}

          {/* Document Previews */}
          {uploadedDocuments.map(doc => (
            <div
              key={doc.id}
              className='relative group flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 ophelia:bg-[#1a1a1a] border border-gray-200 dark:border-gray-700 ophelia:border-[#262626]'
            >
              {doc.fileType === 'pdf' ? (
                <FileText className='w-4 h-4 text-red-500 flex-shrink-0' />
              ) : (
                <File className='w-4 h-4 text-blue-500 flex-shrink-0' />
              )}
              <div className='min-w-0'>
                <p className='text-xs font-medium text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] truncate max-w-[100px]'>
                  {doc.filename}
                </p>
                <p className='text-[10px] text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
                  {formatFileSize(doc.size)}
                </p>
              </div>
              <button
                onClick={e => {
                  e.stopPropagation();
                  handleRemoveDocument(doc.id);
                }}
                className='p-0.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 ophelia:hover:bg-[#262626] text-gray-500 hover:text-red-500 transition-colors'
              >
                <X className='h-3 w-3' />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MediaUpload;
