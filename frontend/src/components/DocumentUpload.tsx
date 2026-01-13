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
import { useTranslation } from 'react-i18next';
import { Upload, FileText, Loader2, X, File } from 'lucide-react';
import { documentsApi } from '@/utils/api';
import { DocumentSummary } from '@/types';
import toast from 'react-hot-toast';

interface DocumentUploadProps {
  sessionId?: string;
  onDocumentUploaded?: (document: DocumentSummary) => void;
  disabled?: boolean;
}

export const DocumentUpload: React.FC<DocumentUploadProps> = ({
  sessionId,
  onDocumentUploaded,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadedDocuments, setUploadedDocuments] = useState<DocumentSummary[]>(
    []
  );
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const file = files[0];

    // Validate file type
    if (!file.type.includes('pdf') && !file.type.includes('text')) {
      toast.error(t('documents.unsupportedFileType'));
      return;
    }

    // Validate file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('documents.fileSizeTooLarge'));
      return;
    }

    setIsUploading(true);

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
      console.error('Document upload error:', error);
      toast.error(t('documents.uploadFailed'));
    } finally {
      setIsUploading(false);
      // Clear the file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      setDragActive(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (disabled) return;

    const files = e.dataTransfer.files;
    handleFileUpload(files);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileUpload(e.target.files);
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
      console.error('Error removing document:', error);
      toast.error(t('documents.removeError'));
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className='space-y-3'>
      {/* Upload Area */}
      <div
        className={`
          border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors
          ${dragActive ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-300 dark:border-gray-600'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-gray-400 dark:hover:border-gray-500'}
        `}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type='file'
          accept='.pdf,.txt'
          onChange={handleFileInputChange}
          className='hidden'
          disabled={disabled}
        />

        {isUploading ? (
          <div className='flex items-center justify-center space-x-2'>
            <Loader2 className='w-5 h-5 animate-spin' />
            <span className='text-sm text-gray-600 dark:text-gray-400'>
              {t('documents.uploading')}
            </span>
          </div>
        ) : (
          <div className='space-y-2'>
            <Upload className='w-8 h-8 mx-auto text-gray-400' />
            <div className='text-sm text-gray-600 dark:text-gray-400'>
              <span className='font-medium'>
                {t('documents.clickToUpload')}
              </span>{' '}
              {t('documents.orDragAndDrop')}
            </div>
            <div className='text-xs text-gray-500 dark:text-gray-500'>
              {t('documents.fileTypesAndSize')}
            </div>
          </div>
        )}
      </div>

      {/* Uploaded Documents */}
      {uploadedDocuments.length > 0 && (
        <div className='space-y-2'>
          <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
            {t('documents.uploadedDocuments')}
          </h4>
          <div className='space-y-2'>
            {uploadedDocuments.map(doc => (
              <div
                key={doc.id}
                className='flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded-lg'
              >
                <div className='flex items-center space-x-2 flex-1 min-w-0'>
                  {doc.fileType === 'pdf' ? (
                    <FileText className='w-4 h-4 text-red-500' />
                  ) : (
                    <File className='w-4 h-4 text-blue-500' />
                  )}
                  <div className='flex-1 min-w-0'>
                    <p className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                      {doc.filename}
                    </p>
                    <p className='text-xs text-gray-500 dark:text-gray-400'>
                      {formatFileSize(doc.size)} • {doc.fileType.toUpperCase()}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleRemoveDocument(doc.id)}
                  className='p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors'
                  title={t('documents.removeDocument')}
                >
                  <X className='w-4 h-4 text-gray-500' />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default DocumentUpload;
