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
 * Generic OIDC sign-in (IAM-06).
 *
 * Discovery-based OpenID Connect with the full browser-flow defenses:
 * CSRF state, PKCE (S256), and a nonce bound into the verified ID token.
 * ID tokens are validated against the provider's JWKS (fetched and cached)
 * with issuer, audience, expiry, and nonce checks — no unverified decode.
 *
 * Identity is linked through the `oauth_identities` table on the stable
 * `sub` claim, so a renamed IdP account keeps its Libre account. An email
 * already used by an unlinked local account is rejected rather than
 * silently merged. Optional policies: allowed email domains, admin-role
 * mapping from a group claim, and per-login group membership sync.
 *
 * Configuration (environment):
 *   OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET  — required
 *   OIDC_DISPLAY_NAME     — login button label (default 'Single Sign-On')
 *   OIDC_SCOPES           — default 'openid profile email'
 *   OIDC_CALLBACK_URL     — default BASE_URL + /api/auth/oauth/oidc/callback
 *   OIDC_ALLOWED_EMAIL_DOMAINS — comma list; when set, a verified email in
 *                                one of these domains is required
 *   OIDC_GROUP_CLAIM      — claim holding group names (default 'groups')
 *   OIDC_ADMIN_GROUPS     — comma list; when set, the admin role is granted
 *                           and removed based on claim membership
 *   OIDC_SYNC_GROUPS      — 'true' reconciles Libre group memberships with
 *                           the group claim on every login
 */

import crypto, { createHash, createPublicKey, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { userModel, type UserPublic } from '../models/userModel.js';
import { authService } from './authService.js';
import { getPersistence } from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { recordAuditEvent } from './securityAuditService.js';

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export interface OidcClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  nonce?: string;
  [claim: string]: unknown;
}

export class OidcError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

const DISCOVERY_CACHE_MS = 10 * 60 * 1000;
const JWKS_CACHE_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

const fetchJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new OidcError(
      `Request to ${new URL(url).origin} failed with ${response.status}`,
      'upstream-error'
    );
  }
  return response.json();
};

export class OidcOAuthService {
  private discoveryCache:
    | { document: DiscoveryDocument; fetchedAt: number; issuer: string }
    | undefined;
  private jwksCache:
    | { keys: Array<Record<string, unknown>>; fetchedAt: number; uri: string }
    | undefined;

  private get issuerUrl(): string | undefined {
    return process.env.OIDC_ISSUER_URL?.trim().replace(/\/$/, '') || undefined;
  }

  private get clientId(): string | undefined {
    return process.env.OIDC_CLIENT_ID?.trim() || undefined;
  }

  private get clientSecret(): string | undefined {
    return process.env.OIDC_CLIENT_SECRET?.trim() || undefined;
  }

  private get callbackUrl(): string {
    return (
      process.env.OIDC_CALLBACK_URL ||
      `${process.env.BASE_URL || 'http://localhost:3001'}/api/auth/oauth/oidc/callback`
    );
  }

  private get scopes(): string {
    return process.env.OIDC_SCOPES?.trim() || 'openid profile email';
  }

  get displayName(): string {
    return process.env.OIDC_DISPLAY_NAME?.trim() || 'Single Sign-On';
  }

  private get allowedEmailDomains(): string[] {
    return (process.env.OIDC_ALLOWED_EMAIL_DOMAINS ?? '')
      .split(',')
      .map(domain => domain.trim().toLowerCase())
      .filter(Boolean);
  }

  private get groupClaim(): string {
    return process.env.OIDC_GROUP_CLAIM?.trim() || 'groups';
  }

  private get adminGroups(): string[] {
    return (process.env.OIDC_ADMIN_GROUPS ?? '')
      .split(',')
      .map(group => group.trim())
      .filter(Boolean);
  }

  private get syncGroups(): boolean {
    return process.env.OIDC_SYNC_GROUPS?.trim().toLowerCase() === 'true';
  }

  isConfigured(): boolean {
    return Boolean(this.issuerUrl && this.clientId && this.clientSecret);
  }

