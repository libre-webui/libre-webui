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

import type React from 'react';
import {
  Bot,
  ChartNoAxesCombined,
  Database,
  NotebookPen,
  Package,
  Server,
  Sparkles,
  User as UserIcon,
  Users,
} from 'lucide-react';

export type AppSectionIcon = React.ComponentType<{ className?: string }>;

/**
 * Who can see a section: everyone, users with Agents access, or
 * administrators (including the no-auth single-user mode).
 */
export type AppSectionGate = 'always' | 'agents' | 'admin';

export interface AppSection {
  id: string;
  path: string;
  labelKey: string;
  icon: AppSectionIcon;
  gate: AppSectionGate;
}

/**
 * Shared registry of the app's page-style sections. The tab bar, the
 * sidebar's pinned navigation, and the user menu's pin toggles all derive
 * their metadata from this single list.
 */
export const APP_SECTIONS: AppSection[] = [
  {
    id: 'notes',
    path: '/notes',
    labelKey: 'sidebar.navigation.notes',
    icon: NotebookPen,
    gate: 'always',
  },
  {
    id: 'models',
    path: '/models',
    labelKey: 'sidebar.navigation.models',
    icon: Database,
    gate: 'always',
  },
  {
    id: 'personas',
    path: '/personas',
    labelKey: 'sidebar.navigation.personas',
    icon: UserIcon,
    gate: 'always',
  },
  {
    id: 'gallery',
    path: '/gallery',
    labelKey: 'sidebar.navigation.imagine',
    icon: Sparkles,
    gate: 'always',
  },
  {
    id: 'agents',
    path: '/agents',
    labelKey: 'sidebar.navigation.agents',
    icon: Bot,
    gate: 'agents',
  },
  {
    id: 'users',
    path: '/users',
    labelKey: 'sidebar.navigation.userManagement',
    icon: Users,
    gate: 'admin',
  },
  {
    id: 'usage',
    path: '/usage',
    labelKey: 'usageAnalytics.title',
    icon: ChartNoAxesCombined,
    gate: 'admin',
  },
  {
    id: 'system',
    path: '/system',
    labelKey: 'systemPage.title',
    icon: Server,
    gate: 'admin',
  },
  {
    id: 'artifacts',
    path: '/artifacts',
    labelKey: 'tabs.artifacts',
    icon: Package,
    gate: 'always',
  },
];

export const appSectionById = new Map(
  APP_SECTIONS.map(section => [section.id, section])
);

export const appSectionByPath = new Map(
  APP_SECTIONS.map(section => [section.path, section])
);
