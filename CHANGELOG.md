# Changelog

All notable changes to Libre WebUI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ✨ Added

### 🔧 Technical Improvements

### 🐛 Bug Fixes

### 📚 Documentation

## [0.1.4] - 2025-07-17

### 🔐 Security & Encryption

- **Database Encryption Service**: Implement AES-256-GCM encryption for all sensitive data at rest
- **Automatic Key Management**: Auto-generate and store encryption keys in .env file
- **Enhanced Rate Limiting**: Improved rate limiting for persona operations (500 requests per 15-minute window)

### 🐛 Bug Fixes

- Update @napi-rs/canvas and other dependencies to latest versions
- Improve error handling in migration and encryption processes, and refactor preference decryption logic
- Add rate limiting to /api/personas route and update dependency in Header component
- Update rate limiting for persona operations and clean up dependencies in Header component

### 🔧 Technical Improvements

- Enhanced preference decryption logic with proper error handling
- Improved React Hook optimizations and dependency management
- Better code organization and error logging

### 📚 Documentation

- Add unreleased section to changelog for proper release automation

## [0.1.3] - 2025-07-16

### ✨ Added

- implement avatar and background image upload components in PersonaForm
- add expand/collapse functionality for system messages and manage background image state based on current persona
- add embedding model and memory settings to personas and update PersonaForm for dynamic model selection
- Implement Memory and Mutation Engine Services
- Add CONTRIBUTORS.md file to recognize project maintainers and community contributors
- Add support for Gemini plugin with specific payload format and response conversion
- Enhance model updater with new providers and models

### 🔧 Technical Improvements

- remove unused components and clean up codebase
- display version and warning message in ChatInput component refactor: remove badge from SettingsModal component tabs
- simplify API calls by removing redundant headers for file uploads
- streamline memory status display in PersonaCard component
- update persona selector styles and enhance personas page layout
- Update Dockerfile and package.json and add lowlight missing dependency

### 🐛 Bug Fixes

- update JWT_SECRET handling for production and development environments
- reorder middleware for /api/personas route
- update rate limiter configuration for /api/personas route
- add advanced features to Persona export/import including embedding model, memory, and mutation settings
- embedding model handling and default parameter loading
- improve error handling in persona download function
- Refac imports to use file extensions and update dependencies
- Enable network access for development server with --host flag
- Update contribution guidelines to submit PRs against `dev` branch instead of `main`

### 📚 Documentation

- add unreleased section to changelog for proper release automation
- enhance Persona Development Framework section with dynamic embedding model selection and advanced memory systems

### 🔄 Other Changes

- security(rate-limiting): CodeQL: top level
- security(rate-limiting): implement rate limiting for persona operations
- refactor
- Merge pull request #26 from libre-webui/dependabot/github_actions/dev/docker/build-push-action-6
- Merge pull request #25 from libre-webui/dependabot/npm_and_yarn/dev/all-dependencies-b7e63996a2
- ci(deps): bump docker/build-push-action from 5 to 6
- deps(deps): bump the all-dependencies group with 3 updates
- Merge pull request #23 from libre-webui/feature/reveries-awakening
- Merge branch 'dev'
- security: Fix SSRF vulnerability in pluginService.ts
- Merge branch 'dev'
- security: Fix format string injection vulnerability in chatService.ts

## [0.1.2] - 2025-07-09

### ✨ Added

- Enhance documentation and implementation for Persona Development Framework
- Add persona download functionality with JSON export
- Enhance chat functionality with persona support
- Integrate persona management into chat sessions, including persona selection and background application
- Add persona selection to chat session creation and update related types and services
- Implement Persona management features including creation, editing, deletion, and import/export functionality
- implement model pulling with streaming progress and cancellation support
- update CORS methods and enhance user management with optional password update
- add conditional keyboard shortcuts indicator for chat pages
- enhance background image handling and user management
- update security headers and CSP for Docker compatibility
- add logo and branding to loading screen during authentication
- enhance Helmet configuration with production-ready CSP

