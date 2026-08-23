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
 * Work Computer teach mode: turn a recorded human demonstration (raw
 * pointer/key/wheel events captured by the Screen pane during a held
 * control lease) into a reusable playbook, deterministically — no model in
 * the loop. The playbook is a natural-language procedure the agent
 * re-interprets with computer_observe on replay, not a pixel-exact macro,
 * and it is stored as an ordinary user skill so it shows up in the Skills
 * UI with versioning and sharing for free. Computer-enabled Work runs load
 * the owner's taught skills into their system prompt, so replay is just a
 * normal agent run.
 */

import {
  createSkill,
  getSkillBySlug,
  listSkills,
  Skill,
  updateSkill,
} from './skillService.js';
import { WorkRuntimeError } from './workRuntimeShared.js';

/** Slug namespace for demonstration-taught skills. */
export const WORK_TAUGHT_SKILL_PREFIX = 'taught-';
/** Taught skills loaded into one Work run, newest first. */
export const WORK_TAUGHT_SKILLS_PER_RUN = 8;
export const WORK_TEACH_MAX_EVENTS = 10_000;
/** A pause longer than this between steps becomes an explicit wait step. */
const WAIT_GAP_MS = 3_000;
/** Down/up farther apart than this is a drag, not a click. */
const DRAG_THRESHOLD_PX = 8;
/** Two clicks this close in time and space collapse to a double-click. */
const DOUBLE_CLICK_MS = 400;
/** Words that mark surrounding typed text as secret material. */
const SECRET_CONTEXT_PATTERN = /password|secret|token|api[_-]?key|passphrase/i;
const REDACTED_PLACEHOLDER =
  '[REDACTED — never type this value; use request_takeover so the user enters it]';

export interface WorkTeachRecordedEvent {
  /** Milliseconds since recording start. */
  t: number;
  kind: 'down' | 'up' | 'move' | 'wheel' | 'key';
  x?: number;
  y?: number;
  /** Pointer button: 0 left, 1 middle, 2 right (DOM convention). */
  button?: number;
  /** Wheel vertical delta; positive scrolls down. */
  dy?: number;
  /** DOM KeyboardEvent.key value. */
  key?: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  shift?: boolean;
  /** Element descriptor under the pointer, resolved by the anchor probe. */
  anchor?: string;
  /** Page URL at the time of the event, for the derived allowed scope. */
  url?: string;
}

export interface WorkTeachPlaybook {
  steps: string[];
  redactions: number;
  typedInputs: string[];
  /** Distinct web hosts visited during the demonstration. */
  hosts: string[];
  instructions: string;
}

type Step =
  | {
      kind: 'click';
      x: number;
      y: number;
      button: number;
      count: number;
      t: number;
      anchor?: string;
    }
  | {
      kind: 'drag';
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      t: number;
      anchor?: string;
    }
  | { kind: 'type'; text: string; t: number }
  | { kind: 'key'; chord: string; t: number }
  | {
      kind: 'scroll';
      direction: 'up' | 'down';
      x: number;
      y: number;
      t: number;
    }
  | { kind: 'wait'; ms: number; t: number };

