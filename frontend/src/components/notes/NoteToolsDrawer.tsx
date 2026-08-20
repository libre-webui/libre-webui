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

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  History,
  Loader2,
  Paperclip,
  Share2,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui';
import { accessApi, notesApi } from '@/utils/api';
import type { ResourceGrant } from '@/utils/api/accessApi';
import { useChatStore } from '@/store/chatStore';
import { diffNoteLines, noteDiffHasChanges } from '@/utils/noteDiff';
import type { NoteDiffRow } from '@/utils/noteDiff';
import { cn, formatTimestamp } from '@/utils';
import { createLogger } from '@/utils/logger';
import type { Note, NoteAttachment, NoteRevision } from '@/types';

const logger = createLogger('components:note-tools');

export type NoteToolsTab = 'revisions' | 'attachments' | 'share' | 'assist';

interface NoteToolsDrawerProps {
  note: Note;
  /** Current editor drafts, so proposals diff against unsaved text. */
  currentContent: string;
  currentTitle: string;
  canWrite: boolean;
  isOwner: boolean;
  initialTab: NoteToolsTab;
  onClose: () => void;
  /** Applies new content through the ordinary save path. */
  onApplyContent: (content: string, title?: string) => void;
}

const DiffView: React.FC<{ rows: NoteDiffRow[] }> = ({ rows }) => (
  <div
    className='max-h-64 overflow-auto rounded-lg border border-black/[0.06] font-mono text-[12px] leading-relaxed dark:border-white/[0.08]'
    data-testid='note-diff-view'
  >
    {rows.map((row, index) => (
      <div
        key={index}
        className={cn(
          'whitespace-pre-wrap px-2',
          row.type === 'added' &&
            'bg-[rgb(76,212,117)]/[0.12] text-green-800 dark:text-green-300',
          row.type === 'removed' &&
            'bg-[rgb(255,61,129)]/[0.10] text-red-800 line-through dark:text-red-300',
          row.type === 'context' && 'text-gray-600 dark:text-dark-700'
        )}
      >
        {row.text || ' '}
      </div>
    ))}
  </div>
);

