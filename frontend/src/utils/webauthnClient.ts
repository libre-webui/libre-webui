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
 * Browser-side passkey plumbing: converts the backend's base64url ceremony
 * options into WebAuthn API calls and serializes the responses back.
 */

export const passkeysSupported = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential !== 'undefined' &&
  typeof navigator.credentials?.create === 'function';

const bufferFromBase64Url = (value: string): ArrayBuffer => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
};

const base64UrlFromBuffer = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

interface DescriptorLike {
  type: string;
  id: string;
}

/** Create a new passkey from backend registration options. */
export const createPasskeyCredential = async (
  publicKey: Record<string, unknown>
): Promise<{
  rawId: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
}> => {
  const user = publicKey.user as {
    id: string;
    name: string;
    displayName: string;
  };
  const options: PublicKeyCredentialCreationOptions = {
    ...(publicKey as unknown as PublicKeyCredentialCreationOptions),
    challenge: bufferFromBase64Url(publicKey.challenge as string),
    user: { ...user, id: bufferFromBase64Url(user.id) },
    excludeCredentials: (
      (publicKey.excludeCredentials as DescriptorLike[] | undefined) ?? []
    ).map(descriptor => ({
      type: 'public-key',
      id: bufferFromBase64Url(descriptor.id),
    })),
  };
  const credential = (await navigator.credentials.create({
    publicKey: options,
  })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error('Passkey creation was cancelled');
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    rawId: base64UrlFromBuffer(credential.rawId),
    response: {
      clientDataJSON: base64UrlFromBuffer(response.clientDataJSON),
      attestationObject: base64UrlFromBuffer(response.attestationObject),
      transports:
        typeof response.getTransports === 'function'
          ? response.getTransports()
          : [],
    },
  };
};

/** Complete a passkey sign-in from backend login options. */
export const getPasskeyAssertion = async (
  publicKey: Record<string, unknown>
): Promise<{
  rawId: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
}> => {
  const options: PublicKeyCredentialRequestOptions = {
    ...(publicKey as unknown as PublicKeyCredentialRequestOptions),
    challenge: bufferFromBase64Url(publicKey.challenge as string),
  };
  const credential = (await navigator.credentials.get({
    publicKey: options,
  })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error('Passkey sign-in was cancelled');
  }
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    rawId: base64UrlFromBuffer(credential.rawId),
    response: {
      clientDataJSON: base64UrlFromBuffer(response.clientDataJSON),
      authenticatorData: base64UrlFromBuffer(response.authenticatorData),
      signature: base64UrlFromBuffer(response.signature),
      userHandle: response.userHandle
        ? base64UrlFromBuffer(response.userHandle)
        : null,
    },
  };
};
