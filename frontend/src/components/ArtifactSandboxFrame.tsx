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

import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  HTML_ARTIFACT_ALLOW,
  HTML_ARTIFACT_SANDBOX,
  isArtifactSandboxReady,
  postArtifactDocument,
} from '@/utils/artifactHtml';
import {
  ARTIFACT_RUNTIME_ORIGIN,
  ARTIFACT_SANDBOX_URL,
} from '@/utils/artifactSandbox';
import {
  buildArtifactSandboxDocument,
  type ArtifactSandboxKind,
} from '@/utils/artifactRuntimeDocument';

/**
 * How long to wait for the sandbox host to announce itself before falling back.
 * A backend that predates the sandbox route, or a proxy that rewrites it, never
 * answers; the preview should degrade to the source view instead of hanging.
 */
const SANDBOX_HANDSHAKE_TIMEOUT_MS = 8000;

interface ArtifactSandboxFrameProps {
  content: string;
  title: string;
  kind?: ArtifactSandboxKind;
  colorScheme?: 'light' | 'dark';
  className?: string;
  testId?: string;
  fallback?: React.ReactNode;
}

/**
 * Runs untrusted artifact code inside the backend-served sandbox host. The
 * document travels by `postMessage` rather than `srcdoc` so that it is governed
 * by the sandbox policy instead of inheriting the application's, which forbids
 * the inline scripts artifacts are made of.
 */
export const ArtifactSandboxFrame: React.FC<ArtifactSandboxFrameProps> = ({
  content,
  title,
  kind = 'html',
  colorScheme = 'light',
  className,
  testId = 'artifact-html-preview',
  fallback,
}) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const [unavailable, setUnavailable] = useState(false);

  const document = useMemo(
    () =>
      buildArtifactSandboxDocument(kind, content, title, {
        origin: ARTIFACT_RUNTIME_ORIGIN,
        colorScheme,
      }),
    [kind, content, title, colorScheme]
  );
  const documentRef = useRef(document);

  // Streaming artifacts change while the host is already listening.
  useEffect(() => {
    documentRef.current = document;
    if (readyRef.current) {
      postArtifactDocument(frameRef.current, document);
    }
  }, [document]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!isArtifactSandboxReady(event, frameRef.current)) return;
      readyRef.current = true;
      postArtifactDocument(frameRef.current, documentRef.current);
    };

    window.addEventListener('message', handleMessage);
    const timer = window.setTimeout(() => {
      if (!readyRef.current) setUnavailable(true);
    }, SANDBOX_HANDSHAKE_TIMEOUT_MS);

    return () => {
      window.removeEventListener('message', handleMessage);
      window.clearTimeout(timer);
    };
  }, []);

  if (unavailable && fallback) {
    return <>{fallback}</>;
  }

  return (
    <iframe
      ref={frameRef}
      data-testid={testId}
      src={ARTIFACT_SANDBOX_URL}
      className={className}
      sandbox={HTML_ARTIFACT_SANDBOX}
      allow={HTML_ARTIFACT_ALLOW}
      allowFullScreen
      title={title}
    />
  );
};

export default ArtifactSandboxFrame;
