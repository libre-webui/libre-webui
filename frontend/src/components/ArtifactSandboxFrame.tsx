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

import React, { useEffect, useRef, useState } from 'react';

import {
  HTML_ARTIFACT_ALLOW,
  HTML_ARTIFACT_SANDBOX,
  isArtifactSandboxReady,
  postArtifactDocument,
} from '@/utils/artifactHtml';
import { ARTIFACT_SANDBOX_URL } from '@/utils/artifactSandbox';
import {
  buildArtifactSandboxDocument,
  type ArtifactSandboxKind,
} from '@/utils/artifactRuntimeDocument';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:artifact-sandbox-frame');

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
 * Runs untrusted artifact code inside the backend-served sandbox host.
 *
 * The document is assembled here, on the authenticated page, with the artifact
 * runtime inlined into it, and delivered by `postMessage`. The frame is
 * governed by the sandbox policy rather than inheriting the application's, and
 * it never issues a request of its own.
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
  const documentRef = useRef<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Assembling the document means loading the runtime bundles the artifact
  // needs, so it cannot happen during render.
  useEffect(() => {
    let cancelled = false;

    buildArtifactSandboxDocument(kind, content, title, { colorScheme })
      .then(document => {
        if (cancelled) return;
        documentRef.current = document;
        if (readyRef.current) {
          postArtifactDocument(frameRef.current, document);
        }
      })
      .catch(error => {
        if (cancelled) return;
        logger.error('Failed to prepare the artifact runtime:', error);
        setUnavailable(true);
      });

    return () => {
      cancelled = true;
    };
  }, [kind, content, title, colorScheme]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!isArtifactSandboxReady(event, frameRef.current)) return;
      readyRef.current = true;
      if (documentRef.current) {
        postArtifactDocument(frameRef.current, documentRef.current);
      }
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
      title={title}
    />
  );
};

export default ArtifactSandboxFrame;
