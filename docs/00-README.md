---
sidebar_position: 1
title: 'Libre WebUI'
description: 'Install Libre WebUI, connect the models you choose, build with agents, and deploy a private AI workspace.'
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
    ai creation tools,
    model providers,
    coding agent,
    isolated workspace,
    document chat,
    ai deployment,
  ]
---

import CodeBlock from '@theme/CodeBlock';

<div className="docs-landing">
  <header>
    <p className="docs-landing__eyebrow">Libre WebUI</p>
    <h1 className="docs-landing__title">Make whatever comes next.</h1>
    <p className="docs-landing__lede">
      {"Run Libre WebUI locally, bring the models you choose, work with documents and media, or give an agent a durable project workspace. Everything opens as a tab in one workspace. Start with the task you want to accomplish."}
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
      <p className="docs-landing__command-label">One-command local start</p>
      <div className="docs-landing__command">
        <CodeBlock language="bash">npx libre-webui@latest</CodeBlock>
      </div>
      <p className="docs-landing__command-note">
        {"Open your private workspace at "}<code>http://localhost:8080</code>{"."}
      </p>
    </div>
  </header>

  <section className="docs-landing__section" aria-labelledby="choose-a-task">
    <p className="docs-landing__section-label">01 / Choose a task</p>
    <h2 id="choose-a-task">What do you want to do?</h2>

    <div className="docs-landing__grid">
      <article className="docs-landing-card">
        <span className="docs-landing-card__index">01</span>
        <h3 className="docs-landing-card__title">Run privately</h3>
        <p className="docs-landing-card__copy">
          {"Install Libre WebUI on your own machine and begin with Ollama or another model you control."}
        </p>
        <a className="docs-landing-card__link" href="/QUICK_START">
          {"Follow the Quick Start"}
        </a>
      </article>

      <article className="docs-landing-card">
        <span className="docs-landing-card__index">02</span>
        <h3 className="docs-landing-card__title">Connect your models</h3>
        <p className="docs-landing-card__copy">
          {"Use bundled providers, an OpenAI-compatible service, a self-hosted gateway, or a coding agent already installed on the machine."}
        </p>
        <a className="docs-landing-card__link" href="/PROVIDER_CONNECTIONS">
          {"Connect a model provider"}
        </a>
      </article>

      <article className="docs-landing-card">
        <span className="docs-landing-card__index">03</span>
        <h3 className="docs-landing-card__title">Build with Work</h3>
        <p className="docs-landing-card__copy">
          {"Give an agent a durable project with conversation, files, a terminal, tools, and a live application preview."}
        </p>
        <a className="docs-landing-card__link" href="/WORKSPACES">
          {"Explore Libre WebUI Work"}
        </a>
      </article>

      <article className="docs-landing-card">
        <span className="docs-landing-card__index">04</span>
        <h3 className="docs-landing-card__title">Deploy for others</h3>
        <p className="docs-landing-card__copy">
          {"Move from a local workspace to a maintained deployment with persistent data and access controls."}
        </p>
        <a className="docs-landing-card__link" href="/DOCKER">
          {"Plan a deployment"}
        </a>
      </article>
    </div>

  </section>

  <section className="docs-landing__section" aria-labelledby="find-your-way">
    <p className="docs-landing__section-label">02 / Get around</p>
    <h2 id="find-your-way">Everything is one tab away.</h2>

    <div className="docs-landing__path-grid">
      <div className="docs-landing-path">
        <h3>Start from Home</h3>
        <p>{"Home greets you, offers what to start, and lists the chats and Work sessions worth picking back up, with a live badge when a Work runtime is active."}</p>
      </div>

      <div className="docs-landing-path">
        <h3>Keep work side by side</h3>
        <p>{"Chats, Work sessions, and pages open as tabs beside Home. They survive a reload, so returning to a project returns you to where you left it."}</p>
      </div>

      <div className="docs-landing-path">
        <h3>Search instead of hunting</h3>
        <p>{"Press Cmd/Ctrl + K anywhere to reach a chat, a Work session, or an action. It works while you are typing a message, so a draft is never lost to navigation."}</p>
        <ul>
          <li><a href="/KEYBOARD_SHORTCUTS">All keyboard shortcuts</a></li>
        </ul>
      </div>
    </div>

  </section>

  <section className="docs-landing__section" aria-labelledby="read-the-docs">
    <p className="docs-landing__section-label">03 / Browse guides</p>
    <h2 id="read-the-docs">Find the path that matches your work.</h2>

    <div className="docs-landing__path-grid">
      <div className="docs-landing-path">
        <h3>Models and providers</h3>
        <p>{"Choose where inference runs and connect the services that fit your work."}</p>
        <ul>
          <li><a href="/WORKING_WITH_MODELS">Working with Models</a></li>
          <li><a href="/PROVIDER_CONNECTIONS">Connect Model Providers</a></li>
          <li><a href="/AGENT_CLI_MODELS">Use an Installed Coding Agent</a></li>
          <li><a href="/MLX_APPLE_SILICON">MLX LM on Apple Silicon</a></li>
          <li><a href="/HUGGINGFACE_HUB">Hugging Face Hub</a></li>
        </ul>
      </div>

      <div className="docs-landing-path">
        <h3>Create and automate</h3>
        <p>{"Turn conversations into durable projects, reusable context, and working material."}</p>
        <ul>
          <li><a href="/WORKSPACES">Work: Isolated Workspaces</a></li>
          <li><a href="/CALENDAR">Calendar</a></li>
          <li><a href="/AUTOMATIONS">Automations</a></li>
          <li><a href="/CHAT_TOOLS">Chat Tools</a></li>
          <li><a href="/PROMPTS">Prompt Library</a></li>
          <li><a href="/SKILLS">Skills</a></li>
          <li><a href="/ASSISTANT_PROFILES">Assistant Profiles</a></li>
          <li><a href="/RAG_FEATURE">Document Chat</a></li>
          <li><a href="/ARTIFACTS_FEATURE">Artifacts</a></li>
          <li><a href="/PERSONA_DEVELOPMENT_FRAMEWORK">Personas</a></li>
          <li><a href="/KEYBOARD_SHORTCUTS">Keyboard Shortcuts</a></li>
        </ul>
      </div>

      <div className="docs-landing-path">
        <h3>Deploy and administer</h3>
        <p>{"Run a maintained installation with deliberate access, data, and configuration choices."}</p>
        <ul>
          <li><a href="/DOCKER">Docker</a></li>
          <li><a href="/AUTHENTICATION">Authentication</a></li>
          <li><a href="/ENVIRONMENT_VARIABLES">Environment Variables</a></li>
          <li><a href="/TROUBLESHOOTING">Troubleshooting</a></li>
        </ul>
      </div>
    </div>

  </section>
</div>