### 🔧 Technical Improvements

- Simplify PersonaRow interface by removing unused fields and adjust chat store logging
- enhance ChatInput with advanced features toggle and improved button layout

### 🐛 Bug Fixes

- Send raw JSON response for persona download instead of API response wrapper
- Update session handling to include location pathname for redirection logic
- db init for persona table
- multi user cors origin
- resolve shell command injection vulnerabilities in release scripts

### 🔄 Other Changes

- Adds a Persona Development Framework allowing users to create, manage, and apply AI personas in chat sessions.

## [0.1.1] - 2025-07-07

### ✨ Added

- add --patch, --minor, --major flags to release script
- add automated release system with conventional commits
- dynamically display version from package.json in SettingsModal
- add DATA_DIR environment variable for database path configuration
- enhance timeout configurations for Ollama service and API calls
- Remove deprecated Docker files and add external Ollama support in Docker setup feat: Update README and documentation for Docker deployment and external Ollama configuration fix: Adjust Dockerfile for flexible frontend port configuration and environment variables style: Improve code readability and consistency across Docker-related files
- Enhance Dockerfile for multi-service startup and update WebSocket connection logic
- Docker deployment fixes and authentication improvements

### 🔧 Technical Improvements

- remove obsolete workflow files and update README for clarity
- format code for better readability and consistency

### 📚 Documentation

- Update README for Docker configurations and improve table formatting

### 🔄 Other Changes

- Merge branch 'main' of https://github.com/libre-webui/libre-webui into dev
- Merge pull request #20 from libre-webui/dependabot/npm_and_yarn/dev/all-dependencies-fa4baa3b98
- deps(deps): bump the all-dependencies group with 2 updates

## [0.1.0] - 2025-07-06

### 🎉 Initial Release

The first official release of Libre WebUI - a privacy-first, local-first AI chat interface with optional external service integration.

### ✨ Major Features

#### 🔐 Authentication & User Management

- **Complete authentication system** with secure JWT-based sessions
- **Multi-user support** with role-based access (admin/user)
- **Beautiful first-time setup** experience for admin account creation
- **User management interface** with CRUD operations
- **Rate limiting** for authentication, chat, and user management endpoints
- **WebSocket authentication** with token lifecycle management

#### 🗄️ Database Migration to SQLite

- **SQLite database** replacing JSON file storage for better performance
- **Automatic migration system** for existing JSON data
- **User data import/export** functionality with duplicate detection
- **Session management** with persistent storage
- **Preferences system** with user-specific settings

#### 🎨 Artifacts Feature

- **Interactive content rendering** for HTML, SVG, code snippets, and JSON
- **Automatic artifact detection** from code blocks in chat messages
- **Sandboxed execution** for security with iframe isolation
- **Full-screen viewing** mode for better content interaction
- **Copy & download functionality** for all artifact types
- **Intelligent parsing** with complexity detection to prevent spam artifacts

#### 🔌 Plugin Architecture

- **External AI service integration** (OpenAI, Anthropic, Groq)
- **Automatic model updates** from AI providers
- **Flexible plugin system** for easy service addition

#### 🎨 Custom Background Images

- **Background image upload** - Users can now upload custom background images
- **Real-time preview** - Background images are displayed immediately after upload
- **Configurable blur effect** - Adjustable blur amount (0-20px) for visual enhancement
- **Opacity control** - Customizable transparency (0-100%) for better text readability
- **Toggle functionality** - Enable/disable background images with a single click
- **Background removal** - Option to remove current background and reset to default
- **Semi-transparent UI** - Main content, header, and sidebar have semi-transparent backgrounds with blur effects
- **Persistent settings** - Background preferences are saved and synced across sessions
- **Error handling** - Comprehensive error handling for uploads and API calls
- **Performance optimized** - Efficient image handling with proper scaling and optimization