  async discover(): Promise<DiscoveryDocument> {
    const issuer = this.issuerUrl;
    if (!issuer) throw new OidcError('OIDC is not configured', 'unconfigured');
    if (
      this.discoveryCache &&
      this.discoveryCache.issuer === issuer &&
      Date.now() - this.discoveryCache.fetchedAt < DISCOVERY_CACHE_MS
    ) {
      return this.discoveryCache.document;
    }
    const raw = (await fetchJson(
      `${issuer}/.well-known/openid-configuration`
    )) as Partial<DiscoveryDocument>;
    if (
      typeof raw.issuer !== 'string' ||
      typeof raw.authorization_endpoint !== 'string' ||
      typeof raw.token_endpoint !== 'string' ||
      typeof raw.jwks_uri !== 'string'
    ) {
      throw new OidcError('Invalid discovery document', 'discovery-invalid');
    }
    if (raw.issuer.replace(/\/$/, '') !== issuer) {
      throw new OidcError(
        'Discovery issuer does not match OIDC_ISSUER_URL',
        'issuer-mismatch'
      );
    }
    const document = raw as DiscoveryDocument;
    this.discoveryCache = { document, fetchedAt: Date.now(), issuer };
    return document;
  }

  /** PKCE pair for one flow. */
  createPkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  createNonce(): string {
    return randomBytes(24).toString('base64url');
  }

