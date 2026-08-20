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

/**
 * Channels (CHANNEL-01/02): public, private, and direct-message
 * conversations with a persistent, idempotent, ordered timeline plus
 * threads, reactions, pins, and per-member unread cursors.
 *
 * SQL is authoritative for every row; the durable event ledger only fans
 * the same facts out to live subscribers (stream `channel:<id>`), so a
 * missed event is recovered by reading the timeline, never replayed into
 * divergence. Message and channel text is encrypted at rest with the same
 * boundary as chat messages. Deletion is a tombstone: content is cleared
 * but the timeline entry survives so threads never dangle.
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { getPersistence } from '../persistence/index.js';
import {
  PersistenceResourceLimitError,
  type ChannelTimelineCursor,
  type StoredChannelAttachmentRecord,
  type StoredChannelMemberRecord,
  type StoredChannelMessageRecord,
  type StoredChannelRecord,
} from '../persistence/resourceTypes.js';
import { encryptionService } from './encryptionService.js';
import { userModel } from '../models/userModel.js';
import { getDurableEventGateway } from '../platform/events/index.js';
import {
  channelEventStreamId,
  CHANNEL_MENTION_IDEMPOTENCY_SCOPE,
  CHANNEL_MENTION_JOB_TYPE,
} from '../platform/jobs/domainJobContracts.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import { getCoordinator } from '../platform/coordination/service.js';
import { getPlatformStorageRuntime } from '../platform/storage/index.js';
import type { BlobReadResult } from '../platform/storage/index.js';
import { createLogger } from '../utils/logger.js';
import {
  MAX_CHANNEL_ATTACHMENT_BYTES,
  MAX_CHANNEL_ATTACHMENTS_PER_MESSAGE,
  MAX_CHANNEL_MENTION_CONTEXT_MESSAGES,
  MAX_CHANNEL_DESCRIPTION_LENGTH,
  MAX_CHANNEL_EMOJI_LENGTH,
  MAX_CHANNEL_MEMBERS,
  MAX_CHANNEL_MESSAGE_LENGTH,
  MAX_CHANNEL_MESSAGES,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_PAGE_SIZE,
  MAX_CHANNEL_PINNED_LISTED,
  MAX_CHANNEL_REACTIONS_PER_MESSAGE,
  MAX_CHANNEL_THREAD_PAGE_SIZE,
  MAX_CHANNELS_LISTED,
  MAX_CHANNELS_PER_USER,
} from '../utils/resourceLimits.js';
import type {
  Channel,
  ChannelMemberView,
  ChannelMessageView,
  ChannelSummary,
  ChannelType,
} from '../types/index.js';

const logger = createLogger('channels');

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

const repositories = () =>
  getPersistence(encryptionService).repositories.resources;

const channels = () => repositories().channels;
const messages = () => repositories().channelMessages;

const notFound = () => new ChannelError('Channel not found', 404);

export const CHANNEL_ATTACHMENT_BLOB_PURPOSE = 'channel-attachment';
const PENDING_ATTACHMENT_TTL_MS = 15 * 60 * 1000;
const pendingAttachmentKey = (userId: string, attachmentId: string): string =>
  `channel-upload:${userId}:${attachmentId}`;

const isChannelType = (value: unknown): value is ChannelType =>
  value === 'public' || value === 'private' || value === 'dm';

/** Deterministic identity for a DM pair, order-independent. */
export const dmKeyFor = (left: string, right: string): string =>
  ['dm', ...[left, right].sort()].join(':');

const decryptOptional = (value: string | null): string | undefined => {
  if (!value) return undefined;
  try {
    return encryptionService.decrypt(value);
  } catch {
    return undefined;
  }
};

const mapChannel = (row: StoredChannelRecord): Channel => ({
  id: row.id,
  type: row.type as ChannelType,
  name: row.name ? (decryptOptional(row.name) ?? '') : '',
  ...(row.description ? { description: decryptOptional(row.description) } : {}),
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
});

interface MessageViewContext {
  actorUserId: string;
  usernames: Map<string, string>;
  replyCounts: Record<string, number>;
  reactions: Map<
    string,
    Array<{ emoji: string; count: number; mine: boolean }>
  >;
  attachments: Map<
    string,
    Array<{ id: string; filename: string; contentType: string; size: number }>
  >;
}

const readMetadata = (
  row: StoredChannelMessageRecord
): { pending?: boolean; error?: string } => {
  if (!row.metadata) return {};
  try {
    const decoded = JSON.parse(
      encryptionService.decrypt(row.metadata)
    ) as Record<string, unknown>;
    return {
      ...(decoded.pending === true ? { pending: true } : {}),
      ...(typeof decoded.error === 'string' ? { error: decoded.error } : {}),
    };
  } catch {
    return {};
  }
};

