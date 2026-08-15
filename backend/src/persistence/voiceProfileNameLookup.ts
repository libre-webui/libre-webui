/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { IdentityEmailCodec } from './types.js';

const LOOKUP_DOMAIN = 'voice-profile-name:v1\0';

/**
 * Produce the locale-independent comparison form used by both persistence
 * adapters. NFKC prevents visually equivalent compatibility forms from
 * bypassing the per-model uniqueness rule.
 */
export const normalizeVoiceProfileName = (name: string): string =>
  name.normalize('NFKC').toLowerCase();

export const createVoiceProfileNameLookup = (
  codec: Pick<IdentityEmailCodec, 'lookupToken'>,
  name: string
): string =>
  codec.lookupToken(`${LOOKUP_DOMAIN}${normalizeVoiceProfileName(name)}`);