  async getAuthUrl(
    state: string,
    nonce: string,
    codeChallenge: string
  ): Promise<string> {
    const discovery = await this.discover();
    const params = new URLSearchParams({
      client_id: this.clientId ?? '',
      redirect_uri: this.callbackUrl,
      response_type: 'code',
      scope: this.scopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${discovery.authorization_endpoint}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    verifier: string
  ): Promise<{ idToken: string; accessToken?: string }> {
    const discovery = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.callbackUrl,
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
      code_verifier: verifier,
    });
    const data = (await fetchJson(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })) as { id_token?: string; access_token?: string };
    if (typeof data.id_token !== 'string') {
      throw new OidcError('Token response is missing id_token', 'no-id-token');
    }
    return {
      idToken: data.id_token,
      ...(typeof data.access_token === 'string'
        ? { accessToken: data.access_token }
        : {}),
    };
  }

  private async signingKeyFor(kid: string | undefined): Promise<string> {
    const discovery = await this.discover();
    const stale =
      !this.jwksCache ||
      this.jwksCache.uri !== discovery.jwks_uri ||
      Date.now() - this.jwksCache.fetchedAt > JWKS_CACHE_MS;
    if (stale) {
      const raw = (await fetchJson(discovery.jwks_uri)) as {
        keys?: Array<Record<string, unknown>>;
      };
      if (!Array.isArray(raw.keys)) {
        throw new OidcError('Invalid JWKS document', 'jwks-invalid');
      }
      this.jwksCache = {
        keys: raw.keys,
        fetchedAt: Date.now(),
        uri: discovery.jwks_uri,
      };
    }
    const keys = this.jwksCache?.keys ?? [];
    const jwk =
      keys.find(key => kid !== undefined && key.kid === kid) ??
      (kid === undefined && keys.length === 1 ? keys[0] : undefined);
    if (!jwk) {
      // One refetch on rotation: the kid may be newer than the cache.
      this.jwksCache = undefined;
      throw new OidcError('No matching signing key', 'jwks-no-key');
    }
    return createPublicKey({
      key: jwk as crypto.JsonWebKeyInput['key'],
      format: 'jwk',
    })
      .export({ type: 'spki', format: 'pem' })
      .toString();
  }

  /** Verify signature, issuer, audience, expiry, and nonce. */
  async verifyIdToken(
    idToken: string,
    expectedNonce: string
  ): Promise<OidcClaims> {
    const discovery = await this.discover();
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      throw new OidcError('Malformed ID token', 'id-token-invalid');
    }
    const kid =
      typeof decoded.header.kid === 'string' ? decoded.header.kid : undefined;
    let pem: string;
    try {
      pem = await this.signingKeyFor(kid);
    } catch (error) {
      if (error instanceof OidcError && error.code === 'jwks-no-key') {
        pem = await this.signingKeyFor(kid);
      } else {
        throw error;
      }
    }
    let claims: OidcClaims;
    try {
      claims = jwt.verify(idToken, pem, {
        algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'],
        audience: this.clientId,
        issuer: discovery.issuer,
      }) as OidcClaims;
    } catch {
      throw new OidcError('ID token verification failed', 'id-token-invalid');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) {
      throw new OidcError('ID token is missing sub', 'id-token-invalid');
    }
    if (claims.nonce !== expectedNonce) {
      throw new OidcError('ID token nonce mismatch', 'nonce-mismatch');
    }
    return claims;
  }

  private claimGroups(claims: OidcClaims): string[] {
    const value = claims[this.groupClaim];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
    if (typeof value === 'string') {
      return value.split(/[\s,]+/).filter(Boolean);
    }
    return [];
  }

  private assertEmailPolicy(claims: OidcClaims): void {
    const domains = this.allowedEmailDomains;
    if (domains.length === 0) return;
    const email = typeof claims.email === 'string' ? claims.email : '';
    const domain = email.split('@')[1]?.toLowerCase();
    if (
      !domain ||
      !domains.includes(domain) ||
      claims.email_verified !== true
    ) {
      throw new OidcError(
        'This identity provider account is not allowed to sign in',
        'email-domain-denied'
      );
    }
  }

  private async syncRoleAndGroups(
    user: UserPublic,
    claims: OidcClaims
  ): Promise<UserPublic> {
    const groups = this.claimGroups(claims);
    let current = user;

    const adminGroups = this.adminGroups;
    if (adminGroups.length > 0) {
      const shouldBeAdmin = groups.some(group => adminGroups.includes(group));
      const mappedRole = shouldBeAdmin ? 'admin' : 'user';
      if (current.role !== mappedRole) {
        const updated = await userModel.updateUser(current.id, {
          role: mappedRole,
        });
        if (updated) current = updated;
        void recordAuditEvent({
          action: 'oidc.role-sync',
          result: 'success',
          actorUserId: current.id,
          targetType: 'user',
          targetId: current.id,
          details: { role: mappedRole },
        });
      }
    }

    if (this.syncGroups) {
      const security = getPersistence(encryptionService).repositories.security;
      const allGroups = await security.groups.list();
      const memberships = new Set(
        await security.groups.listGroupIdsForUser(current.id)
      );
      for (const group of allGroups) {
        const claimed = groups.includes(group.name);
        const isMember = memberships.has(group.id);
        if (claimed && !isMember) {
          await security.groups.addMember({
            group_id: group.id,
            user_id: current.id,
            added_by: 'oidc-sync',
            added_at: Date.now(),
          });
        } else if (!claimed && isMember) {
          await security.groups.removeMember(group.id, current.id);
        }
      }
    }
    return current;
  }

  /**
   * Resolve the verified claims to a Libre account: linked identity first,
   * then policy-checked account creation. Never links by bare email.
   */
  async processClaims(claims: OidcClaims): Promise<UserPublic> {
    this.assertEmailPolicy(claims);
    const security = getPersistence(encryptionService).repositories.security;
    const subject = claims.sub;
    const email =
      typeof claims.email === 'string' && claims.email.trim()
        ? claims.email.trim()
        : null;

    const identity = await security.oauthIdentities.find('oidc', subject);
    if (identity) {
      const user = await userModel.getUserById(identity.user_id);
      if (!user) {
        throw new OidcError(
          'The linked account no longer exists',
          'account-missing'
        );
      }
      await security.oauthIdentities.upsert({
        ...identity,
        email,
        updated_at: Date.now(),
      });
      return this.syncRoleAndGroups(user, claims);
    }

    if (!authService.isPublicRegistrationEnabled()) {
      const userCount = await userModel.getUserCount();
      if (userCount > 0) {
        throw new OidcError(
          'Registration is disabled on this server',
          'registration-disabled'
        );
      }
    }

    if (email && (await userModel.emailExists(email))) {
      // A local account already owns this email. Refuse a silent merge —
      // the user should sign in locally and link explicitly.
      throw new OidcError(
        'An account with this email already exists',
        'email-in-use'
      );
    }

    const preferred =
      typeof claims.preferred_username === 'string' &&
      claims.preferred_username.trim()
        ? claims.preferred_username.trim()
        : subject;
    const base = `oidc_${preferred.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)}`;
    let username = base;
    let counter = 1;
    while (await userModel.usernameExists(username)) {
      username = `${base}_${counter}`;
      counter += 1;
    }

    const user = await userModel.createPublicUser({
      username,
      email,
      password: 'oauth:' + randomBytes(24).toString('base64'),
    });
    if (!user) {
      throw new OidcError('Account creation failed', 'account-create-failed');
    }
    const now = Date.now();
    await security.oauthIdentities.upsert({
      provider: 'oidc',
      subject,
      user_id: user.id,
      email,
      created_at: now,
      updated_at: now,
    });
    void recordAuditEvent({
      action: 'oidc.link',
      result: 'success',
      actorUserId: user.id,
      targetType: 'user',
      targetId: user.id,
      details: { username, created: true },
    });
    if (user.status !== 'active') return user;
    return this.syncRoleAndGroups(user, claims);
  }
}

export const oidcOAuthService = new OidcOAuthService();
