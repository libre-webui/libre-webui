/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Router, Request, Response } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { userModel } from '../models/userModel.js';
import {
  emailService,
  EmailSettingsError,
  type EmailSettingsUpdate,
} from '../services/emailService.js';
import { SmtpError } from '../utils/smtpClient.js';
import { getErrorMessage } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('email');
const router = Router();

router.use(authenticate);

const currentUserId = (req: Request): string | undefined =>
  (req as { user?: { userId?: string } }).user?.userId;

/**
 * Whether email notifications can be switched on. Open to any signed-in
 * user so the preferences panel can explain itself; the server details are
 * administrator configuration and only returned to administrators.
 */
router.get('/settings', async (req: Request, res: Response): Promise<void> => {
  const settings = await emailService.getSettings();
  const userId = currentUserId(req);
  const currentUser = userId ? await userModel.getUserById(userId) : null;
  // Authorization follows current database state, like requireAdmin.
  const isAdmin =
    currentUser?.status === 'active' && currentUser.role === 'admin';
  res.json({
    success: true,
    data: {
      available: settings.available,
      enabled: settings.enabled,
      // Whether this account can actually receive mail: an address is
      // required, and only the account holder or an admin can add one.
      recipient: currentUser?.email ?? null,
      ...(isAdmin
        ? {
            host: settings.host,
            port: settings.port,
            security: settings.security,
            username: settings.username,
            passwordConfigured: settings.passwordConfigured,
            from: settings.from,
            rejectUnauthorized: settings.rejectUnauthorized,
            appUrl: settings.appUrl,
            configured: settings.configured,
            sources: settings.sources,
          }
        : {}),
    },
  });
});

const readUpdate = (body: unknown): EmailSettingsUpdate => {
  const record = (body ?? {}) as Record<string, unknown>;
  const update: EmailSettingsUpdate = {};
  const text = (key: keyof EmailSettingsUpdate) => {
    const value = record[key];
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') {
      throw new EmailSettingsError(`The ${key} setting must be text.`);
    }
    (update as Record<string, unknown>)[key] = value;
  };
  const flag = (key: 'enabled' | 'rejectUnauthorized') => {
    const value = record[key];
    if (value === undefined || value === null) return;
    if (typeof value !== 'boolean') {
      throw new EmailSettingsError(`The ${key} setting must be true or false.`);
    }
    update[key] = value;
  };
  text('host');
  text('security');
  text('username');
  text('password');
  text('from');
  text('appUrl');
  flag('enabled');
  flag('rejectUnauthorized');
  if (record.port !== undefined && record.port !== null) {
    if (typeof record.port !== 'number' && typeof record.port !== 'string') {
      throw new EmailSettingsError('The port setting must be a number.');
    }
    update.port = record.port;
  }
  return update;
};

router.put(
  '/settings',
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const settings = await emailService.updateSettings(readUpdate(req.body));
      res.json({ success: true, data: settings });
    } catch (error) {
      if (error instanceof EmailSettingsError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      logger.error('Could not update the email settings', { error });
      res.status(500).json({
        success: false,
        error: 'Could not update the email settings.',
      });
    }
  }
);

/**
 * Admin connectivity probe. Without a recipient it only opens a session and
 * authenticates; with one it sends a short test message there. Defaults to
 * the administrator's own address so the round trip is real.
 */
router.post(
  '/test',
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const userId = currentUserId(req);
    const currentUser = userId ? await userModel.getUserById(userId) : null;
    const requested = req.body?.to;
    const to =
      typeof requested === 'string' && requested.trim()
        ? requested.trim()
        : (currentUser?.email ?? undefined);
    try {
      const result = await emailService.test({
        ...(to ? { to } : {}),
        requestedBy: currentUser?.username ?? 'an administrator',
      });
      res.json({ success: true, data: { ok: true, ...result } });
    } catch (error) {
      const status =
        error instanceof EmailSettingsError
          ? 400
          : error instanceof SmtpError
            ? 502
            : 500;
      if (status === 500) {
        logger.error('Email test failed unexpectedly', { error });
      }
      res.status(status).json({
        success: false,
        error: getErrorMessage(error, 'The email test failed.'),
        ...(error instanceof SmtpError ? { code: error.code } : {}),
      });
    }
  }
);

export default router;
