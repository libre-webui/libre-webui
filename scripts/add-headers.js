#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const COPYRIGHT_HEADER = `/*
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

`;

// File extensions that should have copyright headers
const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

// Files/directories to ignore
const IGNORE_PATTERNS = [
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'build',
  'public',
  '.next',
  '.vscode',
  '.idea',
  '*.config.js',
  '*.config.ts',
  'vite-env.d.ts',
  'eslint.config.js'
];

function shouldIgnoreFile(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  return IGNORE_PATTERNS.some(pattern => {
    if (pattern.includes('*')) {
      // Simple glob pattern matching
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(path.basename(filePath));
    }
    return relativePath.includes(pattern);
  });
}

function hasHeader(content) {
  return content.startsWith('/*') && content.includes('Libre WebUI') && content.includes('Copyright (C) 2025 Kroonen AI, Inc.');
}

function addHeaderToFile(filePath) {
  if (shouldIgnoreFile(filePath)) {
    return false;
  }

  const ext = path.extname(filePath);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return false;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    if (hasHeader(content)) {
      console.log(`Header already exists: ${filePath}`);
      return false;
    }

    // Remove any existing header comments at the top
    let cleanContent = content;
    if (content.startsWith('/*')) {
      const headerEndIndex = content.indexOf('*/');
      if (headerEndIndex !== -1) {
        cleanContent = content.substring(headerEndIndex + 2).replace(/^\s*\n/, '');
      }
    }

    const newContent = COPYRIGHT_HEADER + cleanContent;
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log(`Added header to: ${filePath}`);
    return true;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error.message);
    return false;
  }
}

function findFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (shouldIgnoreFile(fullPath)) {
      continue;
    }
    
    if (entry.isDirectory()) {
      findFiles(fullPath, files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        files.push(fullPath);
      }
    }
  }
  
  return files;
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // Process all files in frontend/src and backend/src
    const frontendSrc = path.join(process.cwd(), 'frontend', 'src');
    const backendSrc = path.join(process.cwd(), 'backend', 'src');
    
    let files = [];
    
    if (fs.existsSync(frontendSrc)) {
      files = files.concat(findFiles(frontendSrc));
    }
    
    if (fs.existsSync(backendSrc)) {
      files = files.concat(findFiles(backendSrc));
    }
    
    let addedCount = 0;
    for (const file of files) {
      if (addHeaderToFile(file)) {
        addedCount++;
      }
    }
    
    console.log(`\nProcessed ${files.length} files, added headers to ${addedCount} files.`);
  } else {
    // Process specific files
    let addedCount = 0;
    for (const file of args) {
      if (fs.existsSync(file) && addHeaderToFile(file)) {
        addedCount++;
      }
    }
    console.log(`\nProcessed ${args.length} files, added headers to ${addedCount} files.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { addHeaderToFile, hasHeader };
