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

import express, { Response } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import agentCliService from '../services/agentCliService.js';

const router = express.Router();
router.use(authenticate);

/**
 * Installed agent CLIs usable as chat models. Non-admin users get an empty
 * list rather than an error so the model loader can call this unconditionally.
 */
router.get('/models', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.userId;
  const isAdmin = userId ? await agentCliService.isAdminUser(userId) : false;
  res.json({
    success: true,
    data: isAdmin ? await agentCliService.listAgentModels() : [],
  });
});

export default router;