#### 📄 Document Processing (RAG)

- **Document upload** support (PDF, TXT, DOCX)
- **Semantic search** integration for document chat
- **Vector embeddings** with configurable models

### 🎨 User Interface

#### 🖼️ Modern Design System

- **Clean, responsive interface** that works on desktop, tablet, and mobile
- **Dark/light theme** support with proper color tokens
- **Improved component styling** with consistent design patterns
- **Enhanced settings modal** with custom range sliders
- **User menu dropdown** with portal rendering and proper positioning

#### ⚡ Performance Optimizations

- **Code splitting** and lazy loading for faster page loads
- **Real-time chat** with WebSocket streaming
- **Optimized artifact rendering** with duplicate prevention
- **Efficient state management** with Zustand stores

#### ⌨️ Developer Experience

- **VS Code-inspired keyboard shortcuts** (⌘B, ⌘D, ⌘,, ?)
- **Complete TypeScript coverage** across frontend and backend
- **Proper error handling** and loading states
- **Development mode debugging** with helpful console logs

### 🔒 Security Features

- **Sandboxed artifact execution** with iframe security
- **Content validation** for all user inputs
- **Rate limiting** on all API endpoints
- **Secure password handling** with proper hashing
- **CORS configuration** for development and production
- **Input sanitization** for HTML and code content

### 🛠️ Technical Improvements

#### Backend

- **Express.js API** with comprehensive route handling
- **JWT authentication** with proper token management
- **Database migrations** with automatic schema updates
- **WebSocket server** for real-time communication
- **Plugin service architecture** for external API integration
- **Comprehensive error handling** and logging

#### Frontend

- **React 18** with modern hooks and functional components
- **TypeScript** for type safety across the application
- **Tailwind CSS** with custom design tokens
- **React Router** for client-side navigation
- **Zustand** for state management
- **Axios** for API communication with interceptors

#### Custom Background Images - Technical Implementation

- **Type safety** - Full TypeScript support for background settings
- **State management** - Integrated background state into Zustand app store
- **API integration** - Background settings persist via preferences API
- **Component architecture** - Modular components for upload, rendering, and configuration
- **UI integration** - Seamlessly integrated into existing Settings modal

### 📚 Documentation

- **Complete documentation suite** with 14 comprehensive guides
- **Step-by-step setup guides** for quick onboarding
- **Feature documentation** for all major capabilities
- **Technical implementation guides** for developers
- **Troubleshooting guides** for common issues

### 🧪 Quality Assurance

- **ESLint configuration** with TypeScript support
- **Prettier formatting** for consistent code style
- **Git hooks** for pre-commit validation
- **Security scanning** with CodeQL integration
- **Comprehensive testing** of all major features

### 📦 Deployment & Operations

- **Docker support** with development and production configurations
- **npm scripts** for easy development workflow
- **Environment configuration** for different deployment scenarios
- **Logging system** for debugging and monitoring
- **Health check endpoints** for service monitoring

### 🎯 Highlights

This release establishes Libre WebUI as a **production-ready alternative** to corporate AI chat interfaces, with:

- **Privacy-first architecture** - Everything runs locally by default
- **No telemetry or tracking** - Your data stays on your hardware
- **Open source** - Complete transparency and community control
- **Feature parity** with leading AI chat interfaces
- **Extensible plugin system** for future growth
- **Professional user experience** with modern UI/UX

### 🚀 Getting Started

```bash
# Quick start
git clone https://github.com/libre-webui/libre-webui
cd libre-webui
./start.sh
```

Visit the [documentation](./docs/00-README.md) for detailed setup instructions.

### 🤝 Contributing

We welcome contributions! See our [contributing guide](./docs/00-README.md#contributing) for details.

### 📄 License

This project is licensed under the Apache License 2.0. See [LICENSE](./LICENSE) for details.

---

**Full Changelog**: https://github.com/libre-webui/libre-webui/commits/v0.1.0
