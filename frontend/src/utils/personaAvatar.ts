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

type PersonaAvatarInput = {
  name: string;
  avatar?: string | null;
};

const AVATAR_GRADIENTS = [
  ['#2563eb', '#7c3aed'],
  ['#0891b2', '#2563eb'],
  ['#0f766e', '#2563eb'],
  ['#be123c', '#7c3aed'],
  ['#ff7b52', '#dc2626'],
] as const;

const hashString = (value: string): number => {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
};

const escapeSvgText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const getPersonaInitials = (name: string): string => {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);

  if (parts.length === 0) return 'AI';

  const initials = parts
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('');

  return initials || 'AI';
};

export const getPersonaAvatarFallback = (name: string, size = 128): string => {
  const safeName = name.trim() || 'AI Persona';
  const hash = hashString(safeName);
  const [from, to] = AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
  const initials = escapeSvgText(getPersonaInitials(safeName));
  const gradientId = `persona-avatar-${hash}-${size}`;
  const fontSize = size >= 96 ? 44 : 24;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeSvgText(safeName)} avatar">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${from}" />
          <stop offset="100%" stop-color="${to}" />
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="url(#${gradientId})" />
      <circle cx="${size * 0.22}" cy="${size * 0.22}" r="${size * 0.26}" fill="rgba(255,255,255,0.16)" />
      <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="white" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${fontSize}" font-weight="700">${initials}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

export const getPersonaAvatarSrc = (
  persona: PersonaAvatarInput,
  size = 128
): string => {
  const avatar = persona.avatar?.trim();
  return avatar || getPersonaAvatarFallback(persona.name, size);
};

export const setPersonaAvatarFallback = (
  image: HTMLImageElement,
  name: string,
  size = 128
) => {
  image.onerror = null;
  image.src = getPersonaAvatarFallback(name, size);
};
