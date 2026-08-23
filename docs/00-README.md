---
sidebar_position: 1
title: 'Libre WebUI'
description: 'Install Libre WebUI, give models governed tools and cited knowledge, collaborate with a team, create with voice and media, and operate a production deployment.'
slug: /
hide_title: true
hide_table_of_contents: true
keywords:
  [
    libre webui,
    ollama,
    local ai,
    self-hosted ai,
    ai workspace,
    ai agents,
    model tools,
    cited knowledge,
    team collaboration,
    voice mode,
    media editing,
    ai operations,
  ]
---

import CodeBlock from '@theme/CodeBlock';

<div className="docs-landing">
  <header>
    <p className="docs-landing__eyebrow">Libre WebUI</p>
    <h1 className="docs-landing__title">Make whatever comes next.</h1>
    <p className="docs-landing__lede">
      {"Run Libre WebUI on infrastructure you control. Give supported models governed tools, ground answers in cited documents, work with a team, speak in turn-based voice mode, create and edit media, and carry the same workspace from a laptop to a multi-replica deployment."}
    </p>
    <div className="docs-landing__actions">
      <a className="docs-landing__primary" href="/QUICK_START">
        {"Install Libre WebUI"}
      </a>
      <a className="docs-landing__secondary" href="https://demo.librewebui.org">
        {"Try the demo"}
      </a>
      <a
        className="docs-landing__source"
        href="https://github.com/libre-webui/libre-webui"
      >
        {"View source"}
      </a>
    </div>
    <div className="docs-landing__command-block">
      <p className="docs-landing__command-label">One command, no Libre WebUI vendor account</p>
      <div className="docs-landing__command">
        <CodeBlock language="bash">npx libre-webui@latest</CodeBlock>
      </div>
      <p className="docs-landing__command-note">
        {"Open the workspace at "}<code>http://localhost:8080</code>{". Add Ollama for local models or connect a supported provider when you choose."}
      </p>
    </div>
  </header>

  <section className="docs-landing__section" aria-labelledby="choose-a-task">
    <p className="docs-landing__section-label">01 / Choose a task</p>
    <h2 id="choose-a-task">What do you want to do?</h2>

    <div className="docs-landing__grid">
      <article className="docs-landing-card">
        <span className="docs-landing-card__index">01</span>
        <h3 className="docs-landing-card__title">Start on your own infrastructure</h3>
        <p className="docs-landing-card__copy">
          {"Run one command, use a local Ollama model or a supported provider, and keep deployment choices in your hands."}
        </p>
        <a className="docs-landing-card__link" href="/QUICK_START">
          {"Install Libre WebUI"}
        </a>
      </article>

      <article className="docs-landing-card">
        <span className="docs-landing-card__index">02</span>
        <h3 className="docs-landing-card__title">Let models act safely</h3>
        <p className="docs-landing-card__copy">
          {"Use built-in, OpenAPI, or HTTP MCP tools with live call state, per-user access, and approval before side effects."}
        </p>
        <a className="docs-landing-card__link" href="/CHAT_TOOLS">
          {"Configure Chat Tools"}
        </a>
      </article>

      <article className="docs-landing-card">
        <span className="docs-landing-card__index">03</span>
        <h3 className="docs-landing-card__title">Ground answers in your knowledge</h3>
        <p className="docs-landing-card__copy">
          {"Search PDF, Office, Markdown, code, and data files with hybrid retrieval and trace answers to their source locations."}
        </p>
        <a className="docs-landing-card__link" href="/RAG_FEATURE">
          {"Use cited Document Chat"}
        </a>
      </article>

      <article className="docs-landing-card">
        <span className="docs-landing-card__index">04</span>
        <h3 className="docs-landing-card__title">Work with a team</h3>
        <p className="docs-landing-card__copy">
          {"Bring people and models into channels, share resources through live grants, and coordinate with notifications and calendars."}
        </p>
        <a className="docs-landing-card__link" href="/CHANNELS">
          {"Explore team collaboration"}
        </a>
      </article>

      <article className="docs-landing-card">
        <span className="docs-landing-card__index">05</span>
        <h3 className="docs-landing-card__title">Speak and create media</h3>
        <p className="docs-landing-card__copy">
          {"Hold turn-based voice conversations, generate speech and video, and edit or inpaint images in one per-user gallery."}
        </p>
        <a className="docs-landing-card__link" href="/VOICE_MODE">
          {"Start with Voice Mode"}
        </a>
      </article>

      <article className="docs-landing-card">
        <span className="docs-landing-card__index">06</span>
        <h3 className="docs-landing-card__title">Operate it in production</h3>
        <p className="docs-landing-card__copy">
          {"Add budgets, evaluations, structured telemetry, recovery gates, and a release-tested multi-replica team profile."}
        </p>
        <a className="docs-landing-card__link" href="/PLATFORM_FOUNDATION">
          {"Plan the platform"}
        </a>
      </article>
    </div>

  </section>

  <section className="docs-landing__section" aria-labelledby="find-your-way">
    <p className="docs-landing__section-label">02 / Get around</p>
    <h2 id="find-your-way">Everything is one tab away.</h2>

    <div className="docs-landing__path-grid">
      <div className="docs-landing-path">
        <h3>Compose an assistant</h3>
        <p>{"Assistant Profiles bind a model, prompt, tools, skills, knowledge collections, and voice while rechecking the current user's access whenever the profile runs."}</p>
        <ul>
          <li><a href="/ASSISTANT_PROFILES">Assistant Profiles</a></li>
        </ul>
      </div>

      <div className="docs-landing-path">
        <h3>Keep durable working material</h3>
        <p>{"Chats, isolated Work projects, and Markdown Notes persist independently. Notes add revision restore, attachments, sharing, export, and reversible AI-assisted edits."}</p>
        <ul>
          <li><a href="/NOTES">Notes</a></li>
          <li><a href="/WORKSPACES">Work: Isolated Workspaces</a></li>
        </ul>
      </div>

      <div className="docs-landing-path">
        <h3>Search instead of hunting</h3>
        <p>{"Press Cmd/Ctrl + K to reach an action or search authorized chat, note, and document content. Search runs over decrypted candidates in memory without a plaintext index on disk."}</p>
        <ul>
          <li><a href="/KEYBOARD_SHORTCUTS">All keyboard shortcuts</a></li>
          <li><a href="/PRO_TIPS">Daily workflows and chat controls</a></li>
        </ul>
      </div>
    </div>

  </section>

  <section className="docs-landing__section" aria-labelledby="read-the-docs">
    <p className="docs-landing__section-label">03 / Browse guides</p>
    <h2 id="read-the-docs">Find the path that matches your work.</h2>

    <div className="docs-landing__path-grid">
      <div className="docs-landing-path">
        <h3>Start and choose models</h3>
        <p>{"Install the workspace, size local hardware, and connect only the model routes you intend to use."}</p>
        <ul>
          <li><a href="/QUICK_START">Quick Start</a></li>
          <li><a href="/DEMO_MODE">Demo Mode</a></li>
          <li><a href="/WORKING_WITH_MODELS">Working with Models</a></li>
          <li><a href="/HARDWARE_REQUIREMENTS">Hardware Requirements</a></li>
          <li><a href="/PROVIDER_CONNECTIONS">Provider Connections</a></li>
          <li><a href="/PLUGIN_ARCHITECTURE">Provider Plugin Architecture</a></li>
          <li><a href="/HUGGINGFACE_HUB">Hugging Face Hub</a></li>
          <li><a href="/KIMI_CODE">Kimi Code</a></li>
          <li><a href="/MLX_APPLE_SILICON">MLX LM on Apple Silicon</a></li>
          <li><a href="/LOCAL_GPU_STACK">Local GPU Stack</a></li>
        </ul>
      </div>

      <div className="docs-landing-path">
        <h3>Agents and reusable assistants</h3>
        <p>{"Move from a governed tool call to a durable coding workspace — including a watchable, teachable Work Computer with a real browser — or a reusable assistant profile."}</p>
        <ul>
          <li><a href="/WORKSPACES">Work: Isolated Workspaces</a></li>
          <li><a href="/WORKSPACES#screen-the-work-computer">Work Computer: Screen, Takeover, and Teach</a></li>
          <li><a href="/CHAT_TOOLS">Chat Tools</a></li>
          <li><a href="/PROMPTS">Prompt Library</a></li>
          <li><a href="/SKILLS">Skills</a></li>
          <li><a href="/ASSISTANT_PROFILES">Assistant Profiles</a></li>
          <li><a href="/PERSONA_DEVELOPMENT_FRAMEWORK">Personas and Memory</a></li>
          <li><a href="/AGENT_CLI_MODELS">Installed Coding Agents</a></li>
          <li><a href="/LIBRE_CLAW_INTEGRATION">Libre Claw Integration</a></li>
          <li><a href="/ARTIFACTS_FEATURE">Interactive Artifacts</a></li>
          <li><a href="/PRO_TIPS">Pro Tips</a></li>
          <li><a href="/KEYBOARD_SHORTCUTS">Keyboard Shortcuts</a></li>
        </ul>
      </div>

      <div className="docs-landing-path">
        <h3>Knowledge, notes, and schedules</h3>
        <p>{"Keep source-grounded research, durable Markdown, live web results, calendars, and scheduled AI work together."}</p>
        <ul>
          <li><a href="/RAG_FEATURE">Document Chat and Citations</a></li>
          <li><a href="/NOTES">Notes</a></li>
          <li><a href="/WEB_SEARCH">Web Search</a></li>
          <li><a href="/CALENDAR">Calendar</a></li>
          <li><a href="/AUTOMATIONS">Automations</a></li>
        </ul>
      </div>

      <div className="docs-landing-path">
        <h3>Teams, voice, and media</h3>
        <p>{"Collaborate through live grants and channels, then add governed speech and per-user media workflows."}</p>
        <ul>
          <li><a href="/CHANNELS">Channels</a></li>
          <li><a href="/SHARING">Sharing</a></li>
          <li><a href="/NOTIFICATIONS">Notifications and Webhooks</a></li>
          <li><a href="/VOICE_MODE">Voice Mode</a></li>
          <li><a href="/SPEECH_TO_TEXT">Speech to Text</a></li>
          <li><a href="/MEDIA_GENERATION">Media Generation and Image Editing</a></li>
          <li><a href="/QWEN3_TTS">Qwen3-TTS</a></li>
          <li><a href="/KYUTAI_TTS">Kyutai TTS</a></li>
          <li><a href="/LONGCAT_AUDIODIT">LongCat AudioDiT</a></li>
        </ul>
      </div>

      <div className="docs-landing-path">
        <h3>Security, data, and operations</h3>
        <p>{"Control identity, storage, recovery, spend, quality, and telemetry with their boundaries documented explicitly."}</p>
        <ul>
          <li><a href="/AUTHENTICATION">Authentication and Access</a></li>
          <li><a href="/SINGLE_SIGN_ON">Single Sign-On</a></li>
          <li><a href="/DATABASE_ENCRYPTION">Database Encryption</a></li>
          <li><a href="/SQLITE_MIGRATION">SQLite Storage</a></li>
          <li><a href="/DATA_PORTABILITY">Data Portability</a></li>
          <li><a href="/RECOVERY_READINESS">Recovery Readiness</a></li>
          <li><a href="/ENVIRONMENT_VARIABLES">Environment Variables</a></li>
          <li><a href="/SYSTEM_MONITORING">System and Usage Analytics</a></li>
          <li><a href="/COST_GOVERNANCE">Costs and Budgets</a></li>
          <li><a href="/EVALUATIONS">Evaluations</a></li>
          <li><a href="/OBSERVABILITY">Observability</a></li>
          <li><a href="/PUBLIC_API">OpenAI-Compatible API</a></li>
          <li><a href="/OPEN_WEBUI_VS_LIBRE_WEBUI">Feature Comparison</a></li>
        </ul>
      </div>

      <div className="docs-landing-path">
        <h3>Deploy, maintain, and verify</h3>
        <p>{"Choose a supported topology, keep recovery evidence, and use executable contracts to verify what is actually shipped."}</p>
        <ul>
          <li><a href="/DOCKER">Docker</a></li>
          <li><a href="/DOCKER_EXTERNAL_OLLAMA">Docker with External Ollama</a></li>
          <li><a href="/KUBERNETES">Kubernetes and Helm</a></li>
          <li><a href="/PRIVATE_REMOTE_DEPLOYMENT">Private Remote Deployment</a></li>
          <li><a href="/PLATFORM_FOUNDATION">Platform Foundation and HA</a></li>
          <li><a href="/ELECTRON_DESKTOP_APP">Desktop App</a></li>
          <li><a href="/DEV_BRANCH">Development Branch</a></li>
          <li><a href="/RELEASE_AUTOMATION">Release Automation</a></li>
          <li><a href="/CAPABILITY_CONTRACTS">Provider Capability Contracts</a></li>
          <li><a href="/GLOBAL_CAPABILITY_CONTRACTS">Global Capability Contracts</a></li>
          <li><a href="/TROUBLESHOOTING">Troubleshooting</a></li>
          <li><a href="/CHARTER">Community and Ethical Charter</a></li>
          <li><a href="/COPYRIGHT">Copyright and License</a></li>
        </ul>
      </div>
    </div>

  </section>
</div>
