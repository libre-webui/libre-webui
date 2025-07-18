---
sidebar_position: 2
title: "Copyright & License"
description: "Copyright header management, license information, and legal guidelines for Libre WebUI"
slug: /COPYRIGHT
keywords: [copyright, license, legal, apache, headers, attribution]
---

# Copyright Header Management

This project automatically adds copyright headers to all TypeScript/JavaScript source files using a custom script.

## Copyright Header

All source files (`.ts`, `.tsx`, `.js`, `.jsx`) in the `frontend/src` and `backend/src` directories will automatically have this copyright header added:

```javascript
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
```

## Usage

### Automatic Header Addition

The copyright header is automatically added when you run:

```bash
npm run format
```

This command:
1. Runs the header addition script
2. Formats all files with Prettier

### Manual Header Addition

You can also add headers manually without formatting:

```bash
npm run add-headers
```

### Smart Header Detection

The script will:
- ✅ Add headers to files that don't have them
- ✅ Skip files that already have copyright headers
- ✅ Ignore configuration files, build outputs, and dependencies
- ✅ Only process TypeScript/JavaScript source files

### Ignored Files/Directories

The following are automatically ignored:
- `node_modules/`
- `dist/`
- `build/`
- `coverage/`
- `public/`
- Configuration files (`*.config.js`, `*.config.ts`)
- Type definition files (`vite-env.d.ts`)
- ESLint configuration (`eslint.config.js`)

## Implementation

The header management is implemented in `/scripts/add-headers.js` and integrated into the formatting workflow in `package.json`.