const invalidRecording = (reason: string): WorkRuntimeError =>
  new WorkRuntimeError(
    `The recording is invalid: ${reason}`,
    400,
    'WORK_TEACH_INVALID_RECORDING'
  );

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function validateWorkTeachEvents(
  events: unknown
): WorkTeachRecordedEvent[] {
  if (!Array.isArray(events) || events.length === 0) {
    throw invalidRecording('it contains no events.');
  }
  if (events.length > WORK_TEACH_MAX_EVENTS) {
    throw invalidRecording(
      `it exceeds ${WORK_TEACH_MAX_EVENTS} events; record a shorter demonstration.`
    );
  }
  const validated: WorkTeachRecordedEvent[] = [];
  for (const value of events) {
    const event = value as WorkTeachRecordedEvent | null;
    if (
      !event ||
      typeof event !== 'object' ||
      !finite(event.t) ||
      event.t < 0
    ) {
      throw invalidRecording('an event is malformed.');
    }
    switch (event.kind) {
      case 'down':
      case 'up':
      case 'move':
        if (!finite(event.x) || !finite(event.y)) {
          throw invalidRecording('a pointer event has no coordinates.');
        }
        break;
      case 'wheel':
        if (!finite(event.dy)) {
          throw invalidRecording('a wheel event has no delta.');
        }
        break;
      case 'key':
        if (typeof event.key !== 'string' || event.key.length === 0) {
          throw invalidRecording('a key event has no key.');
        }
        break;
      default:
        throw invalidRecording('an event has an unknown kind.');
    }
    // Anchors and URLs are best-effort enrichment from the recorder's
    // probe: keep them only when well-formed, never fail the recording.
    const copy: WorkTeachRecordedEvent = { ...event };
    delete copy.anchor;
    delete copy.url;
    if (
      event.kind === 'down' &&
      typeof event.anchor === 'string' &&
      event.anchor.trim()
    ) {
      copy.anchor = event.anchor.trim().slice(0, 200);
    }
    if (typeof event.url === 'string' && event.url.trim()) {
      copy.url = event.url.trim().slice(0, 300);
    }
    validated.push(copy);
  }
  return validated.sort((left, right) => left.t - right.t);
}

const round = (value: number): number => Math.round(value);

/** Map DOM KeyboardEvent.key names to xdotool keysyms the agent can use. */
const KEYSYM_BY_DOM_KEY: Record<string, string> = {
  Enter: 'Return',
  Escape: 'Escape',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next',
  ' ': 'space',
};

const chordFor = (event: WorkTeachRecordedEvent): string | undefined => {
  const key = event.key ?? '';
  const parts: string[] = [];
  if (event.ctrl) parts.push('ctrl');
  if (event.alt) parts.push('alt');
  if (event.meta) parts.push('super');
  if (event.shift && key.length > 1) parts.push('shift');
  const keysym =
    KEYSYM_BY_DOM_KEY[key] ?? (key.length === 1 ? key.toLowerCase() : key);
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return undefined;
  if (key.length === 1 && parts.length === 0) return undefined; // plain text
  if (parts.length === 0 && !KEYSYM_BY_DOM_KEY[key]) return undefined;
  return [...parts, keysym].join('+');
};

const isPlainCharacter = (event: WorkTeachRecordedEvent): boolean =>
  typeof event.key === 'string' &&
  event.key.length === 1 &&
  !event.ctrl &&
  !event.alt &&
  !event.meta;

/**
 * Deterministic secret redaction. Two rules: typed text mentioning secret
 * vocabulary is masked, and any whitespace-free run of 8+ characters mixing
 * three character classes is masked as credential-shaped — a demo should
 * never carry a password into a stored skill, that is what request_takeover
 * is for.
 */
export function isSecretLikeText(text: string): boolean {
  if (SECRET_CONTEXT_PATTERN.test(text)) return true;
  if (text.length >= 8 && !/\s/.test(text)) {
    const classes = [
      /[a-z]/.test(text),
      /[A-Z]/.test(text),
      /[0-9]/.test(text),
      /[^a-zA-Z0-9]/.test(text),
    ].filter(Boolean).length;
    if (classes >= 3) return true;
  }
  return false;
}