const mapMessage = (
  row: StoredChannelMessageRecord,
  context: MessageViewContext
): ChannelMessageView => {
  const deleted = row.deleted_at !== null;
  const metadata = deleted ? {} : readMetadata(row);
  return {
    id: row.id,
    channelId: row.channel_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    authorKind: row.author_kind === 'model' ? 'model' : 'user',
    ...(row.model ? { model: row.model } : {}),
    author: row.user_id
      ? {
          userId: row.user_id,
          username: context.usernames.get(row.user_id) ?? row.user_id,
        }
      : null,
    content: deleted ? '' : (decryptOptional(row.content) ?? ''),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.edited_at ? { editedAt: row.edited_at } : {}),
    ...(deleted ? { deleted: true } : {}),
    ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
    ...(context.replyCounts[row.id]
      ? { replyCount: context.replyCounts[row.id] }
      : {}),
    ...(context.reactions.has(row.id)
      ? { reactions: context.reactions.get(row.id) }
      : {}),
    ...(context.attachments.has(row.id)
      ? { attachments: context.attachments.get(row.id) }
      : {}),
    ...metadata,
  };
};

const resolveUsernames = async (
  userIds: Iterable<string>
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  for (const userId of new Set(userIds)) {
    try {
      const user = await userModel.getUserById(userId);
      if (user) names.set(userId, user.username);
    } catch {
      // A deleted account renders as its identifier.
    }
  }
  return names;
};

/** Live fan-out is best-effort; SQL rows are the recovery path. */
const appendChannelEvent = async (
  channelId: string,
  eventType: string,
  subjectId: string,
  actorUserId: string,
  payload: unknown
): Promise<void> => {
  try {
    await getDurableEventGateway().append({
      eventId: randomUUID(),
      streamId: channelEventStreamId(channelId),
      eventType,
      subjectId,
      actorUserId,
      payload: { mode: 'encrypted', value: payload },
    });
  } catch (error) {
    logger.warn('Channel event fan-out failed; timeline reads recover', {
      channelId,
      eventType,
      error,
    });
  }
};

const buildViewContext = async (
  actorUserId: string,
  rows: readonly StoredChannelMessageRecord[]
): Promise<MessageViewContext> => {
  const messageIds = rows.map(row => row.id);
  const rootIds = rows.filter(row => !row.parent_id).map(row => row.id);
  const [replyCounts, reactionRows, attachmentRows] = await Promise.all([
    rootIds.length > 0
      ? messages().countThreadReplies(rootIds)
      : Promise.resolve({}),
    messages().listReactionsForMessages(messageIds),
    messages().listAttachmentsForMessages(messageIds),
  ]);
  const reactions = new Map<
    string,
    Array<{ emoji: string; count: number; mine: boolean }>
  >();
  for (const reaction of reactionRows) {
    const list = reactions.get(reaction.message_id) ?? [];
    const existing = list.find(entry => entry.emoji === reaction.emoji);
    if (existing) {
      existing.count += 1;
      if (reaction.user_id === actorUserId) existing.mine = true;
    } else {
      list.push({
        emoji: reaction.emoji,
        count: 1,
        mine: reaction.user_id === actorUserId,
      });
      reactions.set(reaction.message_id, list);
    }
  }
  const attachments = new Map<
    string,
    Array<{ id: string; filename: string; contentType: string; size: number }>
  >();
  for (const attachment of attachmentRows) {
    const list = attachments.get(attachment.message_id) ?? [];
    list.push({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      size: attachment.size,
    });
    attachments.set(attachment.message_id, list);
  }
  const usernames = await resolveUsernames(
    rows.flatMap(row => (row.user_id ? [row.user_id] : []))
  );
  return { actorUserId, usernames, replyCounts, reactions, attachments };
};

const mapRows = async (
  actorUserId: string,
  rows: readonly StoredChannelMessageRecord[]
): Promise<ChannelMessageView[]> => {
  const context = await buildViewContext(actorUserId, rows);
  return rows.map(row => mapMessage(row, context));
};

export class ChannelService {
  /** Membership gate used by every channel read and write. */
  async requireMember(
    channelId: string,
    userId: string
  ): Promise<{
    channel: StoredChannelRecord;
    member: StoredChannelMemberRecord;
  }> {
    const channel = await channels().findById(channelId);
    if (!channel) throw notFound();
    const member = await channels().findMember(channelId, userId);
    if (!member) throw notFound();
    return { channel, member };
  }

