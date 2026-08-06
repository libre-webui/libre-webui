/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_LOG_LEVEL?: string;
  readonly VITE_DEBUG_VERBOSE?: string;
  readonly VITE_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected at build time from the root CHANGELOG.md (see vite.config.ts). */
declare const __LATEST_RELEASE_NOTES__: {
  version: string;
  date: string;
  body: string;
} | null;

/** Identifies the artifact runtime build; defined in vite.config.ts. */
declare const __ARTIFACT_RUNTIME_FINGERPRINT__: string;
