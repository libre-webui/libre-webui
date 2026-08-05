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

import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';

const router = express.Router();

/**
 * Sandbox flags for the artifact frame. They intentionally match the flags the
 * frontend sets on the embedding iframe: the browser intersects both, and a
 * mismatch would silently strip a capability.
 */
const ARTIFACT_SANDBOX_FLAGS =
  'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads';

const ARTIFACT_FRAME_ALLOW =
  'clipboard-read; clipboard-write; fullscreen; gamepad';

/**
 * Frame ancestors allowed to embed the sandbox host. Development serves the
 * frontend from a different port, and the packaged desktop build loads it from
 * `file://`, so both need explicit entries alongside the application origin.
 */
const artifactFrameAncestors = (): string => {
  const ancestors = new Set(["'self'", 'file:']);
  if (process.env.NODE_ENV !== 'production') {
    ancestors.add('http://localhost:*');
    ancestors.add('http://127.0.0.1:*');
    ancestors.add('http://[::1]:*');
  }
  for (const candidate of (process.env.CORS_ORIGIN || '').split(',')) {
    try {
      const origin = new URL(candidate.trim());
      if (origin.protocol === 'http:' || origin.protocol === 'https:') {
        ancestors.add(origin.origin);
      }
    } catch {
      // Ignore wildcard and malformed CORS entries in a CSP source list.
    }
  }
  return [...ancestors].join(' ');
};

/**
 * The policy that governs artifact markup. It is deliberately unrelated to the
 * application policy: inline scripts and eval are what artifacts are made of,
 * while every network directive stays closed, so an artifact can render and
 * compute but cannot reach a third-party host or the API it is served from.
 */
const artifactSandboxPolicy = (): string =>
  [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data:',
    'frame-src blob: data:',
    'child-src blob: data:',
    'worker-src blob:',
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${artifactFrameAncestors()}`,
    `sandbox ${ARTIFACT_SANDBOX_FLAGS}`,
  ].join('; ');

/**
 * Host document for HTML artifact previews.
 *
 * An `srcdoc` iframe inherits the embedder's Content Security Policy, so
 * artifact markup rendered that way is judged by the application policy and
 * every inline `<script>` is blocked in production. This document is fetched
 * over the network instead, which means it carries the policy above, and the
 * artifact frame it creates inherits *that* one.
 *
 * The host never touches artifact markup itself: it hands the document to a
 * nested frame and keeps the messaging channel, so a streaming artifact can be
 * re-rendered without another round trip.
 */
const SANDBOX_HOST_DOCUMENT = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Artifact preview</title>
    <style>
      html, body { height: 100%; margin: 0; background: transparent; }
      iframe { display: block; width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <script>
      (function () {
        var host = window.parent;
        if (!host || host === window) return;

        var frame = null;
        function render(markup) {
          if (!frame) {
            frame = document.createElement('iframe');
            frame.setAttribute('allow', '${ARTIFACT_FRAME_ALLOW}');
            frame.setAttribute('allowfullscreen', '');
            frame.setAttribute('title', 'Artifact');
            document.body.appendChild(frame);
          }
          frame.srcdoc = markup;
        }

        window.addEventListener('message', function (event) {
          if (event.source !== host) return;
          var data = event.data;
          if (!data || data.type !== 'libre-artifact:render') return;
          if (typeof data.html !== 'string') return;
          render(data.html);
        });

        host.postMessage({ type: 'libre-artifact:ready' }, '*');
      })();
    </script>
  </body>
</html>
`;

router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    message: 'Too many artifact requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// The sandbox host is a static document that carries no user data and reads
// none, so it stays unauthenticated: the frame that loads it has an opaque
// origin and cannot send credentials anyway.
router.get('/sandbox', (_req: Request, res: Response): void => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', artifactSandboxPolicy());
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()'
  );
  // frame-ancestors above is the authoritative embedding rule. Helmet's blanket
  // SAMEORIGIN would additionally reject the development server and the
  // desktop build's file:// document in browsers that still honour both.
  res.removeHeader('X-Frame-Options');
  res.send(SANDBOX_HOST_DOCUMENT);
});

export default router;
