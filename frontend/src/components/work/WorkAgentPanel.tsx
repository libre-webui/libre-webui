/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { GraduationCap, Pause, Play, Plus, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { AutomationModal } from '@/components/automations/AutomationModal';
import { Switch } from '@/components/ui';
import type { Automation, Persona } from '@/types';
import type { WorkApprovalsState, WorkTask } from '@/types/work';
import { cn } from '@/utils';
import { automationsApi, skillsApi } from '@/utils/api';
import { workApi } from '@/utils/api/workApi';
import type { Skill } from '@/utils/api/skillsApi';
import { describeTriggers } from '@/utils/automationSchedule';
import {
  getPersonaAvatarFallback,
  getPersonaAvatarSrc,
  setPersonaAvatarFallback,
} from '@/utils/personaAvatar';
import { workStatusPresentation } from '@/utils/workStatus';
import { WorkspaceScreen } from './WorkspaceScreen';

const TAUGHT_SKILL_PREFIX = 'taught-';

interface WorkAgentPanelProps {
  task: WorkTask;
  persona?: Persona;
  /** Only the visible tab keeps the mini screen connected. */
  active: boolean;
  onOpenScreen: () => void;
}

const sectionTitle =
  'mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-subtle';

export function WorkAgentPanel({
  task,
  persona,
  active,
  onOpenScreen,
}: WorkAgentPanelProps) {
  const { t, i18n } = useTranslation();
  const status = workStatusPresentation[task.status];
  const statusLabel = t(status.labelKey, { defaultValue: status.label });

  const [routines, setRoutines] = useState<Automation[]>([]);
  const [routinesLoaded, setRoutinesLoaded] = useState(false);
  const [routineBusyId, setRoutineBusyId] = useState<string | null>(null);
  const [routineModalOpen, setRoutineModalOpen] = useState(false);
  const [routineSaving, setRoutineSaving] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [approvals, setApprovals] = useState<WorkApprovalsState | null>(null);
  const [approvalsLoaded, setApprovalsLoaded] = useState(false);

  const loadRoutines = useCallback(async () => {
    try {
      const response = await automationsApi.getAutomations();
      if (response.success && Array.isArray(response.data)) {
        setRoutines(response.data.filter(item => item.workTaskId === task.id));
      }
    } catch {
      // The section shows its empty state; a toast per poll would be noise.
    } finally {
      setRoutinesLoaded(true);
    }
  }, [task.id]);

  const loadSkills = useCallback(async () => {
    try {
      const response = await skillsApi.list();
      if (response.success && Array.isArray(response.data)) {
        setSkills(
          response.data.filter(item =>
            item.slug.startsWith(TAUGHT_SKILL_PREFIX)
          )
        );
      }
    } catch {
      // Same quiet degradation as routines.
    } finally {
      setSkillsLoaded(true);
    }
  }, []);

  const loadApprovals = useCallback(async () => {
    try {
      const response = await workApi.getApprovals(task.id);
      if (response.success && response.data) setApprovals(response.data);
    } catch {
      // Same quiet degradation as routines.
    } finally {
      setApprovalsLoaded(true);
    }
  }, [task.id]);

  useEffect(() => {
    if (!active) return;
    // Start shared loaders after the activation commit; their state updates
    // then arrive from the external request lifecycle.
    const timer = window.setTimeout(() => {
      void loadRoutines();
      void loadSkills();
      void loadApprovals();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, loadRoutines, loadSkills, loadApprovals]);

  const toggleApprovals = async (enabled: boolean) => {
    // Optimistic: the switch answers immediately, rolls back on failure.
    const previous = approvals;
    setApprovals(current =>
      current ? { ...current, approvalsEnabled: enabled } : current
    );
    try {
      await workApi.setApprovalsEnabled(task.id, enabled ? true : null);
    } catch {
      setApprovals(previous);
      toast.error(
        t('work.agent.approvalsToggleFailed', {
          defaultValue: 'Could not update approvals.',
        })
      );
    }
  };

  const removeApprovalRule = async (ruleId: string) => {
    try {
      await workApi.deleteApprovalRule(task.id, ruleId);
      await loadApprovals();
    } catch {
      toast.error(
        t('work.agent.approvalRuleDeleteFailed', {
          defaultValue: 'Could not remove the rule.',
        })
      );
    }
  };

  const toggleRoutine = async (routine: Automation) => {
    setRoutineBusyId(routine.id);
    try {
      const response =
        routine.status === 'active'
          ? await automationsApi.pauseAutomation(routine.id)
          : await automationsApi.resumeAutomation(routine.id);
      if (!response.success) throw new Error(response.message);
      await loadRoutines();
    } catch {
      toast.error(
        t('work.agent.routineToggleFailed', {
          defaultValue: 'Could not update the routine.',
        })
      );
    } finally {
      setRoutineBusyId(null);
    }
  };

  const saveRoutine = async (
    payload: Parameters<typeof automationsApi.createAutomation>[0]
  ) => {
    setRoutineSaving(true);
    try {
      const response = await automationsApi.createAutomation(payload);
      if (!response.success) throw new Error(response.message);
      setRoutineModalOpen(false);
      await loadRoutines();
    } catch {
      toast.error(
        t('work.agent.routineSaveFailed', {
          defaultValue: 'Could not save the routine.',
        })
      );
    } finally {
      setRoutineSaving(false);
    }
  };

  const toggleSkill = async (skill: Skill, enabled: boolean) => {
    // Optimistic: the switch answers immediately, rolls back on failure.
    setSkills(current =>
      current.map(item => (item.id === skill.id ? { ...item, enabled } : item))
    );
    try {
      await skillsApi.update(skill.id, { enabled });
    } catch {
      setSkills(current =>
        current.map(item =>
          item.id === skill.id ? { ...item, enabled: skill.enabled } : item
        )
      );
      toast.error(
        t('work.agent.skillToggleFailed', {
          defaultValue: 'Could not update the skill.',
        })
      );
    }
  };

  return (
    <div
      data-testid='work-agent-panel'
      className='flex flex-col gap-6 p-4 sm:p-5'
    >
      {/* Identity: who this agent is and what it last did. */}
      <div className='flex items-start gap-3'>
        <span className='relative shrink-0'>
          <img
            src={
              persona
                ? getPersonaAvatarSrc(persona, 96)
                : getPersonaAvatarFallback(task.title, 96)
            }
            alt=''
            aria-hidden='true'
            data-testid='work-agent-avatar'
            onError={event =>
              setPersonaAvatarFallback(
                event.currentTarget,
                persona?.name ?? task.title,
                96
              )
            }
            className='h-12 w-12 rounded-xl object-cover'
          />
          <span
            aria-hidden='true'
            className={cn(
              'absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-surface',
              status.animated && 'animate-pulse'
            )}
            style={{ backgroundColor: status.color }}
          />
        </span>
        <div className='min-w-0 flex-1'>
          <h3
            dir='auto'
            className='truncate text-[15px] font-medium leading-6 text-ink'
            title={task.title}
          >
            {task.title}
          </h3>
          <p className='text-xs text-ink-muted'>
            {persona
              ? t('work.agent.personaLine', {
                  defaultValue: 'Persona: {{name}}',
                  name: persona.name,
                })
              : statusLabel}
          </p>
          {task.statusBlurb && (
            <p
              dir='auto'
              data-testid='work-agent-blurb'
              className='mt-1 text-[13px] leading-5 text-ink-subtle'
            >
              {task.statusBlurb}
            </p>
          )}
        </div>
      </div>

      {/* Live screen thumbnail; the full Screen tab holds every control. */}
      {task.computerAvailable && (
        <section>
          <h4 className={sectionTitle}>
            {t('work.agent.screen', { defaultValue: 'Screen' })}
          </h4>
          <WorkspaceScreen
            taskId={task.id}
            active={active}
            variant='mini'
            onExpand={onOpenScreen}
          />
        </section>
      )}

      {/* Routines: automations bound to this agent's task. */}
      <section data-testid='work-agent-routines'>
        <div className='mb-2 flex items-center justify-between'>
          <h4 className={cn(sectionTitle, 'mb-0')}>
            {t('work.agent.routines', { defaultValue: 'Routines' })}
          </h4>
          <button
            type='button'
            data-testid='work-agent-add-routine'
            onClick={() => setRoutineModalOpen(true)}
            className='flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-primary-600 transition-colors hover:bg-primary-500/10 dark:text-primary-400'
          >
            <Plus className='h-3.5 w-3.5' />
            {t('work.agent.addRoutine', { defaultValue: 'Routine' })}
          </button>
        </div>
        {routines.length === 0 ? (
          <p className='text-xs leading-relaxed text-ink-subtle'>
            {routinesLoaded
              ? t('work.agent.noRoutines', {
                  defaultValue:
                    'No routines yet. A routine runs an instruction on a schedule, inside this agent’s workspace.',
                })
              : '…'}
          </p>
        ) : (
          <ul className='space-y-1'>
            {routines.map(routine => (
              <li
                key={routine.id}
                data-testid='work-agent-routine'
                className='flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2'
              >
                <div className='min-w-0 flex-1'>
                  <p
                    dir='auto'
                    className={cn(
                      'truncate text-[13px] leading-5',
                      routine.status === 'active'
                        ? 'text-ink'
                        : 'text-ink-subtle line-through decoration-ink-subtle/40'
                    )}
                    title={routine.name}
                  >
                    {routine.name}
                  </p>
                  <p className='truncate text-[11px] text-ink-subtle'>
                    {describeTriggers(routine.triggers, i18n.language, t)}
                  </p>
                </div>
                <button
                  type='button'
                  data-testid='work-agent-routine-toggle'
                  disabled={routineBusyId === routine.id}
                  onClick={() => void toggleRoutine(routine)}
                  aria-label={
                    routine.status === 'active'
                      ? t('automations.pause', { defaultValue: 'Pause' })
                      : t('automations.resume', { defaultValue: 'Resume' })
                  }
                  className='flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink disabled:opacity-40'
                >
                  {routine.status === 'active' ? (
                    <Pause className='h-3.5 w-3.5' />
                  ) : (
                    <Play className='h-3.5 w-3.5' />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Auto Review: which side-effecting actions pause for approval. */}
      <section data-testid='work-agent-approvals'>
        <div className='mb-2 flex items-center justify-between'>
          <h4 className={cn(sectionTitle, 'mb-0')}>
            {t('work.agent.approvals', { defaultValue: 'Auto Review' })}
          </h4>
          <Switch
            checked={
              approvals?.policyRequired === true ||
              approvals?.approvalsEnabled === true
            }
            disabled={!approvalsLoaded || approvals?.policyRequired === true}
            onChange={enabled => void toggleApprovals(enabled)}
          />
        </div>
        <p className='text-xs leading-relaxed text-ink-subtle'>
          {approvals?.policyRequired === true
            ? t('work.agent.approvalsPolicyForced', {
                defaultValue:
                  'This agent’s Work policy requires approval for side-effecting actions.',
              })
            : t('work.agent.approvalsHint', {
                defaultValue:
                  'When on, commands, file deletions and moves, and computer actions pause until you approve them.',
              })}
        </p>
        {approvals && approvals.rules.length > 0 && (
          <ul className='mt-2 space-y-1'>
            {approvals.rules.map(rule => (
              <li
                key={rule.id}
                data-testid='work-agent-approval-rule'
                className='flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2'
              >
                <ShieldCheck className='h-4 w-4 shrink-0 text-ink-muted' />
                <div className='min-w-0 flex-1'>
                  <p className='truncate text-[13px] leading-5 text-ink'>
                    <code dir='ltr'>{rule.toolName}</code>
                    {rule.pattern && (
                      <>
                        {' · '}
                        <code dir='ltr'>{rule.pattern}</code>
                      </>
                    )}
                  </p>
                  <p className='truncate text-[11px] text-ink-subtle'>
                    {t('work.agent.approvalRuleLine', {
                      defaultValue: 'Always allowed',
                    })}
                  </p>
                </div>
                <button
                  type='button'
                  data-testid='work-agent-approval-rule-delete'
                  onClick={() => void removeApprovalRule(rule.id)}
                  aria-label={t('work.agent.approvalRuleDelete', {
                    defaultValue: 'Remove rule',
                  })}
                  className='flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Skills the user taught this agent on its computer. */}
      <section data-testid='work-agent-skills'>
        <h4 className={sectionTitle}>
          {t('work.agent.skills', { defaultValue: 'Taught skills' })}
        </h4>
        {skills.length === 0 ? (
          <p className='text-xs leading-relaxed text-ink-subtle'>
            {skillsLoaded
              ? t('work.agent.noSkills', {
                  defaultValue:
                    'Nothing taught yet. Use Teach on the Screen tab to demonstrate a procedure once; it becomes a replayable skill.',
                })
              : '…'}
          </p>
        ) : (
          <ul className='space-y-1'>
            {skills.map(skill => (
              <li
                key={skill.id}
                data-testid='work-agent-skill'
                className='flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2'
              >
                <GraduationCap className='h-4 w-4 shrink-0 text-ink-muted' />
                <div className='min-w-0 flex-1'>
                  <p
                    dir='auto'
                    className='truncate text-[13px] leading-5 text-ink'
                    title={skill.name}
                  >
                    {skill.name}
                  </p>
                  {skill.description && (
                    <p className='truncate text-[11px] text-ink-subtle'>
                      {skill.description}
                    </p>
                  )}
                </div>
                <Switch
                  checked={skill.enabled}
                  onChange={enabled => void toggleSkill(skill, enabled)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <AutomationModal
        open={routineModalOpen}
        automation={null}
        fixedWorkTaskId={task.id}
        models={[]}
        saving={routineSaving}
        onClose={() => setRoutineModalOpen(false)}
        onSave={payload => void saveRoutine(payload)}
      />
    </div>
  );
}
