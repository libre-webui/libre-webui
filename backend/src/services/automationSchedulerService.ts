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
 * Fires due automations and settles their runs. A self-rescheduling tick
 * (modeled on the Work idle sweep) holds a coordinator lease so exactly one
 * replica advances schedules; the compare-and-set on next_run_at makes each
 * occurrence fire at most once even if the lease ever overlaps.
 */

import type { AutomationTrigger } from '../types/index.js';
import { encryptionService } from './encryptionService.js';
import { getPersistence } from '../persistence/index.js';
import { getCoordinator } from '../platform/coordination/service.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import {
  AUTOMATION_RUN_JOB_TYPE,
  automationRunIdempotencyScope,
  chatGenerationIdempotencyScope,
} from '../platform/jobs/domainJobContracts.js';
import automationService from './automationService.js';
import { nextRunAt } from '../utils/automationSchedule.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('automation-scheduler');

const TICK_INTERVAL_MS = 60_000;
const LEASE_KEY = 'automation-scheduler';
const LEASE_TTL_MS = 55_000;
const DUE_BATCH_LIMIT = 50;
/** A queued run whose start never materialized is abandoned after this. */
const STALE_QUEUED_MS = 30 * 60 * 1000;

class AutomationSchedulerService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  start(): void {
    this.stopped = false;
    this.scheduleTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleTick(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick()
        .catch(error => {
          logger.warn('Automation scheduler tick failed:', error);
        })
        .finally(() => {
          this.scheduleTick();
        });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
  }

  async tick(now = Date.now()): Promise<{ fired: number; settled: number }> {
    const lease = await getCoordinator().acquireLease(LEASE_KEY, LEASE_TTL_MS);
    if (!lease) return { fired: 0, settled: 0 };
    try {
      const fired = await this.fireDue(now);
      const settled = await this.settleRuns(now);
      return { fired, settled };
    } finally {
      await lease.release().catch(() => false);
    }
  }

  /**
   * Fire every automation whose next_run_at has arrived. Missed occurrences
   * collapse into one run: the overdue slot fires, and the schedule advances
   * to the next occurrence after now.
   */
  private async fireDue(now: number): Promise<number> {
    const repositories = getPersistence(encryptionService).repositories;
    const due = await repositories.resources.automations.listDue(
      now,
      DUE_BATCH_LIMIT
    );
    let fired = 0;
    for (const automation of due) {
      const observed = automation.next_run_at;
      if (observed === null) continue;
      let next: number | null = null;
      try {
        next = nextRunAt(
          JSON.parse(automation.triggers) as AutomationTrigger[],
          now
        );
      } catch (error) {
        logger.warn(
          `Automation ${automation.id} has unreadable triggers:`,
          error
        );
      }
      // The compare-and-set claims this occurrence; a concurrent tick that
      // lost the race skips it entirely.
      const claimed = await repositories.resources.automations.advanceNextRun(
        automation.id,
        observed,
        next,
        now
      );
      if (!claimed) continue;
      try {
        const run = await automationService.createRun(
          automation.id,
          automation.user_id,
          observed
        );
        await getDurableJobRuntime().service.enqueue({
          jobType: AUTOMATION_RUN_JOB_TYPE,
          actorUserId: automation.user_id,
          idempotencyScope: automationRunIdempotencyScope(automation.id),
          idempotencyKey: String(observed),
          payload: {
            mode: 'encrypted',
            value: { runId: run.id, automationId: automation.id },
          },
          maxAttempts: 3,
        });
        fired += 1;
      } catch (error) {
        logger.error(
          `Could not enqueue run for automation ${automation.id}:`,
          error
        );
      }
    }
    return fired;
  }

  /** Enqueue a manual run outside the schedule (Run now). */
  async runNow(automationId: string, userId: string): Promise<string> {
    const now = Date.now();
    const run = await automationService.createRun(automationId, userId, now);
    await getDurableJobRuntime().service.enqueue({
      jobType: AUTOMATION_RUN_JOB_TYPE,
      actorUserId: userId,
      idempotencyScope: automationRunIdempotencyScope(automationId),
      idempotencyKey: `manual:${run.id}`,
      payload: {
        mode: 'encrypted',
        value: { runId: run.id, automationId },
      },
      maxAttempts: 3,
    });
    return run.id;
  }

  /**
   * Settle unfinished runs from the durable job ledger: a run succeeds when
   * its chat generation job succeeded, fails when either job dead-lettered,
   * and is abandoned when it never started within the stale window.
   */
  private async settleRuns(now: number): Promise<number> {
    const service = getDurableJobRuntime().service;
    const runs = await automationService.listUnfinishedRunRecords();
    let settled = 0;
    for (const run of runs) {
      try {
        if (run.session_id && run.assistant_message_id) {
          const chatJob = await service.getByIdempotency(
            run.user_id,
            chatGenerationIdempotencyScope(run.session_id),
            run.assistant_message_id
          );
          if (chatJob?.state === 'succeeded') {
            if (await automationService.finalizeRun(run.id, 'succeeded')) {
              settled += 1;
            }
            continue;
          }
          if (
            chatJob?.state === 'dead_letter' ||
            chatJob?.state === 'cancelled'
          ) {
            if (
              await automationService.finalizeRun(
                run.id,
                'failed',
                chatJob.errorSummary ?? chatJob.state
              )
            ) {
              settled += 1;
            }
            continue;
          }
        }
        // Scheduled runs key by their occurrence time, manual runs by id.
        let runJob = await service.getByIdempotency(
          run.user_id,
          automationRunIdempotencyScope(run.automation_id),
          String(run.scheduled_for)
        );
        if (!runJob) {
          runJob = await service.getByIdempotency(
            run.user_id,
            automationRunIdempotencyScope(run.automation_id),
            `manual:${run.id}`
          );
        }
        if (runJob?.state === 'dead_letter' || runJob?.state === 'cancelled') {
          if (
            await automationService.finalizeRun(
              run.id,
              'failed',
              runJob.errorSummary ?? runJob.state
            )
          ) {
            settled += 1;
          }
          continue;
        }
        if (run.status === 'queued' && now - run.created_at > STALE_QUEUED_MS) {
          if (
            await automationService.finalizeRun(run.id, 'failed', 'stalled')
          ) {
            settled += 1;
          }
        }
      } catch (error) {
        logger.warn(`Could not settle automation run ${run.id}:`, error);
      }
    }
    return settled;
  }
}

const automationSchedulerService = new AutomationSchedulerService();
export default automationSchedulerService;
