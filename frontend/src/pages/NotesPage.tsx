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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, NotebookPen, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { RichMessageContent } from '@/components/ui/RichMessageContent';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui';
import { notesApi } from '@/utils/api';
import { cn, formatTimestamp } from '@/utils';
import { createLogger } from '@/utils/logger';
import type { Note } from '@/types';

const logger = createLogger('pages:notes');

const AUTOSAVE_DELAY_MS = 800;

export const NotesPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [contentDraft, setContentDraft] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'idle'>(
    'idle'
  );
  const saveTimerRef = useRef<number | null>(null);

  const selectedNote = useMemo(
    () => notes.find(note => note.id === selectedId) ?? null,
    [notes, selectedId]
  );

  useEffect(() => {
    let cancelled = false;
    notesApi
      .getNotes()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setNotes(response.data);
        }
      })
      .catch(error => logger.error('Failed to load notes:', error))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectNote = (note: Note) => {
    flushPendingSave();
    setSelectedId(note.id);
    setTitleDraft(note.title);
    setContentDraft(note.content);
    setPreviewing(false);
    setSaveState('idle');
  };

  const scheduleSave = (noteId: string, title: string, content: string) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    setSaveState('saving');
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistNote(noteId, title, content);
    }, AUTOSAVE_DELAY_MS);
  };

  const persistNote = async (
    noteId: string,
    title: string,
    content: string
  ) => {
    try {
      const response = await notesApi.updateNote(noteId, { title, content });
      if (response.success && response.data) {
        const updated = response.data;
        setNotes(previous =>
          [updated, ...previous.filter(note => note.id !== noteId)].sort(
            (a, b) => b.updatedAt - a.updatedAt
          )
        );
        setSaveState('saved');
      }
    } catch (error) {
      logger.error('Failed to save note:', error);
      toast.error(t('notes.saveFailed'));
      setSaveState('idle');
    }
  };

  const flushPendingSave = () => {
    if (saveTimerRef.current !== null && selectedId) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      void persistNote(selectedId, titleDraft, contentDraft);
    }
  };

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    },
    []
  );

  const handleCreate = async () => {
    try {
      const response = await notesApi.createNote('', '');
      if (response.success && response.data) {
        const note = response.data;
        setNotes(previous => [note, ...previous]);
        selectNote(note);
      }
    } catch (error) {
      logger.error('Failed to create note:', error);
      toast.error(t('notes.createFailed'));
    }
  };

  const handleDelete = async (noteId: string) => {
    if (!window.confirm(t('notes.deleteConfirm'))) return;
    try {
      const response = await notesApi.deleteNote(noteId);
      if (response.success) {
        setNotes(previous => previous.filter(note => note.id !== noteId));
        if (selectedId === noteId) {
          setSelectedId(null);
        }
      }
    } catch (error) {
      logger.error('Failed to delete note:', error);
      toast.error(t('notes.deleteFailed'));
    }
  };

  const filteredNotes = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return notes;
    return notes.filter(
      note =>
        note.title.toLowerCase().includes(text) ||
        note.content.toLowerCase().includes(text)
    );
  }, [notes, query]);

  return (
    <div className='flex h-full min-h-0'>
      {/* Note list */}
      <div className='flex w-72 shrink-0 flex-col border-e border-black/[0.06] dark:border-white/[0.07]'>
        <div className='flex items-center justify-between px-4 pb-2 pt-4'>
          <h1 className='text-sm font-semibold text-gray-900 dark:text-dark-900'>
            {t('notes.title')}
          </h1>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => void handleCreate()}
            className='h-7 w-7 p-0'
            title={t('notes.new')}
          >
            <Plus className='h-4 w-4' />
          </Button>
        </div>
        <div className='relative mx-3 mb-2'>
          <Search className='pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400 dark:text-dark-500' />
          <input
            type='search'
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('common.search')}
            className='w-full rounded-lg border border-transparent bg-black/[0.04] py-1.5 pe-2.5 ps-8 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-primary-500/40 focus:outline-none dark:bg-white/[0.05] dark:text-dark-900 dark:placeholder:text-dark-500'
          />
        </div>
        <div className='scroll-region min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin'>
          {loading ? null : filteredNotes.length === 0 ? (
            <div className='px-3 py-10 text-center'>
              <NotebookPen className='mx-auto mb-2 h-6 w-6 text-gray-300 dark:text-dark-400' />
              <p className='text-xs text-gray-400 dark:text-dark-500'>
                {t('notes.empty')}
              </p>
            </div>
          ) : (
            <div className='space-y-0.5'>
              {filteredNotes.map(note => (
                <div
                  key={note.id}
                  onClick={() => selectNote(note)}
                  className={cn(
                    'group cursor-pointer rounded-lg px-2.5 py-2 transition-colors',
                    selectedId === note.id
                      ? 'bg-white ring-1 ring-black/[0.04] dark:bg-dark-200 dark:ring-white/[0.05]'
                      : 'hover:bg-white/60 dark:hover:bg-dark-200/60'
                  )}
                >
                  <div className='flex items-center justify-between gap-2'>
                    <p className='truncate text-[13px] font-medium text-gray-900 dark:text-dark-900'>
                      {note.title || t('notes.untitled')}
                    </p>
                    <button
                      onClick={event => {
                        event.stopPropagation();
                        void handleDelete(note.id);
                      }}
                      className='shrink-0 rounded-md p-1 text-red-500 opacity-0 transition-opacity hover:bg-red-50 group-hover:opacity-100 dark:hover:bg-red-900/20'
                      title={t('common.delete')}
                    >
                      <Trash2 className='h-3 w-3' />
                    </button>
                  </div>
                  <p className='mt-0.5 truncate text-[11px] text-gray-400 dark:text-dark-500'>
                    {formatTimestamp(note.updatedAt, i18n.language)}
                    {note.content.trim() && (
                      <>
                        {' · '}
                        {note.content.trim().slice(0, 60)}
                      </>
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className='flex min-w-0 flex-1 flex-col'>
        {selectedNote ? (
          <>
            <div className='flex items-center gap-2 border-b border-black/[0.06] px-5 py-3 dark:border-white/[0.07]'>
              <input
                dir='auto'
                value={titleDraft}
                onChange={event => {
                  setTitleDraft(event.target.value);
                  scheduleSave(
                    selectedNote.id,
                    event.target.value,
                    contentDraft
                  );
                }}
                placeholder={t('notes.untitled')}
                className='min-w-0 flex-1 bg-transparent text-lg font-semibold text-gray-950 placeholder:text-gray-400 focus:outline-none dark:text-dark-950 dark:placeholder:text-dark-500'
              />
              <span className='text-[11px] text-gray-400 dark:text-dark-500'>
                {saveState === 'saving'
                  ? t('common.saving')
                  : saveState === 'saved'
                    ? t('notes.saved')
                    : ''}
              </span>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setPreviewing(previous => !previous)}
                className='h-8 gap-1.5 px-2.5 text-xs'
              >
                {previewing ? (
                  <>
                    <Pencil className='h-3.5 w-3.5' />
                    {t('common.edit')}
                  </>
                ) : (
                  <>
                    <Eye className='h-3.5 w-3.5' />
                    {t('artifacts.preview')}
                  </>
                )}
              </Button>
            </div>
            {previewing ? (
              <div className='scroll-region min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin'>
                <RichMessageContent content={contentDraft} />
              </div>
            ) : (
              <textarea
                dir='auto'
                value={contentDraft}
                onChange={event => {
                  setContentDraft(event.target.value);
                  scheduleSave(selectedNote.id, titleDraft, event.target.value);
                }}
                onBlur={flushPendingSave}
                placeholder={t('notes.contentPlaceholder')}
                className='min-h-0 flex-1 resize-none bg-transparent px-5 py-4 font-mono text-[13.5px] leading-relaxed text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-dark-900 dark:placeholder:text-dark-500'
              />
            )}
          </>
        ) : (
          <div className='flex flex-1 items-center justify-center'>
            <div className='text-center'>
              <NotebookPen className='mx-auto mb-3 h-8 w-8 text-gray-300 dark:text-dark-400' />
              <p className='text-sm text-gray-500 dark:text-dark-600'>
                {t('notes.selectOrCreate')}
              </p>
              <Button
                size='sm'
                onClick={() => void handleCreate()}
                className='mt-4 gap-1.5'
              >
                <Plus className='h-3.5 w-3.5' />
                {t('notes.new')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NotesPage;
