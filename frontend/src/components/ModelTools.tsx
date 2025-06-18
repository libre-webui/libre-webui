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
import { Button, Input, Textarea } from '@/components/ui';
import { ollamaApi } from '@/utils/api';
import { useChatStore } from '@/store/chatStore';
import { RunningModel, OllamaModel } from '@/types';
import toast from 'react-hot-toast';

export const ModelTools: React.FC = () => {
  const { selectedModel } = useChatStore();
  const [info, setInfo] = useState<OllamaModel | null>(null);
  const [createModelName, setCreateModelName] = useState('');
  const [createFile, setCreateFile] = useState('');
  const [copySrc, setCopySrc] = useState('');
  const [copyDest, setCopyDest] = useState('');
  const [embedText, setEmbedText] = useState('');
  const [running, setRunning] = useState<RunningModel[]>([]);
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);

  const handleShowInfo = async () => {
    if (!selectedModel) return;
    setLoading(true);
    try {
      const res = await ollamaApi.showModel(selectedModel, true);
      if (res.success) {
        setInfo(res.data || null);
      } else {
        toast.error(res.error || 'Failed to fetch info');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(errorMessage);
    }
    setLoading(false);
  };

  const handlePush = async () => {
    if (!selectedModel) return;
    setLoading(true);
    try {
      const res = await ollamaApi.pushModel(selectedModel);
      if (res.success) {
        toast.success('Model pushed');
      } else {
        toast.error(res.error || 'Failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(errorMessage);
    }
    setLoading(false);
  };

  const handleCreate = async () => {
    if (!createModelName || !createFile) return;
    setLoading(true);
    try {
      const res = await ollamaApi.createModel({
        model: createModelName,
        name: createModelName,
        modelfile: createFile,
      });
      if (res.success) {
        toast.success('Model created');
      } else {
        toast.error(res.error || 'Failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(errorMessage);
    }
    setLoading(false);
  };

  const handleCopy = async () => {
    if (!copySrc || !copyDest) return;
    setLoading(true);
    try {
      const res = await ollamaApi.copyModel(copySrc, copyDest);
      if (res.success) {
        toast.success('Model copied');
      } else {
        toast.error(res.error || 'Failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(errorMessage);
    }
    setLoading(false);
  };

  const handleEmbed = async () => {
    if (!embedText || !selectedModel) return;
    setLoading(true);
    try {
      const res = await ollamaApi.generateEmbeddings({
        model: selectedModel,
        prompt: embedText,
      });
      if (res.success) {
        toast.success('Embeddings generated (see console)');
        console.log('Embeddings:', res.data);
      } else {
        toast.error(res.error || 'Failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(errorMessage);
    }
    setLoading(false);
  };

  const handleRunning = async () => {
    setLoading(true);
    try {
      const res = await ollamaApi.listRunningModels();
      if (res.success) {
        setRunning(res.data || []);
      } else {
        toast.error(res.error || 'Failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(errorMessage);
    }
    setLoading(false);
  };

  const handleVersion = async () => {
    setLoading(true);
    try {
      const res = await ollamaApi.getVersion();
      if (res.success && res.data) {
        setVersion(res.data.version);
      } else {
        toast.error(res.error || 'Failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(errorMessage);
    }
    setLoading(false);
  };

  return (
    <div className='space-y-4 mt-6'>
      <h4 className='text-sm font-semibold text-gray-900 dark:text-dark-800'>
        Model Tools (Beta)
      </h4>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          variant='outline'
          onClick={handleShowInfo}
          disabled={!selectedModel || loading}
        >
          Show Info
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={handlePush}
          disabled={!selectedModel || loading}
        >
          Push
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={handleRunning}
          disabled={loading}
        >
          Running
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={handleVersion}
          disabled={loading}
        >
          Version
        </Button>
      </div>
      {info && (
        <pre className='p-2 bg-gray-100 dark:bg-dark-200 rounded text-xs overflow-auto max-h-40'>
          {JSON.stringify(info, null, 2)}
        </pre>
      )}
      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        <Input
          label='Modelfile path'
          value={createFile}
          onChange={e => setCreateFile(e.target.value)}
          placeholder='/path/to/Modelfile'
        />
        <Input
          label='New model name'
          value={createModelName}
          onChange={e => setCreateModelName(e.target.value)}
          placeholder='mymodel:latest'
        />
        <Button
          variant='secondary'
          size='sm'
          onClick={handleCreate}
          className='sm:col-span-2'
          disabled={loading || !createFile || !createModelName}
        >
          Create Model
        </Button>
      </div>
      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        <Input
          label='Copy from'
          value={copySrc}
          onChange={e => setCopySrc(e.target.value)}
          placeholder='source:tag'
        />
        <Input
          label='Copy to'
          value={copyDest}
          onChange={e => setCopyDest(e.target.value)}
          placeholder='dest:tag'
        />
        <Button
          variant='secondary'
          size='sm'
          onClick={handleCopy}
          className='sm:col-span-2'
          disabled={loading || !copySrc || !copyDest}
        >
          Copy Model
        </Button>
      </div>
      <div className='space-y-2'>
        <Textarea
          label='Embeddings text'
          rows={3}
          value={embedText}
          onChange={e => setEmbedText(e.target.value)}
        />
        <Button
          variant='secondary'
          size='sm'
          onClick={handleEmbed}
          disabled={loading || !selectedModel || !embedText}
        >
          Generate Embeddings
        </Button>
      </div>
      {running.length > 0 && (
        <pre className='p-2 bg-gray-100 dark:bg-dark-200 rounded text-xs overflow-auto max-h-40'>
          {JSON.stringify(running, null, 2)}
        </pre>
      )}
      {version && (
        <div className='text-xs text-gray-600 dark:text-dark-500'>
          Ollama version: {version}
        </div>
      )}
    </div>
  );
};

export default ModelTools;