export const NoteToolsDrawer: React.FC<NoteToolsDrawerProps> = ({
  note,
  currentContent,
  currentTitle,
  canWrite,
  isOwner,
  initialTab,
  onClose,
  onApplyContent,
}) => {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<NoteToolsTab>(initialTab);

  // Revisions
  const [revisions, setRevisions] = useState<NoteRevision[] | null>(null);
  const [openRevisionId, setOpenRevisionId] = useState<string | null>(null);

  // Attachments
  const [attachments, setAttachments] = useState<NoteAttachment[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sharing
  const [grants, setGrants] = useState<ResourceGrant[] | null>(null);
  const [shareUsername, setShareUsername] = useState('');
  const [sharePermission, setSharePermission] = useState<'read' | 'write'>(
    'read'
  );
  const [sharing, setSharing] = useState(false);

  // AI assist
  const [instruction, setInstruction] = useState('');
  const [assisting, setAssisting] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const selectedModel = useChatStore(state => state.selectedModel);
  const selectedProviderType = useChatStore(
    state => state.selectedProviderType
  );
  const selectedProviderId = useChatStore(state => state.selectedProviderId);

  const loadRevisions = useCallback(() => {
    notesApi
      .getRevisions(note.id)
      .then(response => {
        if (response.success && Array.isArray(response.data)) {
          setRevisions(response.data);
        }
      })
      .catch(error => logger.error('Failed to load revisions:', error));
  }, [note.id]);

  const loadAttachments = useCallback(() => {
    notesApi
      .getAttachments(note.id)
      .then(response => {
        if (response.success && Array.isArray(response.data)) {
          setAttachments(response.data);
        }
      })
      .catch(error => logger.error('Failed to load attachments:', error));
  }, [note.id]);

  const loadGrants = useCallback(() => {
    accessApi
      .listGrants('note', note.id)
      .then(response => {
        if (response.success && Array.isArray(response.data)) {
          setGrants(response.data);
        }
      })
      .catch(error => logger.error('Failed to load shares:', error));
  }, [note.id]);

  useEffect(() => {
    if (tab === 'revisions' && revisions === null) loadRevisions();
    if (tab === 'attachments' && attachments === null) loadAttachments();
    if (tab === 'share' && isOwner && grants === null) loadGrants();
  }, [
    tab,
    revisions,
    attachments,
    grants,
    isOwner,
    loadRevisions,
    loadAttachments,
    loadGrants,
  ]);

  const handleRestore = async (revisionId: string) => {
    try {
      const response = await notesApi.restoreRevision(note.id, revisionId);
      if (response.success && response.data) {
        onApplyContent(response.data.content, response.data.title);
        setRevisions(null);
        setOpenRevisionId(null);
        toast.success(t('notes.revisionRestored'));
      } else {
        toast.error(response.error || t('notes.revisionRestoreFailed'));
      }
    } catch (error) {
      logger.error('Failed to restore revision:', error);
      toast.error(t('notes.revisionRestoreFailed'));
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const response = await notesApi.uploadAttachment(note.id, files[0]);
      if (response.success) {
        loadAttachments();
        toast.success(t('notes.attachmentAdded'));
      } else {
        toast.error(response.error || t('notes.attachmentFailed'));
      }
    } catch (error) {
      logger.error('Failed to upload attachment:', error);
      toast.error(t('notes.attachmentFailed'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownload = async (attachment: NoteAttachment) => {
    try {
      const blob = await notesApi.downloadAttachment(note.id, attachment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      logger.error('Failed to download attachment:', error);
      toast.error(t('notes.attachmentDownloadFailed'));
    }
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    try {
      const response = await notesApi.deleteAttachment(note.id, attachmentId);
      if (response.success) loadAttachments();
    } catch (error) {
      logger.error('Failed to delete attachment:', error);
    }
  };

  const handleShare = async () => {
    const username = shareUsername.trim();
    if (!username) return;
    setSharing(true);
    try {
      const principal = await accessApi.resolvePrincipal(username);
      if (!principal.success || !principal.data) {
        toast.error(t('notes.shareUserNotFound'));
        return;
      }
      const response = await accessApi.createGrant({
        resourceType: 'note',
        resourceId: note.id,
        principalType: 'user',
        principalId: principal.data.id,
        permission: sharePermission,
      });
      if (response.success) {
        setShareUsername('');
        loadGrants();
        toast.success(t('notes.shareAdded', { username }));
      } else {
        toast.error(response.error || t('notes.shareFailed'));
      }
    } catch (error) {
      logger.error('Failed to share note:', error);
      toast.error(t('notes.shareFailed'));
    } finally {
      setSharing(false);
    }
  };

  const handleRevoke = async (grantId: string) => {
    try {
      const response = await accessApi.deleteGrant(grantId);
      if (response.success) loadGrants();
    } catch (error) {
      logger.error('Failed to revoke share:', error);
    }
  };

  const handleAssist = async () => {
    if (!instruction.trim() || !selectedModel) return;
    setAssisting(true);
    setProposal(null);
    try {
      const response = await notesApi.assist(note.id, {
        instruction,
        model: selectedModel,
        providerType: selectedProviderType,
        providerId: selectedProviderId,
      });
      if (response.success && response.data?.content !== undefined) {
        setProposal(response.data.content);
      } else {
        toast.error(response.error || t('notes.assistFailed'));
      }
    } catch (error) {
      logger.error('Note assist failed:', error);
      toast.error(t('notes.assistFailed'));
    } finally {
      setAssisting(false);
    }
  };

  const proposalDiff = useMemo(
    () => (proposal !== null ? diffNoteLines(currentContent, proposal) : null),
    [proposal, currentContent]
  );

  const tabs: Array<{
    id: NoteToolsTab;
    icon: React.ReactNode;
    label: string;
    hidden?: boolean;
  }> = [
    {
      id: 'revisions',
      icon: <History className='h-3.5 w-3.5' />,
      label: t('notes.revisions'),
    },
    {
      id: 'attachments',
      icon: <Paperclip className='h-3.5 w-3.5' />,
      label: t('notes.attachments'),
    },
    {
      id: 'share',
      icon: <Share2 className='h-3.5 w-3.5' />,
      label: t('notes.share'),
      hidden: !isOwner,
    },
    {
      id: 'assist',
      icon: <Sparkles className='h-3.5 w-3.5' />,
      label: t('notes.assist'),
      hidden: !canWrite,
    },
  ];

  return (
    <div
      className='absolute inset-y-0 end-0 z-30 flex w-full max-w-md flex-col border-s border-black/[0.06] bg-surface shadow-xl dark:border-white/[0.07] dark:bg-dark-100'
      data-testid='note-tools-drawer'
      role='dialog'
      aria-label={t('notes.tools')}
    >
      <div className='flex items-center gap-1 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.07]'>
        {tabs
          .filter(entry => !entry.hidden)
          .map(entry => (
            <button
              key={entry.id}
              type='button'
              role='tab'
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              data-testid={`note-tools-tab-${entry.id}`}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors',
                tab === entry.id
                  ? 'bg-black/[0.06] text-gray-900 dark:bg-white/[0.08] dark:text-dark-900'
                  : 'text-gray-500 hover:text-gray-800 dark:text-dark-500 dark:hover:text-dark-800'
              )}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        <button
          type='button'
          onClick={onClose}
          className='ms-auto rounded-md p-1.5 text-gray-400 hover:text-gray-700 dark:text-dark-500 dark:hover:text-dark-800'
          aria-label={t('common.close')}
          data-testid='note-tools-close'
        >
          <X className='h-4 w-4' />
        </button>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin'>
        {tab === 'revisions' && (
          <div className='space-y-2'>
            {revisions === null ? (
              <Loader2 className='mx-auto h-4 w-4 animate-spin text-gray-400' />
            ) : revisions.length === 0 ? (
              <p className='text-center text-xs text-gray-400 dark:text-dark-500'>
                {t('notes.noRevisions')}
              </p>
            ) : (
              revisions.map(revision => (
                <div
                  key={revision.id}
                  className='rounded-lg border border-black/[0.06] p-2.5 dark:border-white/[0.08]'
                  data-testid='note-revision-item'
                >
                  <div className='flex items-center justify-between gap-2'>
                    <button
                      type='button'
                      onClick={() =>
                        setOpenRevisionId(current =>
                          current === revision.id ? null : revision.id
                        )
                      }
                      className='min-w-0 flex-1 truncate text-start text-[13px] text-gray-800 dark:text-dark-800'
                    >
                      {formatTimestamp(revision.createdAt, i18n.language)}
                      {revision.title !== currentTitle && (
                        <span className='ms-1 text-gray-400 dark:text-dark-500'>
                          · {revision.title || t('notes.untitled')}
                        </span>
                      )}
                    </button>
                    {canWrite && (
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-7 gap-1 px-2 text-[11px]'
                        onClick={() => void handleRestore(revision.id)}
                        data-testid='note-revision-restore'
                      >
                        <Undo2 className='h-3 w-3' />
                        {t('notes.restore')}
                      </Button>
                    )}
                  </div>
                  {openRevisionId === revision.id && (
                    <div className='mt-2'>
                      <DiffView
                        rows={diffNoteLines(revision.content, currentContent)}
                      />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'attachments' && (
          <div className='space-y-2'>
            {canWrite && (
              <>
                <input
                  ref={fileInputRef}
                  type='file'
                  className='hidden'
                  onChange={event => void handleUpload(event.target.files)}
                  data-testid='note-attachment-input'
                />
                <Button
                  size='sm'
                  variant='outline'
                  className='w-full gap-1.5'
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  data-testid='note-attachment-upload'
                >
                  {uploading ? (
                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Paperclip className='h-3.5 w-3.5' />
                  )}
                  {t('notes.addAttachment')}
                </Button>
              </>
            )}
            {attachments === null ? (
              <Loader2 className='mx-auto h-4 w-4 animate-spin text-gray-400' />
            ) : attachments.length === 0 ? (
              <p className='text-center text-xs text-gray-400 dark:text-dark-500'>
                {t('notes.noAttachments')}
              </p>
            ) : (
              attachments.map(attachment => (
                <div
                  key={attachment.id}
                  className='flex items-center gap-2 rounded-lg border border-black/[0.06] px-2.5 py-2 dark:border-white/[0.08]'
                  data-testid='note-attachment-item'
                >
                  <Paperclip className='h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-dark-500' />
                  <span
                    dir='ltr'
                    className='min-w-0 flex-1 truncate text-[13px] text-gray-800 dark:text-dark-800'
                  >
                    {attachment.filename}
                  </span>
                  <span className='shrink-0 text-[11px] text-gray-400 dark:text-dark-500'>
                    {Math.max(1, Math.round(attachment.size / 1024))} KB
                  </span>
                  <button
                    type='button'
                    onClick={() => void handleDownload(attachment)}
                    className='rounded-md p-1 text-gray-400 hover:text-gray-700 dark:text-dark-500 dark:hover:text-dark-800'
                    title={t('common.download')}
                  >
                    <Download className='h-3.5 w-3.5' />
                  </button>
                  {canWrite && (
                    <button
                      type='button'
                      onClick={() => void handleDeleteAttachment(attachment.id)}
                      className='rounded-md p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                      title={t('common.delete')}
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'share' && isOwner && (
          <div className='space-y-3'>
            <div className='flex gap-1.5'>
              <input
                type='text'
                value={shareUsername}
                onChange={event => setShareUsername(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void handleShare();
                }}
                placeholder={t('notes.shareUsernamePlaceholder')}
                className='min-w-0 flex-1 rounded-lg border border-black/[0.08] bg-transparent px-2.5 py-1.5 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.1] dark:text-dark-900'
                data-testid='note-share-username'
              />
              <select
                value={sharePermission}
                onChange={event =>
                  setSharePermission(event.target.value as 'read' | 'write')
                }
                className='rounded-lg border border-black/[0.08] bg-transparent px-2 py-1.5 text-[12px] text-gray-700 focus:outline-none dark:border-white/[0.1] dark:bg-dark-100 dark:text-dark-800'
                data-testid='note-share-permission'
              >
                <option value='read'>{t('notes.permissionRead')}</option>
                <option value='write'>{t('notes.permissionWrite')}</option>
              </select>
              <Button
                size='sm'
                disabled={sharing || !shareUsername.trim()}
                onClick={() => void handleShare()}
                data-testid='note-share-submit'
              >
                {sharing ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  t('notes.shareAction')
                )}
              </Button>
            </div>
            {grants === null ? (
              <Loader2 className='mx-auto h-4 w-4 animate-spin text-gray-400' />
            ) : grants.length === 0 ? (
              <p className='text-center text-xs text-gray-400 dark:text-dark-500'>
                {t('notes.notShared')}
              </p>
            ) : (
              grants.map(grant => (
                <div
                  key={grant.id}
                  className='flex items-center gap-2 rounded-lg border border-black/[0.06] px-2.5 py-2 dark:border-white/[0.08]'
                  data-testid='note-share-item'
                >
                  <Share2 className='h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-dark-500' />
                  <span className='min-w-0 flex-1 truncate text-[13px] text-gray-800 dark:text-dark-800'>
                    {grant.principalId}
                  </span>
                  <span className='shrink-0 text-[11px] uppercase text-gray-400 dark:text-dark-500'>
                    {grant.permission}
                  </span>
                  <button
                    type='button'
                    onClick={() => void handleRevoke(grant.id)}
                    className='rounded-md p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                    title={t('notes.revokeShare')}
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </div>
              ))
            )}
            <p className='text-[11px] leading-relaxed text-gray-400 dark:text-dark-500'>
              {t('notes.shareHint')}
            </p>
          </div>
        )}

        {tab === 'assist' && canWrite && (
          <div className='space-y-3'>
            <textarea
              value={instruction}
              onChange={event => setInstruction(event.target.value)}
              placeholder={t('notes.assistPlaceholder')}
              rows={3}
              className='w-full resize-none rounded-lg border border-black/[0.08] bg-transparent px-2.5 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.1] dark:text-dark-900'
              data-testid='note-assist-instruction'
            />
            <Button
              size='sm'
              className='w-full gap-1.5'
              disabled={assisting || !instruction.trim() || !selectedModel}
              onClick={() => void handleAssist()}
              data-testid='note-assist-generate'
            >
              {assisting ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
              ) : (
                <Sparkles className='h-3.5 w-3.5' />
              )}
              {t('notes.assistGenerate')}
            </Button>
            {!selectedModel && (
              <p className='text-[11px] text-amber-600 dark:text-amber-400'>
                {t('notes.assistNoModel')}
              </p>
            )}
            {proposal !== null && proposalDiff && (
              <div className='space-y-2'>
                {noteDiffHasChanges(proposalDiff) ? (
                  <DiffView rows={proposalDiff} />
                ) : (
                  <p className='text-center text-xs text-gray-400 dark:text-dark-500'>
                    {t('notes.assistNoChanges')}
                  </p>
                )}
                <div className='flex gap-2'>
                  <Button
                    size='sm'
                    className='flex-1'
                    disabled={!noteDiffHasChanges(proposalDiff)}
                    onClick={() => {
                      onApplyContent(proposal);
                      setProposal(null);
                      setInstruction('');
                      toast.success(t('notes.assistApplied'));
                    }}
                    data-testid='note-assist-apply'
                  >
                    {t('notes.assistApply')}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    className='flex-1'
                    onClick={() => setProposal(null)}
                    data-testid='note-assist-discard'
                  >
                    {t('notes.assistDiscard')}
                  </Button>
                </div>
                <p className='text-[11px] leading-relaxed text-gray-400 dark:text-dark-500'>
                  {t('notes.assistRevisionHint')}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default NoteToolsDrawer;
