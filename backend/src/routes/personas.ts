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

import { Router, Request, Response } from 'express';
import { personaService } from '../services/personaService';
import { ApiResponse, getErrorMessage } from '../types';

const router = Router();

/**
 * Get all personas for the current user
 */
router.get(
  '/',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const userId = req.user?.userId || 'default';
      const personas = await personaService.getPersonas(userId);

      res.json({
        success: true,
        data: personas,
        message: `Found ${personas.length} personas`,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to fetch personas'),
      });
    }
  }
);

/**
 * Get a specific persona by ID
 */
router.get(
  '/:id',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId || 'default';

      const persona = await personaService.getPersonaById(id, userId);

      if (!persona) {
        res.status(404).json({
          success: false,
          error: 'Persona not found',
        });
        return;
      }

      res.json({
        success: true,
        data: persona,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to fetch persona'),
      });
    }
  }
);

/**
 * Create a new persona
 */
router.post(
  '/',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const userId = req.user?.userId || 'default';
      const persona = await personaService.createPersona(req.body, userId);

      res.status(201).json({
        success: true,
        data: persona,
        message: 'Persona created successfully',
      });
    } catch (error: unknown) {
      res.status(400).json({
        success: false,
        error: getErrorMessage(error, 'Failed to create persona'),
      });
    }
  }
);

/**
 * Update an existing persona
 */
router.put(
  '/:id',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId || 'default';

      const persona = await personaService.updatePersona(id, req.body, userId);

      if (!persona) {
        res.status(404).json({
          success: false,
          error: 'Persona not found',
        });
        return;
      }

      res.json({
        success: true,
        data: persona,
        message: 'Persona updated successfully',
      });
    } catch (error: unknown) {
      res.status(400).json({
        success: false,
        error: getErrorMessage(error, 'Failed to update persona'),
      });
    }
  }
);

/**
 * Delete a persona
 */
router.delete(
  '/:id',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId || 'default';

      const success = await personaService.deletePersona(id, userId);

      if (!success) {
        res.status(404).json({
          success: false,
          error: 'Persona not found',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Persona deleted successfully',
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete persona'),
      });
    }
  }
);

/**
 * Export a persona as JSON
 */
router.get(
  '/:id/export',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId || 'default';

      const personaExport = await personaService.exportPersona(id, userId);

      // Set headers for file download
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${personaExport.name}.json"`
      );

      res.json(personaExport);
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to export persona'),
      });
    }
  }
);

/**
 * Import a persona from JSON
 */
router.post(
  '/import',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const userId = req.user?.userId || 'default';
      const persona = await personaService.importPersona(req.body, userId);

      res.status(201).json({
        success: true,
        data: persona,
        message: 'Persona imported successfully',
      });
    } catch (error: unknown) {
      res.status(400).json({
        success: false,
        error: getErrorMessage(error, 'Failed to import persona'),
      });
    }
  }
);

/**
 * Get personas count for the current user
 */
router.get(
  '/stats/count',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const userId = req.user?.userId || 'default';
      const count = await personaService.getPersonasCount(userId);

      res.json({
        success: true,
        data: { count },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get personas count'),
      });
    }
  }
);

/**
 * Get default persona parameters
 */
router.get(
  '/defaults/parameters',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const defaults = personaService.getDefaultParameters();

      res.json({
        success: true,
        data: defaults,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get default parameters'),
      });
    }
  }
);

/**
 * Download/Export a specific persona as JSON file
 */
router.get(
  '/:id/download',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId || 'default';

      const persona = await personaService.getPersonaById(id, userId);

      if (!persona) {
        res.status(404).json({
          success: false,
          error: 'Persona not found',
        });
        return;
      }

      // Create export data with metadata
      const exportData = {
        format: 'libre-webui-persona',
        version: '1.0',
        persona: {
          name: persona.name,
          description: persona.description,
          model: persona.model,
          parameters: persona.parameters,
          avatar: persona.avatar,
          background: persona.background,
        },
        exportedAt: new Date().toISOString(),
        exportedBy: userId,
      };

      // Set headers for file download
      const fileName = `${persona.name.replace(/[^a-zA-Z0-9]/g, '_')}_persona.json`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );

      // Send raw JSON, not wrapped in API response
      res.send(JSON.stringify(exportData, null, 2));
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to download persona'),
      });
    }
  }
);

export default router;