  async createChannel(
    actor: { userId: string },
    input: {
      type: string;
      name: string;
      description?: string;
      memberIds?: readonly string[];
    }
  ): Promise<Channel> {
    if (!isChannelType(input.type) || input.type === 'dm') {
      throw new ChannelError('Channel type must be public or private', 400);
    }
    const name = (input.name ?? '').trim();
    if (!name || name.length > MAX_CHANNEL_NAME_LENGTH) {
      throw new ChannelError('Channel name is required', 400);
    }
    if ((input.description?.length ?? 0) > MAX_CHANNEL_DESCRIPTION_LENGTH) {
      throw new ChannelError('Channel description is too long', 400);
    }
    const now = Date.now();
    const channel: StoredChannelRecord = {
      id: randomUUID(),
      type: input.type,
      name: encryptionService.encrypt(name),
      description: input.description
        ? encryptionService.encrypt(input.description)
        : null,
      dm_key: null,
      created_by: actor.userId,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    try {
      await channels().insertWithOwner(
        channel,
        {
          channel_id: channel.id,
          user_id: actor.userId,
          role: 'owner',
          joined_at: now,
          last_read_at: now,
        },
        MAX_CHANNELS_PER_USER
      );
    } catch (error) {
      if (error instanceof PersistenceResourceLimitError) {
        throw new ChannelError(
          `A user may create at most ${MAX_CHANNELS_PER_USER} channels`,
          409
        );
      }
      throw error;
    }
    for (const memberId of new Set(input.memberIds ?? [])) {
      if (memberId === actor.userId) continue;
      await this.addMember({ userId: actor.userId }, channel.id, memberId);
    }
    return mapChannel(channel);
  }

  /** Opens (or returns) the deterministic DM channel between two users. */
  async openDm(
    actor: { userId: string },
    peerUserId: string
  ): Promise<Channel> {
    if (!peerUserId || peerUserId === actor.userId) {
      throw new ChannelError('A direct message needs another user', 400);
    }
    const peer = await userModel.getUserById(peerUserId);
    if (!peer) throw new ChannelError('User not found', 404);
    const dmKey = dmKeyFor(actor.userId, peerUserId);
    const existing = await channels().findByDmKey(dmKey);
    if (existing) {
      // Re-attach either participant who previously left.
      const now = Date.now();
      for (const userId of [actor.userId, peerUserId]) {
        if (!(await channels().findMember(existing.id, userId))) {
          await channels().upsertMember(
            {
              channel_id: existing.id,
              user_id: userId,
              role: 'member',
              joined_at: now,
              last_read_at: userId === actor.userId ? now : 0,
            },
            MAX_CHANNEL_MEMBERS
          );
        }
      }
      return mapChannel(existing);
    }
    const now = Date.now();
    const channel: StoredChannelRecord = {
      id: randomUUID(),
      type: 'dm',
      name: encryptionService.encrypt(''),
      description: null,
      dm_key: dmKey,
      created_by: actor.userId,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    await channels().insertWithOwner(
      channel,
      {
        channel_id: channel.id,
        user_id: actor.userId,
        role: 'member',
        joined_at: now,
        last_read_at: now,
      },
      MAX_CHANNELS_PER_USER
    );
    await channels().upsertMember(
      {
        channel_id: channel.id,
        user_id: peerUserId,
        role: 'member',
        joined_at: now,
        last_read_at: 0,
      },
      MAX_CHANNEL_MEMBERS
    );
    return mapChannel(channel);
  }

  /** The actor's channels with unread counts, newest activity first. */
  async listMine(actor: { userId: string }): Promise<ChannelSummary[]> {
    const memberships = await channels().listForUser(
      actor.userId,
      MAX_CHANNELS_LISTED
    );
    const unread = await channels().unreadSummaryForUser(actor.userId);
    const unreadByChannel = new Map(
      unread.map(row => [row.channel_id, row] as const)
    );
    const summaries: ChannelSummary[] = [];
    for (const { channel, member } of memberships) {
      const summary: ChannelSummary = {
        ...mapChannel(channel),
        role: member.role as ChannelSummary['role'],
        isMember: true,
        lastReadAt: member.last_read_at,
        unreadCount: unreadByChannel.get(channel.id)?.unread_count ?? 0,
        latestMessageAt:
          unreadByChannel.get(channel.id)?.latest_message_at ?? null,
      };
      if (channel.type === 'dm') {
        const members = await channels().listMembers(channel.id, 4);
        const peer = members.find(entry => entry.user_id !== actor.userId);
        if (peer) {
          const names = await resolveUsernames([peer.user_id]);
          summary.dmPeer = {
            userId: peer.user_id,
            username: names.get(peer.user_id) ?? peer.user_id,
          };
        }
      }
      summaries.push(summary);
    }
    return summaries;
  }

  /** Browseable public channels with membership state. */
  async listPublic(actor: { userId: string }): Promise<ChannelSummary[]> {
    const rows = await channels().listPublic(MAX_CHANNELS_LISTED);
    const summaries: ChannelSummary[] = [];
    for (const row of rows) {
      const member = await channels().findMember(row.id, actor.userId);
      summaries.push({
        ...mapChannel(row),
        isMember: Boolean(member),
        ...(member ? { role: member.role as ChannelSummary['role'] } : {}),
      });
    }
    return summaries;
  }

  async getChannel(
    actor: { userId: string },
    channelId: string
  ): Promise<ChannelSummary> {
    const channel = await channels().findById(channelId);
    if (!channel) throw notFound();
    const member = await channels().findMember(channelId, actor.userId);
    if (!member && channel.type !== 'public') throw notFound();
    const summary: ChannelSummary = {
      ...mapChannel(channel),
      isMember: Boolean(member),
      ...(member ? { role: member.role as ChannelSummary['role'] } : {}),
      ...(member ? { lastReadAt: member.last_read_at } : {}),
    };
    if (channel.type === 'dm' && member) {
      const members = await channels().listMembers(channel.id, 4);
      const peer = members.find(entry => entry.user_id !== actor.userId);
      if (peer) {
        const names = await resolveUsernames([peer.user_id]);
        summary.dmPeer = {
          userId: peer.user_id,
          username: names.get(peer.user_id) ?? peer.user_id,
        };
      }
    }
    return summary;
  }

  async updateChannel(
    actor: { userId: string },
    channelId: string,
    updates: { name?: string; description?: string; archived?: boolean }
  ): Promise<Channel> {
    const { channel, member } = await this.requireMember(
      channelId,
      actor.userId
    );
    if (member.role !== 'owner') throw notFound();
    if (channel.type === 'dm') {
      throw new ChannelError('Direct messages cannot be renamed', 400);
    }
    const next: StoredChannelRecord = { ...channel, updated_at: Date.now() };
    if (updates.name !== undefined) {
      const name = updates.name.trim();
      if (!name || name.length > MAX_CHANNEL_NAME_LENGTH) {
        throw new ChannelError('Channel name is required', 400);
      }
      next.name = encryptionService.encrypt(name);
    }
    if (updates.description !== undefined) {
      if (updates.description.length > MAX_CHANNEL_DESCRIPTION_LENGTH) {
        throw new ChannelError('Channel description is too long', 400);
      }
      next.description = updates.description
        ? encryptionService.encrypt(updates.description)
        : null;
    }
    if (updates.archived !== undefined) {
      next.archived_at = updates.archived ? Date.now() : null;
    }
    await channels().update(next);
    await appendChannelEvent(
      channelId,
      'channel.updated.v1',
      channelId,
      actor.userId,
      {
        type: 'channel_updated',
        channelId,
      }
    );
    return mapChannel(next);
  }

  async deleteChannel(
    actor: { userId: string },
    channelId: string
  ): Promise<void> {
    const { channel, member } = await this.requireMember(
      channelId,
      actor.userId
    );
    if (channel.type !== 'dm' && member.role !== 'owner') throw notFound();
    const blobs = await messages().listAttachmentBlobIds(channelId);
    await channels().delete(channelId);
    if (blobs.length > 0) {
      try {
        const { getPlatformStorageRuntime } =
          await import('../platform/storage/index.js');
        const blobStore = getPlatformStorageRuntime().blobStore;
        for (const blob of blobs) {
          if (!blob.created_by) continue;
          await blobStore
            .delete({ id: blob.blob_id, ownerUserId: blob.created_by })
            .catch(() => undefined);
        }
      } catch (error) {
        logger.warn('Channel attachment blob cleanup failed', { error });
      }
    }
  }

  async addMember(
    actor: { userId: string },
    channelId: string,
    userId: string
  ): Promise<ChannelMemberView> {
    const { channel, member } = await this.requireMember(
      channelId,
      actor.userId
    );
    if (channel.type === 'dm') {
      throw new ChannelError('Direct messages are limited to two people', 400);
    }
    if (channel.type === 'private' && member.role !== 'owner') {
      throw notFound();
    }
    const user = await userModel.getUserById(userId);
    if (!user) throw new ChannelError('User not found', 404);
    try {
      await channels().upsertMember(
        {
          channel_id: channelId,
          user_id: userId,
          role: 'member',
          joined_at: Date.now(),
          last_read_at: 0,
        },
        MAX_CHANNEL_MEMBERS
      );
    } catch (error) {
      if (error instanceof PersistenceResourceLimitError) {
        throw new ChannelError(
          `A channel may have at most ${MAX_CHANNEL_MEMBERS} members`,
          409
        );
      }
      throw error;
    }
    await appendChannelEvent(
      channelId,
      'channel.member.v1',
      userId,
      actor.userId,
      {
        type: 'member_added',
        channelId,
        userId,
      }
    );
    return {
      userId,
      username: user.username,
      role: 'member',
      joinedAt: Date.now(),
    };
  }

  /** Join a public channel. */
  async join(actor: { userId: string }, channelId: string): Promise<void> {
    const channel = await channels().findById(channelId);
    if (!channel || channel.type !== 'public' || channel.archived_at) {
      throw notFound();
    }
    try {
      await channels().upsertMember(
        {
          channel_id: channelId,
          user_id: actor.userId,
          role: 'member',
          joined_at: Date.now(),
          last_read_at: Date.now(),
        },
        MAX_CHANNEL_MEMBERS
      );
    } catch (error) {
      if (error instanceof PersistenceResourceLimitError) {
        throw new ChannelError(
          `A channel may have at most ${MAX_CHANNEL_MEMBERS} members`,
          409
        );
      }
      throw error;
    }
    await appendChannelEvent(
      channelId,
      'channel.member.v1',
      actor.userId,
      actor.userId,
      { type: 'member_added', channelId, userId: actor.userId }
    );
  }

  async removeMember(
    actor: { userId: string },
    channelId: string,
    userId: string
  ): Promise<void> {
    const { channel, member } = await this.requireMember(
      channelId,
      actor.userId
    );
    const leaving = userId === actor.userId;
    if (!leaving && member.role !== 'owner') throw notFound();
    if (channel.type === 'dm' && !leaving) {
      throw new ChannelError('Direct-message members cannot be removed', 400);
    }
    if (leaving && member.role === 'owner') {
      throw new ChannelError(
        'The channel owner must delete the channel instead of leaving it',
        400
      );
    }
    const removed = await channels().removeMember(channelId, userId);
    if (!removed) throw notFound();
    await appendChannelEvent(
      channelId,
      'channel.member.v1',
      userId,
      actor.userId,
      {
        type: 'member_removed',
        channelId,
        userId,
      }
    );
  }

  async listMembers(
    actor: { userId: string },
    channelId: string
  ): Promise<ChannelMemberView[]> {
    await this.requireMember(channelId, actor.userId);
    const rows = await channels().listMembers(channelId, MAX_CHANNEL_MEMBERS);
    const usernames = await resolveUsernames(rows.map(row => row.user_id));
    return rows.map(row => ({
      userId: row.user_id,
      username: usernames.get(row.user_id) ?? row.user_id,
      role: row.role as ChannelMemberView['role'],
      joinedAt: row.joined_at,
    }));
  }

  /**
   * Idempotent post: the client supplies the message id, so a retried
   * request lands on the same timeline entry and fans out exactly once.
   */
  async postMessage(
    actor: { userId: string },
    channelId: string,
    input: {
      id?: string;
      content: string;
      parentId?: string;
      authorKind?: 'user' | 'model';
      model?: string;
      metadata?: { pending?: boolean; error?: string };
      attachments?: readonly StoredChannelAttachmentRecord[];
    }
  ): Promise<{ message: ChannelMessageView; created: boolean }> {
    const { channel } = await this.requireMember(channelId, actor.userId);
    if (channel.archived_at) {
      throw new ChannelError('This channel is archived', 409);
    }
    const content = input.content ?? '';
    // Pending model replies legitimately start empty; user posts need
    // either text or an attachment.
    if (
      !content.trim() &&
      (input.attachments?.length ?? 0) === 0 &&
      input.authorKind !== 'model'
    ) {
      throw new ChannelError('Message content is required', 400);
    }
    if (content.length > MAX_CHANNEL_MESSAGE_LENGTH) {
      throw new ChannelError('Message content is too long', 400);
    }
    if (input.parentId) {
      const parent = await messages().findById(input.parentId);
      if (!parent || parent.channel_id !== channelId) throw notFound();
      if (parent.parent_id) {
        throw new ChannelError('Threads are one level deep', 400);
      }
    }
    const now = Date.now();
    const record: StoredChannelMessageRecord = {
      id: input.id ?? randomUUID(),
      channel_id: channelId,
      user_id: actor.userId,
      parent_id: input.parentId ?? null,
      author_kind: input.authorKind === 'model' ? 'model' : 'user',
      model: input.model ?? null,
      content: encryptionService.encrypt(content),
      metadata: input.metadata
        ? encryptionService.encrypt(JSON.stringify(input.metadata))
        : null,
      created_at: now,
      updated_at: now,
      edited_at: null,
      deleted_at: null,
      pinned_at: null,
      pinned_by: null,
    };
    let stored: StoredChannelMessageRecord;
    let inserted: boolean;
    try {
      ({ stored, inserted } = await messages().insertIfAbsent(
        record,
        input.attachments ?? [],
        MAX_CHANNEL_MESSAGES
      ));
    } catch (error) {
      if (error instanceof PersistenceResourceLimitError) {
        throw new ChannelError('This channel is full', 409);
      }
      throw error;
    }
    if (inserted && stored.user_id === actor.userId) {
      // The author has read their own message.
      await channels().advanceLastRead(channelId, actor.userId, now);
    }
    const [view] = await mapRows(actor.userId, [stored]);
    if (inserted) {
      await appendChannelEvent(
        channelId,
        'channel.message.v1',
        stored.id,
        actor.userId,
        { type: 'message_created', message: view }
      );
    }
    return { message: view!, created: inserted };
  }

  async editMessage(
    actor: { userId: string },
    messageId: string,
    content: string
  ): Promise<ChannelMessageView> {
    const row = await messages().findById(messageId);
    if (!row || row.deleted_at) throw notFound();
    await this.requireMember(row.channel_id, actor.userId);
    if (row.user_id !== actor.userId || row.author_kind !== 'user') {
      throw notFound();
    }
    if (!content.trim() || content.length > MAX_CHANNEL_MESSAGE_LENGTH) {
      throw new ChannelError('Message content is required', 400);
    }
    const now = Date.now();
    const next: StoredChannelMessageRecord = {
      ...row,
      content: encryptionService.encrypt(content),
      updated_at: now,
      edited_at: now,
    };
    await messages().update(next);
    const [view] = await mapRows(actor.userId, [next]);
    await appendChannelEvent(
      row.channel_id,
      'channel.message.v1',
      messageId,
      actor.userId,
      { type: 'message_edited', message: view }
    );
    return view!;
  }

  /**
   * Tombstone deletion: the row survives with cleared content so replies
   * and the ordered timeline stay intact. Attachments are removed.
   */
  async deleteMessage(
    actor: { userId: string },
    messageId: string
  ): Promise<void> {
    const row = await messages().findById(messageId);
    if (!row || row.deleted_at) throw notFound();
    const { member } = await this.requireMember(row.channel_id, actor.userId);
    if (row.user_id !== actor.userId && member.role !== 'owner') {
      throw notFound();
    }
    const now = Date.now();
    const next: StoredChannelMessageRecord = {
      ...row,
      content: encryptionService.encrypt(''),
      metadata: null,
      updated_at: now,
      deleted_at: now,
      pinned_at: null,
      pinned_by: null,
    };
    await messages().update(next);
    await appendChannelEvent(
      row.channel_id,
      'channel.message.v1',
      messageId,
      actor.userId,
      { type: 'message_deleted', messageId, channelId: row.channel_id }
    );
  }

  async setPinned(
    actor: { userId: string },
    messageId: string,
    pinned: boolean
  ): Promise<ChannelMessageView> {
    const row = await messages().findById(messageId);
    if (!row || row.deleted_at) throw notFound();
    await this.requireMember(row.channel_id, actor.userId);
    const now = Date.now();
    const next: StoredChannelMessageRecord = {
      ...row,
      pinned_at: pinned ? now : null,
      pinned_by: pinned ? actor.userId : null,
      updated_at: now,
    };
    await messages().update(next);
    const [view] = await mapRows(actor.userId, [next]);
    await appendChannelEvent(
      row.channel_id,
      'channel.pin.v1',
      messageId,
      actor.userId,
      { type: pinned ? 'message_pinned' : 'message_unpinned', message: view }
    );
    return view!;
  }

  async listPinned(
    actor: { userId: string },
    channelId: string
  ): Promise<ChannelMessageView[]> {
    await this.requireMember(channelId, actor.userId);
    const rows = await messages().listPinned(
      channelId,
      MAX_CHANNEL_PINNED_LISTED
    );
    return mapRows(actor.userId, rows);
  }

  async react(
    actor: { userId: string },
    messageId: string,
    emoji: string,
    add: boolean
  ): Promise<void> {
    const normalized = (emoji ?? '').trim();
    if (
      !normalized ||
      normalized.length > MAX_CHANNEL_EMOJI_LENGTH ||
      [...normalized].some(character => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      throw new ChannelError('Invalid reaction', 400);
    }
    const row = await messages().findById(messageId);
    if (!row || row.deleted_at) throw notFound();
    await this.requireMember(row.channel_id, actor.userId);
    let changed: boolean;
    if (add) {
      try {
        changed = await messages().addReaction(
          {
            id: randomUUID(),
            message_id: messageId,
            user_id: actor.userId,
            emoji: normalized,
            created_at: Date.now(),
          },
          MAX_CHANNEL_REACTIONS_PER_MESSAGE
        );
      } catch (error) {
        if (error instanceof PersistenceResourceLimitError) {
          throw new ChannelError('This message has too many reactions', 409);
        }
        throw error;
      }
    } else {
      changed = await messages().removeReaction(
        messageId,
        actor.userId,
        normalized
      );
    }
    if (changed) {
      await appendChannelEvent(
        row.channel_id,
        'channel.reaction.v1',
        messageId,
        actor.userId,
        {
          type: add ? 'reaction_added' : 'reaction_removed',
          messageId,
          channelId: row.channel_id,
          emoji: normalized,
          userId: actor.userId,
        }
      );
    }
  }

  /** Root timeline page (newest-first before / oldest-first after). */
  async listTimeline(
    actor: { userId: string },
    channelId: string,
    options: {
      before?: ChannelTimelineCursor;
      after?: ChannelTimelineCursor;
      limit?: number;
    }
  ): Promise<ChannelMessageView[]> {
    await this.requireMember(channelId, actor.userId);
    const limit = Math.min(
      Math.max(options.limit ?? 50, 1),
      MAX_CHANNEL_PAGE_SIZE
    );
    const rows = await messages().listPage(channelId, {
      parentId: null,
      ...(options.before ? { before: options.before } : {}),
      ...(options.after ? { after: options.after } : {}),
      limit,
    });
    // Deliver oldest-first regardless of the paging direction.
    const ordered = options.after ? rows : [...rows].reverse();
    return mapRows(actor.userId, ordered);
  }

  async listThread(
    actor: { userId: string },
    parentId: string
  ): Promise<ChannelMessageView[]> {
    const parent = await messages().findById(parentId);
    if (!parent) throw notFound();
    await this.requireMember(parent.channel_id, actor.userId);
    const rows = await messages().listThread(
      parentId,
      MAX_CHANNEL_THREAD_PAGE_SIZE
    );
    return mapRows(actor.userId, [parent, ...rows]);
  }

  /** Advance the read cursor; it never moves backwards. */
  async markRead(
    actor: { userId: string },
    channelId: string,
    lastReadAt?: number
  ): Promise<void> {
    await this.requireMember(channelId, actor.userId);
    const at =
      lastReadAt !== undefined && Number.isSafeInteger(lastReadAt)
        ? lastReadAt
        : Date.now();
    await channels().advanceLastRead(channelId, actor.userId, at);
  }

  async findMessage(
    messageId: string
  ): Promise<StoredChannelMessageRecord | null> {
    return messages().findById(messageId);
  }

  /**
   * Stores an uploaded file as a blob owned by the uploader and parks its
   * descriptor in the coordination cache until a message claims it. The
   * cache is shared across replicas, so upload and post may hit different
   * nodes.
   */
  async uploadAttachment(
    actor: { userId: string },
    channelId: string,
    file: { buffer: Buffer; filename: string; contentType: string }
  ): Promise<{
    id: string;
    filename: string;
    contentType: string;
    size: number;
  }> {
    await this.requireMember(channelId, actor.userId);
    if (file.buffer.length === 0) {
      throw new ChannelError('The attachment is empty', 400);
    }
    if (file.buffer.length > MAX_CHANNEL_ATTACHMENT_BYTES) {
      throw new ChannelError('The attachment exceeds the maximum size', 400);
    }
    const attachmentId = randomUUID();
    const platform = getPlatformStorageRuntime();
    const blob = await platform.blobStore.put({
      ownerUserId: actor.userId,
      purpose: CHANNEL_ATTACHMENT_BLOB_PURPOSE,
      contentType: file.contentType,
      originalFilename: file.filename,
      expectedSize: file.buffer.length,
      metadata: {
        resourceType: 'channel-attachment',
        resourceId: attachmentId,
      },
      source: Readable.from(file.buffer),
    });
    const coordinator = getCoordinator();
    await coordinator.setCache(
      pendingAttachmentKey(actor.userId, attachmentId),
      {
        channelId,
        blobId: blob.id,
        filename: file.filename,
        contentType: file.contentType,
        size: file.buffer.length,
      },
      PENDING_ATTACHMENT_TTL_MS
    );
    return {
      id: attachmentId,
      filename: file.filename,
      contentType: file.contentType,
      size: file.buffer.length,
    };
  }

  private async claimAttachments(
    actor: { userId: string },
    channelId: string,
    messageId: string,
    attachmentIds: readonly string[]
  ): Promise<StoredChannelAttachmentRecord[]> {
    if (attachmentIds.length === 0) return [];
    if (attachmentIds.length > MAX_CHANNEL_ATTACHMENTS_PER_MESSAGE) {
      throw new ChannelError(
        `A message may carry at most ${MAX_CHANNEL_ATTACHMENTS_PER_MESSAGE} attachments`,
        400
      );
    }
    const coordinator = getCoordinator();
    const records: StoredChannelAttachmentRecord[] = [];
    for (const attachmentId of new Set(attachmentIds)) {
      const pending = await coordinator.consumeCache<{
        channelId: string;
        blobId: string;
        filename: string;
        contentType: string;
        size: number;
      }>(pendingAttachmentKey(actor.userId, attachmentId));
      if (!pending || pending.channelId !== channelId) {
        throw new ChannelError('Attachment upload expired', 400);
      }
      records.push({
        id: attachmentId,
        message_id: messageId,
        channel_id: channelId,
        blob_id: pending.blobId,
        filename: pending.filename,
        content_type: pending.contentType,
        size: pending.size,
        created_by: actor.userId,
        created_at: Date.now(),
      });
    }
    return records;
  }

  /**
   * The user-facing post: claims uploaded attachments and, when the
   * composer named a model, appends a pending model reply and enqueues the
   * durable mention job under the invoking user's identity.
   */
  async postUserMessage(
    actor: { userId: string },
    channelId: string,
    input: {
      id?: string;
      content: string;
      parentId?: string;
      attachmentIds?: readonly string[];
      mentionModel?: string;
      mentionProviderType?: string;
      mentionProviderId?: string;
    }
  ): Promise<{ message: ChannelMessageView; created: boolean }> {
    const messageId = input.id ?? randomUUID();
    const attachments = await this.claimAttachments(
      actor,
      channelId,
      messageId,
      input.attachmentIds ?? []
    );
    const posted = await this.postMessage(actor, channelId, {
      id: messageId,
      content: input.content,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      attachments,
    });
    if (!posted.created || !input.mentionModel) return posted;

    // The pending reply and its durable job share deterministic identities,
    // so a retried request never produces a second model answer.
    const replyId = `${messageId}-model`;
    await this.postMessage(actor, channelId, {
      id: replyId,
      content: '',
      ...(input.parentId ? { parentId: input.parentId } : {}),
      authorKind: 'model',
      model: input.mentionModel,
      metadata: { pending: true },
    });
    try {
      await getDurableJobRuntime().service.enqueue({
        jobType: CHANNEL_MENTION_JOB_TYPE,
        actorUserId: actor.userId,
        payload: {
          mode: 'encrypted',
          value: {
            channelId,
            promptMessageId: messageId,
            replyMessageId: replyId,
            model: input.mentionModel,
            ...(input.mentionProviderType
              ? { providerType: input.mentionProviderType }
              : {}),
            ...(input.mentionProviderId
              ? { providerId: input.mentionProviderId }
              : {}),
          },
        },
        idempotencyScope: CHANNEL_MENTION_IDEMPOTENCY_SCOPE,
        idempotencyKey: replyId,
        maxAttempts: 2,
      });
    } catch (error) {
      logger.error('Failed to enqueue a channel model mention', { error });
      await this.failModelReply(replyId, 'The model request could not start');
    }
    return posted;
  }

  /** Reply completion used by the durable mention job. */
  async completeModelReply(
    replyMessageId: string,
    content: string
  ): Promise<void> {
    const row = await messages().findById(replyMessageId);
    if (!row || row.deleted_at) return;
    const now = Date.now();
    const next: StoredChannelMessageRecord = {
      ...row,
      content: encryptionService.encrypt(content),
      metadata: null,
      updated_at: now,
    };
    await messages().update(next);
    const [view] = await mapRows(row.user_id ?? 'default', [next]);
    await appendChannelEvent(
      row.channel_id,
      'channel.message.v1',
      replyMessageId,
      row.user_id ?? 'default',
      { type: 'message_edited', message: view }
    );
  }

  async failModelReply(
    replyMessageId: string,
    errorSummary: string
  ): Promise<void> {
    const row = await messages().findById(replyMessageId);
    if (!row || row.deleted_at) return;
    const now = Date.now();
    const next: StoredChannelMessageRecord = {
      ...row,
      metadata: encryptionService.encrypt(
        JSON.stringify({ error: errorSummary })
      ),
      updated_at: now,
    };
    await messages().update(next);
    const [view] = await mapRows(row.user_id ?? 'default', [next]);
    await appendChannelEvent(
      row.channel_id,
      'channel.message.v1',
      replyMessageId,
      row.user_id ?? 'default',
      { type: 'message_edited', message: view }
    );
  }

  /**
   * Recent decrypted conversation context for a model mention, oldest
   * first, ending at the prompting message.
   */
  async mentionContext(
    channelId: string,
    promptMessageId: string
  ): Promise<Array<{ author: string; content: string }>> {
    const prompt = await messages().findById(promptMessageId);
    if (!prompt) return [];
    const rows = await messages().listPage(channelId, {
      parentId: prompt.parent_id ? prompt.parent_id : null,
      before: { created_at: prompt.created_at, id: prompt.id },
      limit: MAX_CHANNEL_MENTION_CONTEXT_MESSAGES,
    });
    const ordered = [...rows].reverse();
    ordered.push(prompt);
    const usernames = await resolveUsernames(
      ordered.flatMap(row => (row.user_id ? [row.user_id] : []))
    );
    return ordered.flatMap(row => {
      if (row.deleted_at) return [];
      const content = decryptOptional(row.content);
      if (!content) return [];
      const author =
        row.author_kind === 'model'
          ? `${row.model ?? 'assistant'} (model)`
          : (usernames.get(row.user_id ?? '') ?? 'someone');
      return [{ author, content }];
    });
  }

  async openAttachment(
    actor: { userId: string },
    attachmentId: string
  ): Promise<{
    attachment: {
      id: string;
      filename: string;
      contentType: string;
      size: number;
    };
    body: BlobReadResult;
  }> {
    const attachment = await messages().findAttachment(attachmentId);
    if (!attachment) throw notFound();
    await this.requireMember(attachment.channel_id, actor.userId);
    if (!attachment.created_by) throw notFound();
    const body = await getPlatformStorageRuntime().blobStore.open({
      id: attachment.blob_id,
      ownerUserId: attachment.created_by,
    });
    return {
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        size: attachment.size,
      },
      body,
    };
  }

  /** Recent decrypted candidates from the actor's channels, for search. */
  async searchCandidates(
    actor: { userId: string },
    maximum: number
  ): Promise<
    Array<{
      channelId: string;
      messageId: string;
      content: string;
      createdAt: number;
    }>
  > {
    const memberships = await channels().listForUser(
      actor.userId,
      MAX_CHANNELS_LISTED
    );
    const rows = await messages().listRecentForChannels(
      memberships.map(entry => entry.channel.id),
      maximum
    );
    return rows.flatMap(row => {
      const content = decryptOptional(row.content);
      return content
        ? [
            {
              channelId: row.channel_id,
              messageId: row.id,
              content,
              createdAt: row.created_at,
            },
          ]
        : [];
    });
  }
}

export const channelService = new ChannelService();
