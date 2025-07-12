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
import { personaService } from '../services/personaService.js';
import { ApiResponse, getErrorMessage } from '../types/index.js';

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

      // Create export data that matches PersonaExport interface
      const exportData = {
        name: persona.name,
        description: persona.description,
        model: persona.model,
        params: persona.parameters, // Use 'params' to match PersonaExport interface
        avatar: persona.avatar,
        background: persona.background,
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

// === Advanced Features Endpoints ===

/**
 * Get memory status for a persona
 */
router.get(
  '/:id/memory/status',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId || 'default';

      // Import memory service dynamically to avoid dependency issues
      const { memoryService } = await import('../services/memoryService.js');
      const status = await memoryService.getMemoryStatus(id, userId);

      res.json({
        success: true,
        data: status,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get memory status'),
      });
    }
  }
);

/**
 * Wipe memories for a persona
 */
router.delete(
  '/:id/memory',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId || 'default';

      const { memoryService } = await import('../services/memoryService.js');
      const deletedCount = await memoryService.wipeMemories(userId, id);

      res.json({
        success: true,
        data: { deleted_count: deletedCount },
        message: `Deleted ${deletedCount} memories`,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to wipe memories'),
      });
    }
  }
);

/**
 * Backup persona
 */
router.get(
  '/:id/backup',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId || 'default';

      const persona = await personaService.getPersonaById(id, userId);
      if (!persona) {
        res.status(404).json({ success: false, error: 'Persona not found' });
        return;
      }

      const backupData = {
        persona,
        backup_date: new Date().toISOString(),
        user_id: userId,
      };

      const fileName = `${persona.name.replace(/[^a-zA-Z0-9]/g, '_')}_backup.json`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );
      res.send(JSON.stringify(backupData, null, 2));
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to backup persona'),
      });
    }
  }
);

/**
 * Export persona DNA
 */
router.get(
  '/:id/export/dna',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId || 'default';

      const persona = await personaService.getPersonaById(id, userId);
      if (!persona) {
        res.status(404).json({ success: false, error: 'Persona not found' });
        return;
      }

      // Try to get memories and state if they exist
      let memories: unknown[] = [];
      let adaptationLog: unknown[] = [];

      try {
        const { memoryService } = await import('../services/memoryService.js');
        const { mutationEngineService } = await import(
          '../services/mutationEngineService.js'
        );

        memories = await memoryService.getMemories(id, userId, 1000, 0);
        adaptationLog = (await mutationEngineService.getPersonaState(
          id,
          userId
        ))
          ? []
          : []; // Placeholder
      } catch (_error) {
        // Services might not be available, continue with empty data
      }

      const dnaData = {
        persona,
        memories,
        adaptation_log: adaptationLog,
        export_metadata: {
          exported_at: Date.now(),
          user_id: userId,
          version: '1.0.0',
          checksum: Buffer.from(JSON.stringify(persona))
            .toString('base64')
            .slice(0, 16),
        },
      };

      const fileName = `${persona.name.replace(/[^a-zA-Z0-9]/g, '_')}_DNA.json`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );
      res.send(JSON.stringify(dnaData, null, 2));
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to export DNA'),
      });
    }
  }
);

export default router;
