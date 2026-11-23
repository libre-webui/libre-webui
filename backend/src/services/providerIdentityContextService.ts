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

import { getPersistence } from '../persistence/index.js';
import type { Plugin, ProviderRequestContext } from '../types/index.js';
import { encryptionService } from './encryptionService.js';

export class ProviderIdentityContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderIdentityContextError';
  }
}

/**
 * Resolve the stable subject of the OIDC identity already verified by Libre.
 * Provider integrations must never derive an external identity from a display
 * name, email address, or browser-supplied header.
 */
export async function requireVerifiedOidcSubject(
  userId: string
): Promise<string> {
  if (!userId) {
    throw new ProviderIdentityContextError(
      'Authenticated Libre user context is required'
    );
  }

  const identities =
    await getPersistence(
      encryptionService
    ).repositories.security.oauthIdentities.listByUser(userId);

  const oidcIdentities = identities.filter(
    identity => identity.provider === 'oidc'
  );

  if (oidcIdentities.length !== 1) {
    throw new ProviderIdentityContextError(
      'Exactly one verified OIDC identity is required for this provider'
    );
  }

  const subject = oidcIdentities[0].subject.trim();
  if (!subject) {
    throw new ProviderIdentityContextError(
      'Verified OIDC identity subject is empty'
    );
  }

  return subject;
}

/** Resolve identity metadata only for providers that explicitly request it. */
export async function enrichProviderRequestContext(
  plugin: Pick<Plugin, 'request_context'>,
  requestContext?: ProviderRequestContext
): Promise<ProviderRequestContext | undefined> {
  if (!plugin.request_context?.identity_subject_header) {
    return requestContext;
  }

  if (!requestContext?.userId) {
    throw new ProviderIdentityContextError(
      'Provider requires an authenticated OIDC identity'
    );
  }

  return {
    ...requestContext,
    identitySubject: await requireVerifiedOidcSubject(requestContext.userId),
  };
}
