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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Users,
  UserMinus,
} from 'lucide-react';
import { Button, Input, Select } from '@/components/ui';
import { adminSecurityApi, usersApi } from '@/utils/api';
import type { EffectiveAccess, UserGroup } from '@/utils/api';
import type { User } from '@/types';

/**
 * Administrator management of user groups plus an effective-access viewer
 * that shows what a given account can actually do (role, groups, feature
 * flags, and explicit grants).
 */
export const GroupManager: React.FC = () => {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [memberToAdd, setMemberToAdd] = useState('');
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);

  const [accessUserId, setAccessUserId] = useState('');
  const [access, setAccess] = useState<EffectiveAccess | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);

  const usernameById = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach(user => map.set(user.id, user.username));
    return map;
  }, [users]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [groupsResponse, usersResponse] = await Promise.all([
        adminSecurityApi.getGroups(),
        usersApi.getUsers(),
      ]);
      if (!groupsResponse.success || !groupsResponse.data) {
        throw new Error(groupsResponse.error || 'Failed to load groups.');
      }
      setGroups(groupsResponse.data);
      if (usersResponse.success && usersResponse.data) {
        setUsers(usersResponse.data);
      }
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) {
      toast.error(
        t('userManager.groups.nameRequired', 'Give the group a name.')
      );
      return;
    }
    setCreating(true);
    try {
      const response = await adminSecurityApi.createGroup({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
      });
      if (!response.success) {
        throw new Error(response.error || 'Group creation failed.');
      }
      setNewName('');
      setNewDescription('');
      setShowCreateForm(false);
      toast.success(t('userManager.groups.created', 'Group created.'));
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(
              'userManager.groups.createFailed',
              'The group could not be created.'
            )
      );
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteGroup = async (group: UserGroup) => {
    setBusyGroupId(group.id);
    try {
      const response = await adminSecurityApi.deleteGroup(group.id);
      if (!response.success) {
        throw new Error(response.error || 'Group delete failed.');
      }
      toast.success(t('userManager.groups.deleted', 'Group deleted.'));
      if (expandedGroupId === group.id) setExpandedGroupId(null);
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(
              'userManager.groups.deleteFailed',
              'The group could not be deleted.'
            )
      );
    } finally {
      setBusyGroupId(null);
    }
  };

  const handleAddMember = async (group: UserGroup) => {
    if (!memberToAdd) return;
    setBusyGroupId(group.id);
    try {
      const response = await adminSecurityApi.addGroupMember(
        group.id,
        memberToAdd
      );
      if (!response.success) {
        throw new Error(response.error || 'Member add failed.');
      }
      setMemberToAdd('');
      toast.success(t('userManager.groups.memberAdded', 'Member added.'));
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(
              'userManager.groups.memberAddFailed',
              'The member could not be added.'
            )
      );
    } finally {
      setBusyGroupId(null);
    }
  };

  const handleRemoveMember = async (group: UserGroup, userId: string) => {
    setBusyGroupId(group.id);
    try {
      const response = await adminSecurityApi.removeGroupMember(
        group.id,
        userId
      );
      if (!response.success) {
        throw new Error(response.error || 'Member remove failed.');
      }
      toast.success(t('userManager.groups.memberRemoved', 'Member removed.'));
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(
              'userManager.groups.memberRemoveFailed',
              'The member could not be removed.'
            )
      );
    } finally {
      setBusyGroupId(null);
    }
  };

  const handleAccessLookup = async (userId: string) => {
    setAccessUserId(userId);
    setAccess(null);
    if (!userId) return;
    setAccessLoading(true);
    try {
      const response = await adminSecurityApi.getEffectiveAccess(userId);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Access lookup failed.');
      }
      setAccess(response.data);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(
              'userManager.groups.accessLookupFailed',
              'The effective access could not be loaded.'
            )
      );
    } finally {
      setAccessLoading(false);
    }
  };

  const userOptions = (candidates: User[]) =>
    candidates.map(user => ({ value: user.id, label: user.username }));

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4 className='flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100'>
            <Users className='h-4 w-4 text-primary-500' />
            {t('userManager.groups.title', 'Groups')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t(
              'userManager.groups.description',
              'Group accounts to manage shared access, and inspect what any account can effectively do.'
            )}
          </p>
        </div>
        {loadFailed ? (
          <Button size='sm' variant='outline' onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        ) : (
          <Button
            size='sm'
            variant='outline'
            onClick={() => setShowCreateForm(previous => !previous)}
            className='gap-1.5'
          >
            <Plus size={14} />
            {t('userManager.groups.newGroup', 'New group')}
          </Button>
        )}
      </div>

      {showCreateForm && (
        <form
          onSubmit={handleCreate}
          className='mt-4 rounded-lg border border-gray-200 dark:border-dark-300 bg-gray-50 dark:bg-dark-50 p-4 space-y-3'
        >
          <div className='grid gap-3 sm:grid-cols-2'>
            <label className='block'>
              <span className='mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100'>
                {t('userManager.groups.nameLabel', 'Name')}
              </span>
              <Input
                value={newName}
                onChange={event => setNewName(event.target.value)}
              />
            </label>
            <label className='block'>
              <span className='mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100'>
                {t(
                  'userManager.groups.descriptionLabel',
                  'Description (optional)'
                )}
              </span>
              <Input
                value={newDescription}
                onChange={event => setNewDescription(event.target.value)}
              />
            </label>
          </div>
          <div className='flex justify-end gap-2'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() => setShowCreateForm(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type='submit' size='sm' disabled={creating}>
              {creating
                ? t('userManager.groups.creating', 'Creating…')
                : t('userManager.groups.create', 'Create group')}
            </Button>
          </div>
        </form>
      )}

      <div className='mt-4 space-y-3'>
        {loading ? (
          <p className='text-sm text-gray-500 dark:text-gray-400'>
            {t('common.loading')}
          </p>
        ) : loadFailed ? (
          <p className='text-sm text-gray-500 dark:text-gray-400'>
            {t(
              'userManager.groups.loadFailed',
              'The groups could not be loaded.'
            )}
          </p>
        ) : groups.length === 0 ? (
          <p className='text-sm text-gray-500 dark:text-gray-400'>
            {t('userManager.groups.empty', 'No groups yet.')}
          </p>
        ) : (
          groups.map(group => {
            const expanded = expandedGroupId === group.id;
            const memberIds = new Set(
              group.members.map(member => member.user_id)
            );
            const candidates = users.filter(user => !memberIds.has(user.id));
            return (
              <div
                key={group.id}
                className='rounded-lg border border-gray-200 dark:border-dark-300 bg-gray-50 dark:bg-dark-100'
              >
                <div className='flex items-center justify-between gap-3 p-4'>
                  <button
                    type='button'
                    className='flex min-w-0 flex-1 items-center gap-2 text-start'
                    onClick={() => {
                      setExpandedGroupId(expanded ? null : group.id);
                      setMemberToAdd('');
                    }}
                    aria-expanded={expanded}
                  >
                    {expanded ? (
                      <ChevronDown className='h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400' />
                    ) : (
                      <ChevronRight className='h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400' />
                    )}
                    <span className='min-w-0'>
                      <span className='block truncate text-sm font-medium text-gray-900 dark:text-gray-100'>
                        {group.name}
                        <span className='ms-2 text-xs font-normal text-gray-500 dark:text-gray-400'>
                          {t('userManager.groups.memberCount', {
                            count: group.members.length,
                            defaultValue: 'Members: {{count}}',
                          })}
                        </span>
                      </span>
                      {group.description && (
                        <span className='block truncate text-xs text-gray-500 dark:text-gray-400'>
                          {group.description}
                        </span>
                      )}
                    </span>
                  </button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void handleDeleteGroup(group)}
                    disabled={busyGroupId === group.id}
                    aria-label={t(
                      'userManager.groups.deleteGroup',
                      'Delete group'
                    )}
                    className='text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20'
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>

                {expanded && (
                  <div className='border-t border-gray-200 dark:border-dark-300 p-4 space-y-3'>
                    {group.members.length === 0 ? (
                      <p className='text-sm text-gray-500 dark:text-gray-400'>
                        {t('userManager.groups.noMembers', 'No members yet.')}
                      </p>
                    ) : (
                      <div className='space-y-2'>
                        {group.members.map(member => (
                          <div
                            key={member.user_id}
                            className='flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-50 px-3 py-2'
                          >
                            <div className='min-w-0'>
                              <p className='truncate text-sm text-gray-900 dark:text-gray-100'>
                                {usernameById.get(member.user_id) ||
                                  member.user_id}
                              </p>
                              <p className='text-xs text-gray-500 dark:text-gray-400'>
                                {t('userManager.groups.addedAt', 'Added')}:{' '}
                                {new Date(member.added_at).toLocaleDateString()}
                              </p>
                            </div>
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() =>
                                void handleRemoveMember(group, member.user_id)
                              }
                              disabled={busyGroupId === group.id}
                              aria-label={t(
                                'userManager.groups.removeMember',
                                'Remove member'
                              )}
                            >
                              <UserMinus size={16} />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {candidates.length > 0 && (
                      <div className='flex items-end gap-2'>
                        <div className='flex-1'>
                          <Select
                            label={t(
                              'userManager.groups.addMember',
                              'Add member'
                            )}
                            value={memberToAdd}
                            onChange={event =>
                              setMemberToAdd(event.target.value)
                            }
                            options={[
                              {
                                value: '',
                                label: t(
                                  'userManager.groups.selectUser',
                                  'Select a user…'
                                ),
                              },
                              ...userOptions(candidates),
                            ]}
                          />
                        </div>
                        <Button
                          size='sm'
                          onClick={() => void handleAddMember(group)}
                          disabled={!memberToAdd || busyGroupId === group.id}
                          className='mb-0.5'
                        >
                          {t('userManager.groups.add', 'Add')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Effective access viewer */}
      <div className='mt-6 border-t border-gray-200 dark:border-dark-300 pt-4 space-y-3'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.groups.effectiveTitle', 'Effective access')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t(
              'userManager.groups.effectiveDescription',
              'Pick an account to see the access it ends up with across role, groups, and grants.'
            )}
          </p>
        </div>
        <Select
          value={accessUserId}
          onChange={event => void handleAccessLookup(event.target.value)}
          options={[
            {
              value: '',
              label: t('userManager.groups.selectUser', 'Select a user…'),
            },
            ...userOptions(users),
          ]}
        />
        {accessLoading && (
          <p className='text-sm text-gray-500 dark:text-gray-400'>
            {t('common.loading')}
          </p>
        )}
        {access && !accessLoading && (
          <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-gray-50 dark:bg-dark-50 p-4 space-y-3'>
            <p className='text-sm text-gray-900 dark:text-gray-100'>
              <span className='font-medium'>{access.username}</span>
              <span className='text-gray-500 dark:text-gray-400'>
                {' · '}
                {t('userManager.groups.roleLabel', 'Role')}: {access.role}
                {' · '}
                {t('userManager.groups.statusLabel', 'Status')}: {access.status}
              </span>
            </p>
            <div>
              <p className='mb-1 text-xs font-medium text-gray-500 dark:text-gray-400'>
                {t('userManager.groups.memberOf', 'Groups')}
              </p>
              {access.groups.length === 0 ? (
                <p className='text-sm text-gray-500 dark:text-gray-400'>
                  {t('common.none')}
                </p>
              ) : (
                <div className='flex flex-wrap gap-1'>
                  {access.groups.map(entry => (
                    <span
                      key={entry.id}
                      className='rounded-full bg-primary-100 dark:bg-primary-900/30 px-2 py-0.5 text-xs text-primary-700 dark:text-primary-300'
                    >
                      {entry.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className='mb-1 text-xs font-medium text-gray-500 dark:text-gray-400'>
                {t('userManager.groups.featuresLabel', 'Feature access')}
              </p>
              <div className='flex flex-wrap gap-1'>
                {Object.entries(access.features).map(([feature, allowed]) => (
                  <span
                    key={feature}
                    className={
                      allowed
                        ? 'rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs text-green-700 dark:text-green-300'
                        : 'rounded-full bg-gray-100 dark:bg-dark-200 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400'
                    }
                  >
                    {feature}
                    {': '}
                    {allowed ? t('common.yes') : t('common.no')}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <p className='mb-1 text-xs font-medium text-gray-500 dark:text-gray-400'>
                {t('userManager.groups.grantsLabel', 'Grants')}
              </p>
              {access.grants.length === 0 ? (
                <p className='text-sm text-gray-500 dark:text-gray-400'>
                  {t('common.none')}
                </p>
              ) : (
                <div className='space-y-1'>
                  {access.grants.map(grant => (
                    <p
                      key={grant.id}
                      className='text-xs text-gray-700 dark:text-gray-300'
                    >
                      {grant.resourceType}/{grant.resourceId} ·{' '}
                      {grant.permission}{' '}
                      <span className='text-gray-500 dark:text-gray-400'>
                        ({t('userManager.groups.grantVia', 'via')} {grant.via})
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default GroupManager;
