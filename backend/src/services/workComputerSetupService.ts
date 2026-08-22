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
 * One-click Work Computer onboarding. The GUI image's build context ships
 * with the application (deploy/work-computer), so an administrator does not
 * need to know docker build flags or policy fields: this service builds the
 * image on the deployment's own Docker daemon, layered on the exact pinned
 * Work base image, and creates a ready "Work Computer" policy. Everything
 * is idempotent — pressing the button twice, or after a partial failure,
 * converges on the same state.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import workPolicyService from './workPolicyService.js';
import { workRuntimeConfig, WorkRuntimeError } from './workRuntimeShared.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:work-computer-setup');

export const WORK_COMPUTER_IMAGE = 'libre-work-computer:latest';
const DEFAULT_POLICY_NAME = 'Work Computer';
const BUILD_TIMEOUT_MS = 20 * 60_000;
const LOG_TAIL_LIMIT = 4_000;

export interface WorkComputerSetupStatus {
  /** The GUI image exists on the deployment's Docker daemon. */
  imageReady: boolean;
  /** A policy with the Work Computer enabled already exists. */
  policyId?: string;
  building: boolean;
  /** Last lines of the current or failed build, for the settings UI. */
  buildLog?: string;
  buildError?: string;
}

/** The bundled build context: <app root>/deploy/work-computer. */
const bundledContextPath = (): string =>
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
    'deploy',
    'work-computer'
  );

export class WorkComputerSetupService {
  private building = false;
  private buildLog = '';
  private buildError: string | undefined;
  private buildPromise: Promise<void> | undefined;

  async status(): Promise<WorkComputerSetupStatus> {
    const [imageReady, policyId] = await Promise.all([
      this.imageExists(),
      this.guiPolicyId(),
    ]);
    return {
      imageReady,
      ...(policyId ? { policyId } : {}),
      building: this.building,
      ...(this.buildLog ? { buildLog: this.buildLog } : {}),
      ...(this.buildError ? { buildError: this.buildError } : {}),
    };
  }

  /**
   * Converge on a working Work Computer: build the image when missing
   * (asynchronously — poll status for progress) and create the default
   * policy when no GUI policy exists yet.
   */
  async ensure(): Promise<WorkComputerSetupStatus> {
    if (!(await this.imageExists()) && !this.building) {
      // The context is only needed when the image actually has to be built;
      // an image built out-of-band (for deployments whose Docker API proxy
      // denies /build) must still let this converge on the policy.
      const context = bundledContextPath();
      if (!existsSync(path.join(context, 'Dockerfile'))) {
        throw new WorkRuntimeError(
          'The bundled Work Computer image files are missing from this installation.',
          500,
          'WORK_COMPUTER_SETUP_UNAVAILABLE'
        );
      }
      this.building = true;
      this.buildError = undefined;
      this.buildLog = '';
      this.buildPromise = this.buildImage(context)
        .catch(error => {
          this.buildError =
            error instanceof Error ? error.message : 'Image build failed.';
          logger.error('Work Computer image build failed:', error);
        })
        .finally(() => {
          this.building = false;
        });
    }
    if (!this.building && !this.buildError) {
      await this.ensurePolicy();
    }
    return this.status();
  }

  /** Await a build in flight; used after polling reports completion. */
  async finalize(): Promise<WorkComputerSetupStatus> {
    await this.buildPromise;
    if (!this.buildError && (await this.imageExists())) {
      await this.ensurePolicy();
    }
    return this.status();
  }

  private async guiPolicyId(): Promise<string | undefined> {
    const policies = await workPolicyService.list();
    return policies.find(policy => policy.guiEnabled === true)?.id;
  }

  private async ensurePolicy(): Promise<void> {
    if (await this.guiPolicyId()) return;
    if (!(await this.imageExists())) return;
    await workPolicyService.create({
      name: DEFAULT_POLICY_NAME,
      image: WORK_COMPUTER_IMAGE,
      memoryLimit: '4g',
      networkDefault: true,
      guiEnabled: true,
    });
    logger.info('Created the default Work Computer policy.');
  }

  private imageExists(): Promise<boolean> {
    return new Promise(resolve => {
      const inspect = spawn(workRuntimeConfig.dockerCommand, [
        'image',
        'inspect',
        WORK_COMPUTER_IMAGE,
      ]);
      inspect.on('error', () => resolve(false));
      inspect.on('close', code => resolve(code === 0));
    });
  }

  private buildImage(context: string): Promise<void> {
    logger.info(
      `Building ${WORK_COMPUTER_IMAGE} from ${context} on ${workRuntimeConfig.image}`
    );
    return new Promise((resolve, reject) => {
      const build = spawn(
        workRuntimeConfig.dockerCommand,
        [
          'build',
          '--build-arg',
          `WORK_BASE_IMAGE=${workRuntimeConfig.image}`,
          '-t',
          WORK_COMPUTER_IMAGE,
          context,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const timer = setTimeout(() => {
        build.kill('SIGKILL');
        reject(new Error('The image build timed out.'));
      }, BUILD_TIMEOUT_MS);
      timer.unref();
      const append = (chunk: Buffer): void => {
        this.buildLog = (this.buildLog + chunk.toString()).slice(
          -LOG_TAIL_LIMIT
        );
      };
      build.stdout.on('data', append);
      build.stderr.on('data', append);
      build.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      build.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`docker build exited with code ${code}.`));
      });
    });
  }
}

export const workComputerSetupService = new WorkComputerSetupService();
export default workComputerSetupService;