function collectSteps(events: WorkTeachRecordedEvent[]): Step[] {
  const steps: Step[] = [];
  let typeRun: { text: string; t: number } | undefined;
  let pendingDown: WorkTeachRecordedEvent | undefined;
  let lastStepTime = 0;

  const flushType = (): void => {
    if (typeRun && typeRun.text.length > 0) {
      steps.push({ kind: 'type', text: typeRun.text, t: typeRun.t });
    }
    typeRun = undefined;
  };
  const noteGap = (t: number): void => {
    if (steps.length > 0 && t - lastStepTime >= WAIT_GAP_MS) {
      steps.push({ kind: 'wait', ms: t - lastStepTime, t });
    }
    lastStepTime = t;
  };

  for (const event of events) {
    switch (event.kind) {
      case 'down':
        flushType();
        pendingDown = event;
        break;
      case 'up': {
        if (!pendingDown) break;
        noteGap(pendingDown.t);
        const fromX = round(pendingDown.x ?? 0);
        const fromY = round(pendingDown.y ?? 0);
        const toX = round(event.x ?? fromX);
        const toY = round(event.y ?? fromY);
        const distance = Math.hypot(toX - fromX, toY - fromY);
        if (distance >= DRAG_THRESHOLD_PX) {
          steps.push({
            kind: 'drag',
            fromX,
            fromY,
            toX,
            toY,
            t: event.t,
            ...(pendingDown.anchor ? { anchor: pendingDown.anchor } : {}),
          });
        } else {
          const previous = steps[steps.length - 1];
          if (
            previous?.kind === 'click' &&
            previous.button === (pendingDown.button ?? 0) &&
            event.t - previous.t <= DOUBLE_CLICK_MS &&
            Math.hypot(previous.x - toX, previous.y - toY) < DRAG_THRESHOLD_PX
          ) {
            previous.count += 1;
            previous.t = event.t;
          } else {
            steps.push({
              kind: 'click',
              x: toX,
              y: toY,
              button: pendingDown.button ?? 0,
              count: 1,
              t: event.t,
              ...(pendingDown.anchor ? { anchor: pendingDown.anchor } : {}),
            });
          }
        }
        lastStepTime = event.t;
        pendingDown = undefined;
        break;
      }
      case 'move':
        break;
      case 'wheel': {
        flushType();
        noteGap(event.t);
        const direction = (event.dy ?? 0) < 0 ? 'up' : 'down';
        const previous = steps[steps.length - 1];
        if (
          previous?.kind === 'scroll' &&
          previous.direction === direction &&
          event.t - previous.t <= 1_000
        ) {
          previous.t = event.t;
        } else {
          steps.push({
            kind: 'scroll',
            direction,
            x: round(event.x ?? 0),
            y: round(event.y ?? 0),
            t: event.t,
          });
        }
        lastStepTime = event.t;
        break;
      }
      case 'key': {
        const chord = chordFor(event);
        if (chord) {
          flushType();
          noteGap(event.t);
          steps.push({ kind: 'key', chord, t: event.t });
          lastStepTime = event.t;
        } else if (isPlainCharacter(event)) {
          if (!typeRun) {
            noteGap(event.t);
            typeRun = { text: '', t: event.t };
          }
          typeRun.text += event.key;
          lastStepTime = event.t;
        }
        // Bare modifiers and unmapped specials are dropped.
        break;
      }
    }
  }
  flushType();
  return steps;
}

const BUTTON_NAMES: Record<number, string> = {
  0: 'Click',
  1: 'Middle-click',
  2: 'Right-click',
};

function describeStep(
  step: Step,
  onRedact: (text: string) => void
): string | undefined {
  switch (step.kind) {
    case 'click': {
      const verb =
        step.count >= 2
          ? 'Double-click'
          : (BUTTON_NAMES[step.button] ?? 'Click');
      return step.anchor
        ? `${verb} "${step.anchor}" — it was at about (${step.x}, ${step.y}) in the demonstration.`
        : `${verb} at about (${step.x}, ${step.y}).`;
    }
    case 'drag':
      return step.anchor
        ? `Drag "${step.anchor}" from about (${step.fromX}, ${step.fromY}) to (${step.toX}, ${step.toY}).`
        : `Drag from about (${step.fromX}, ${step.fromY}) to (${step.toX}, ${step.toY}).`;
    case 'type': {
      if (isSecretLikeText(step.text)) {
        onRedact(step.text);
        return `Type ${REDACTED_PLACEHOLDER} into the focused field.`;
      }
      return `Type "${step.text}" into the focused field.`;
    }
    case 'key':
      return `Press ${step.chord}.`;
    case 'scroll':
      return `Scroll ${step.direction} around (${step.x}, ${step.y}).`;
    case 'wait':
      return `Wait for the screen to settle (about ${Math.min(10, Math.round(step.ms / 1000))}s in the demonstration).`;
  }
}

/**
 * Build the playbook from a validated recording. Pure and deterministic:
 * the same demonstration always yields the same skill text.
 */
