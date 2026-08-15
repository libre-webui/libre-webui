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

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request } from 'express';
import multer, { FileFilterCallback } from 'multer';
import { createLogger } from './logger.js';

const logger = createLogger('utils:plugin-upload');

export const pluginUploadTempDirectory = path.resolve(
  process.env.PLUGIN_UPLOAD_TEMP_DIR?.trim() ||
    path.join(os.tmpdir(), 'libre-webui-plugin-uploads')
);

const isWithinDirectory = (filePath: string, directory: string): boolean => {
  const relative = path.relative(directory, filePath);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
};

export interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

export function safeCleanupFile(filePath: string, tempDir: string): void {
  try {
    const resolvedPath = path.resolve(filePath);
    const resolvedTempDir = path.resolve(tempDir);

    if (
      isWithinDirectory(resolvedPath, resolvedTempDir) &&
      fs.existsSync(resolvedPath)
    ) {
      fs.unlinkSync(resolvedPath);
    }
  } catch (error) {
    logger.error('Failed to cleanup file:', error);
  }
}

export const pluginUpload = multer({
  dest: pluginUploadTempDirectory,
  fileFilter: (
    req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback
  ) => {
    const allowedTypes = ['.json', '.zip'];
    const fileExt = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(fileExt)) {
      cb(null, true);
    } else {
      cb(new Error('Only .json and .zip files are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});
