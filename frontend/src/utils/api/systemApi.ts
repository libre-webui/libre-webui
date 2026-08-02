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

import api from './client';
import type { ApiResponse } from '@/types';

export interface SystemDiagnostics {
  generatedAt: number;
  host: {
    hostname: string;
    platform: string;
    release: string;
    architecture: string;
    uptimeSeconds: number;
    bootedAt: number;
    logicalCpus: number;
    cpuModel: string;
    loadAverage: [number, number, number];
    containerized: boolean;
  };
  runtime: {
    appVersion: string;
    nodeVersion: string;
    processId: number;
    processUptimeSeconds: number;
    workingDirectory: string;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    processRssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
  filesystems: Array<{
    label: string;
    path: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
  }>;
  network: {
    interfaces: Array<{
      name: string;
      addresses: Array<{
        address: string;
        family: 'IPv4' | 'IPv6';
        cidr: string | null;
        internal: boolean;
      }>;
      receivedBytes?: number;
      transmittedBytes?: number;
    }>;
  };
  docker: {
    available: boolean;
    socketMounted: boolean;
    reason?: string;
    serverVersion?: string;
    operatingSystem?: string;
    architecture?: string;
    kernelVersion?: string;
    logicalCpus?: number;
    memoryBytes?: number;
    totalContainers: number;
    runningContainers: number;
    stoppedContainers: number;
    pausedContainers: number;
    containers: Array<{
      id: string;
      name: string;
      image: string;
      state: string;
      status: string;
      createdAt: number;
    }>;
  };
}

export const systemApi = {
  getDiagnostics: (): Promise<ApiResponse<SystemDiagnostics>> =>
    api.get('/system').then(response => response.data),
};