export function buildWorkComputerPlaybook(
  events: WorkTeachRecordedEvent[],
  options: { name: string; screenWidth?: number; screenHeight?: number }
): WorkTeachPlaybook {
  const steps = collectSteps(events);
  if (steps.length === 0) {
    throw invalidRecording('it contains no usable actions.');
  }
  let redactions = 0;
  const typedInputs: string[] = [];
  const lines: string[] = [];
  for (const step of steps) {
    const line = describeStep(step, () => {
      redactions += 1;
    });
    if (!line) continue;
    if (step.kind === 'type' && !isSecretLikeText(step.text)) {
      if (!typedInputs.includes(step.text)) typedInputs.push(step.text);
    }
    lines.push(`${lines.length + 1}. ${line}`);
  }
  const screen =
    options.screenWidth && options.screenHeight
      ? `${options.screenWidth}×${options.screenHeight}`
      : '1280×800';

  // The demonstration's own footprint becomes the replay envelope: the
  // distinct web hosts it touched, derived deterministically from the
  // recorded page URLs. A taught procedure never inherits open-ended
  // authority beyond what the human actually showed.
  const hosts = [
    ...new Set(
      events
        .map(event => event.url)
        .filter((url): url is string => Boolean(url))
        .map(url => {
          try {
            return new URL(url).host;
          } catch {
            return '';
          }
        })
        .filter(Boolean)
    ),
  ].sort();
  const anchored = steps.some(
    step => (step.kind === 'click' || step.kind === 'drag') && step.anchor
  );

  const inputsSection =
    typedInputs.length > 0
      ? typedInputs
          .map(
            value =>
              `- "${value}" was typed in the demonstration; substitute the value the current request calls for.`
          )
          .join('\n')
      : '- None recorded; follow the request.';

  const instructions = `Demonstrated procedure recorded on the Work Computer (${screen} screen).
${
  anchored
    ? 'Quoted anchors name the demonstrated targets — find the same control by its label or role first; coordinates are only where it sat during the demonstration. computer_observe first and adapt when the layout differs.'
    : 'Coordinates are hints from the demonstration, not exact targets: computer_observe first, find the equivalent element on the current screen, and adapt when the layout differs.'
}

## When to use
When the request matches "${options.name}".

## Inputs
${inputsSection}

## Steps
${lines.join('\n')}

## How to check
Re-observe after each consequential step and confirm the screen changed as the step intended before continuing.

## Allowed scope
${
  hosts.length > 0
    ? `The demonstration stayed on: ${hosts.join(', ')}. Replay within that scope only — if the flow leads to a different site, stop and ask instead of extending the procedure to new territory.`
    : 'The demonstration recorded no web destination. If replaying takes you onto the web, stop and confirm the destination with the user first.'
}

## Approval boundaries
Never type credentials, one-time codes, or CAPTCHA answers — call request_takeover so the user enters them directly. Stop and ask before destructive or payment actions${redactions > 0 ? '. This demonstration contained redacted secret input at the marked step; a takeover is required there' : ''}.

## What to return
Summarize the end state and how it was verified.

## Failure handling
If a step cannot be completed as demonstrated, stop and ask the user; do not improvise around errors.`;

  return { steps: lines, redactions, typedInputs, hosts, instructions };
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'procedure';

export class WorkComputerTeachService {
  /**
   * Build the playbook and store it as a user skill in the taught-skill
   * namespace. A name collision gets a numeric suffix instead of failing —
   * re-teaching a task is normal.
   */
  async saveDemonstration(
    userId: string,
    input: {
      name: unknown;
      events: unknown;
      screenWidth?: unknown;
      screenHeight?: unknown;
    }
  ): Promise<{ skill: Skill; playbook: WorkTeachPlaybook }> {
    const name =
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim().slice(0, 120)
        : undefined;
    if (!name) {
      throw invalidRecording('a name for the taught task is required.');
    }
    const events = validateWorkTeachEvents(input.events);
    const playbook = buildWorkComputerPlaybook(events, {
      name,
      screenWidth: finite(input.screenWidth) ? input.screenWidth : undefined,
      screenHeight: finite(input.screenHeight) ? input.screenHeight : undefined,
    });

    const base = `${WORK_TAUGHT_SKILL_PREFIX}${slugify(name)}`;
    let slug = base;
    for (let suffix = 2; await getSkillBySlug(userId, slug); suffix++) {
      if (suffix > 50) {
        throw invalidRecording('too many taught skills share this name.');
      }
      slug = `${base}-${suffix}`;
    }
    const skill = await createSkill(userId, {
      slug,
      name,
      description: `Taught on the Work Computer: ${name}`,
      instructions: playbook.instructions,
      enabled: true,
    });
    return { skill, playbook };
  }

  /**
   * Record a user-reviewed replay outcome on a taught skill: a dated
   * "worked / failed" line in the skill's Track record section, newest
   * first and bounded. Goes through updateSkill, so every annotation is a
   * reviewable skill version.
   */
  async recordSkillTrace(
    userId: string,
    slug: string,
    input: { outcome: unknown; note?: unknown }
  ): Promise<{ skill: Skill; outcome: 'success' | 'failure' }> {
    if (input.outcome !== 'success' && input.outcome !== 'failure') {
      throw new WorkRuntimeError(
        'A skill trace outcome must be "success" or "failure".',
        400,
        'WORK_TEACH_INVALID_TRACE'
      );
    }
    const note =
      typeof input.note === 'string' && input.note.trim()
        ? input.note.trim().split('\n').join(' ').slice(0, 300)
        : undefined;
    const skill = await getSkillBySlug(userId, slug);
    if (!skill || !skill.slug.startsWith(WORK_TAUGHT_SKILL_PREFIX)) {
      throw new WorkRuntimeError(
        'No taught skill with this slug exists for you.',
        404,
        'WORK_TEACH_SKILL_NOT_FOUND'
      );
    }
    const line =
      `- ${new Date().toISOString().slice(0, 10)}: ` +
      `${input.outcome === 'success' ? 'Worked' : 'Failed'}${note ? ` — ${note}` : ''}`;
    const header = '## Track record';
    const intro = 'User-reviewed replay outcomes, newest first.';
    const sectionStart = skill.instructions.indexOf(`${header}\n`);
    let instructions: string;
    if (sectionStart < 0) {
      instructions = `${skill.instructions.trimEnd()}\n\n${header}\n${intro}\n${line}\n`;
    } else {
      const afterHeader = sectionStart + header.length + 1;
      const rest = skill.instructions.slice(afterHeader);
      const nextSection = rest.indexOf('\n## ');
      const sectionBody = nextSection < 0 ? rest : rest.slice(0, nextSection);
      const tail = nextSection < 0 ? '' : rest.slice(nextSection);
      const existing = sectionBody
        .split('\n')
        .filter(entry => entry.startsWith('- '))
        .slice(0, 4);
      instructions =
        skill.instructions.slice(0, afterHeader) +
        `${intro}\n${[line, ...existing].join('\n')}\n` +
        tail;
    }
    const updated = await updateSkill(
      skill.id,
      { userId },
      {
        name: skill.name,
        description: skill.description,
        instructions,
        enabled: skill.enabled,
      }
    );
    if (!updated) {
      throw new WorkRuntimeError(
        'No taught skill with this slug exists for you.',
        404,
        'WORK_TEACH_SKILL_NOT_FOUND'
      );
    }
    return { skill: updated, outcome: input.outcome };
  }

  /**
   * The owner's enabled taught skills, newest first and bounded, for
   * injection into a computer-enabled Work run's system prompt.
   */
  async taughtSkillsForUser(
    userId: string
  ): Promise<Array<{ slug: string; name: string; instructions: string }>> {
    const all = await listSkills(userId);
    return all
      .filter(
        skill =>
          skill.enabled && skill.slug.startsWith(WORK_TAUGHT_SKILL_PREFIX)
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, WORK_TAUGHT_SKILLS_PER_RUN)
      .map(skill => ({
        slug: skill.slug,
        name: skill.name,
        // A hand-edited taught skill can grow; keep one skill from
        // dominating the run's system prompt.
        instructions: skill.instructions.slice(0, 6_000),
      }));
  }
}

export const workComputerTeachService = new WorkComputerTeachService();
export default workComputerTeachService;
