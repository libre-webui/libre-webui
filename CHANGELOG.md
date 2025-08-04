# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ✨ Added

### 🔧 Technical Improvements

### 🐛 Bug Fixes

### 📚 Documentation

## [0.1.9] - 2025-08-04

### ✨ Added

- add live system message update

### 🔧 Technical Improvements

- unify input area and enhance styling in ChatInput component

### 🐛 Bug Fixes

- adjust component dimensions for better responsiveness in ArtifactRenderer and ChatInput
- improve mobile behavior and truncate model display in ChatMessage and GenerationStats components
- update package versions to 0.1.8 and related dependencies
- add rate limiting for /api/chat route
- add rate limiting for /api/auth and /api/users routes
- increase Ollama rate limit for streaming support
- add rate limiting for /api/ollama and /api/documents routes
- add rate limiting for /api/preferences route

### 🔄 Other Changes

- deps(deps): bump the all-dependencies group with 7 updates
- release: v0.1.8

## [0.1.8] - 2025-08-01

### 🔒 Security Enhancements

- **Critical Persona Privacy Fix:** Fixed major security vulnerability where personas were accessible across users due to missing authentication middleware and fallback to 'default' user
- **Proper User Isolation:** Added authentication middleware (`optionalAuth`) to all user-context API routes ensuring complete user data isolation
- **Memory Privacy:** Fixed persona memory system to properly scope to the creating user, preventing cross-user memory access

### 📱 Mobile Experience Improvements

- **Enhanced Mobile Sidebar UX:** Redesigned mobile sidebar behavior - removed close button and replaced with smart compact/expand functionality
- **Improved Mobile Navigation:** Mobile users can now easily switch between chats without getting stuck - sidebar compacts instead of closing
- **Mobile Content Animation:** Fixed mobile content animation to slide right instead of compressing, preserving readability and maintaining proper proportions
- **Click-Away Support:** Added intelligent click-away detection that compacts expanded sidebar on mobile for better UX
- **Touch-Optimized Interactions:** Enhanced touch manipulation and improved button targets for better mobile usability

### ✨ New Features

- **Single Sign-On (SSO):** Complete GitHub and Hugging Face OAuth2 integration with secure token handling and enhanced user experience
- **Model Selector Enhancements:** Repositioned and added compact mode to ModelSelector component with improved UI/UX
- **AI-Powered Development Tools:** Integrated AI-powered changelog generation and development analysis tools for better project maintenance

### 🔧 Technical Improvements

- **Authentication Architecture:** Implemented proper authentication middleware across all API routes requiring user context
- **Memory System Refactoring:** Fixed parameter ordering and improved memory retrieval for persona-specific data
- **Code Quality:** Removed unused dependencies, fixed linting warnings, and optimized component performance with proper useCallback usage
- **OAuth Security:** Enhanced OAuth callback handling with better error handling and prevention of multiple executions
- **Docker Configuration:** Updated Docker files with improved OAuth environment variable support

### 🐛 Critical Bug Fixes

- **Persona Visibility Bug:** Resolved issue where personas created by one user were visible to other users
- **Memory Parameter Fix:** Corrected `getMemories()` parameter order that was causing memory lookup failures
- **Authentication Context:** Fixed missing user context in API calls that was causing fallback to 'default' user
- **Mobile Sidebar State:** Fixed mobile sidebar getting stuck in closed state without recovery options
- **useCallback Dependencies:** Resolved React Hook dependency warnings in PersonaCard component

### 📚 Documentation & Developer Experience

- **Enhanced Changelog Generation:** Improved AI-powered changelog generation with better categorization and clarity
- **OAuth Documentation:** Added comprehensive OAuth setup and configuration documentation
- **Mobile UX Guidelines:** Documented mobile-first design principles and touch interaction patterns

### ⚠️ Breaking Changes

- Personas created before this version may need to be reassigned to the correct user if they were incorrectly stored under 'default' user
- API routes now properly enforce user authentication - unauthenticated requests will no longer fall back to 'default' user context

### 🎯 User Impact

- **Enhanced Privacy:** Your personas and memories are now truly private and cannot be accessed by other users
- **Better Mobile Experience:** Significantly improved mobile navigation with intuitive sidebar behavior and proper content layout
- **Improved Security:** Enhanced user data isolation and proper authentication across all user-specific features
- **Smoother Interactions:** Better touch support and optimized animations create a more responsive mobile experience

## [0.1.7] - 2025-07-22

## Libre WebUI v0.1.7 - 2025-07-22

This release focuses on enhanced security and usability with the addition of Single Sign-On (SSO) options and improvements to the overall user experience. We've also invested in streamlining our development process with AI-powered tools for analysis and changelog generation.

**✨ New Features**

- **Single Sign-On (SSO):** Added support for GitHub and Hugging Face OAuth2, allowing users to easily log in with their existing accounts.
- **AI Development Analysis:** Introduced AI-powered tools to assist with development and provide insights into project health.
- **AI-Powered Changelog Generation:** Implemented automated changelog generation to improve release note accuracy and efficiency.

**🔧 Improvements**

- **OAuth Configuration:** Enhanced OAuth configuration handling for both GitHub and Hugging Face, providing clearer error messages and a more streamlined setup process.
- **Performance:** Optimized token management functions for improved application responsiveness.
- **Docker Support:** Updated Dockerfile and provided example environment variables for GitHub OAuth configuration in Docker Compose.

**🐛 Bug Fixes**

- **OAuth Handling:** Resolved issues with OAuth callback handling to prevent multiple executions and improve user feedback.
- **Emoji Display:** Corrected emoji display in documentation and improved overall formatting.
- **API URL Consistency:** Refactored API base URL handling for consistency across the application.

**📚 Documentation**

- Expanded documentation for AI Development Analysis and Changelog Regeneration scripts.
- Improved documentation formatting and clarity throughout the project.

--

## [0.1.6] - 2025-07-20

## Libre WebUI v0.1.6 - 2025-07-20

This release focuses on enhancing the user experience with improved streaming performance, a more refined chat interface, and expanded documentation. We've also streamlined the release process and improved overall stability. This version delivers a smoother and more feature-rich experience for both casual users and developers.

### ✨ Added

- **View Mode Toggle:** Introduced a toggle to switch between different viewing modes for artifact rendering, providing greater control over how outputs are displayed.
- **OpenRouter Support:** Expanded multi-AI support to include OpenRouter, offering users more flexibility in choosing their preferred AI providers.
- **Debugging Tools for Streaming:** Added initial debugging tools to assist in diagnosing and resolving issues with streaming performance.

### 🔧 Improved

- **Streaming Performance:** Significantly enhanced streaming performance through batching of messages, resulting in faster and more responsive chat interactions.
- **Chat Message Scrolling:** Improved scrolling behavior within the `ChatMessages` component, making it easier to follow conversations, especially during active streaming.
- **Model Update Instructions:** Enhanced instructions for updating models in the README, providing clearer guidance for users.
- **Release Process:** Streamlined the release process by incorporating code formatting _before_ committing changes, ensuring consistent code style across releases.

### 🐛 Fixed

- **README Typo:** Corrected a typographical error in the README front matter.
- **Release Script Error Handling:** Improved error handling and validation within the release script, making it more robust and reliable.

### 📚 Documentation

- **Documentation Layout:** Added necessary imports for `Tabs` and `TabItem` components to enhance the layout and organization of documentation pages.
- **Updated Documentation:** General documentation updates across multiple files (00-README.md, 01-QUICK_START.md, 02-WORKING_WITH_MODELS.md, 03-PRO_TIPS.md, 04-KEYBOARD_SHORTCUTS.md, 05-DEMO_MODE.md) to reflect the latest features and improvements.

### 🔒 Security

- No security-related changes in this release.

### ⚠️ Breaking Changes

- No breaking changes in this release.

### Technical Details

- **Streaming Optimization:** Implemented message batching during streaming to reduce network overhead and improve perceived responsiveness. This involved refactoring the message handling logic within the streaming component.
- **Release Process Automation:** The release process now includes a pre-commit hook that automatically formats code using a configured formatter (e.g., Prettier). This ensures consistent code style and reduces the risk of style-related merge conflicts.
- **Documentation Updates:** Documentation updates primarily focused on clarifying existing instructions and adding details about new features. The addition of `Tabs` and `TabItem` imports allows for more structured and organized documentation layouts.
- **Error Handling:** Improved error handling in the release script now includes more specific error messages and validation checks to identify and address potential issues during the release process.

### User Impact

- **Faster Chat Experience:** The streaming performance improvements result in a noticeably faster and more responsive chat experience, especially when interacting with AI models.
- **Improved Usability:** The enhanced scrolling behavior makes it easier to follow conversations and review past messages.
- **Clearer Guidance:** Updated documentation provides clearer instructions and guidance for using Libre WebUI, making it easier for new users to get started.
- **More Flexible AI Choices:** Support for OpenRouter expands the range of AI providers users can choose from.

---

## [0.1.5] - 2025-07-20

## Libre WebUI v0.1.5 - 2025-07-20

This release focuses on bolstering the core infrastructure of Libre WebUI, enhancing security, and significantly expanding documentation to empower both users and developers. We've added support for OpenRouter, improved key management for persistent storage, and streamlined the overall user experience through various refinements.

### ✨ Added

- **OpenRouter Support:** Integrated support for the OpenRouter API, allowing users to leverage a wider range of models and providers. Includes model fetching and update scripts for seamless integration.
- **Persistent Storage for Encryption Keys:** Added support for Docker persistent storage for encryption keys, ensuring key security and availability across container restarts.

### 🔧 Improved

- **User Email Handling:** Updated user email handling to allow `null` values instead of requiring empty strings, providing greater flexibility in user data management.
- **JWT and Encryption Handling:** Enhanced JWT and encryption handling for improved security and reliability.
- **Docker Build Process:** Updated the Dockerfile to include additional dependencies for SQLite and OpenSSL, streamlining the local build process and improving compatibility.

### 🐛 Fixed

- **Changelog Generation:** Improved the changelog generation process in the release script to filter noise and better categorize commits, resulting in a cleaner and more informative changelog.
- **Linting Issues:** Addressed various linting issues throughout the codebase, improving code quality and maintainability.

### 📚 Documentation

- **Extensive Documentation Updates:** Significantly expanded documentation with new sections covering:
  - Plugin Architecture
  - RAG (Retrieval Augmented Generation) Feature
  - SQLite Migration
  - Model Updater
  - Authentication & Security
  - Artifacts Feature
  - Release Automation
  - Docker External Ollama Setup
  - Persona Development Framework
  - Community Charter
- **Development Branch Guide:** Added a guide for contributing to the development branch.
- **Outdated Database Encryption Removal:** Removed the outdated Database Encryption implementation, streamlining the codebase and focusing on the new, improved key management system.

### 🔒 Security

- **Enhanced Key Management:** Implemented support for Docker persistent storage for encryption keys, providing a more secure and reliable method for storing sensitive data.
- **JWT & Encryption Improvements:** Strengthened JWT and encryption handling to mitigate potential security vulnerabilities.
- **Security Documentation:** Expanded security documentation to provide users with a comprehensive understanding of the security features and best practices.

### ⚠️ Breaking Changes

- None in this release.

### Technical Details

- **SQLite & OpenSSL Dependencies:** The Dockerfile now explicitly includes SQLite and OpenSSL, ensuring consistent build environments and resolving potential dependency issues.
- **Encryption Key Storage:** Encryption keys are now designed to be stored persistently outside the container, preventing data loss on container restarts. This is achieved through volume mounting in Docker.
- **OpenRouter Integration:** The OpenRouter integration leverages the API to dynamically fetch available models and their configurations. The update scripts facilitate keeping the model list current.
- **JWT Handling:** JWTs are now generated and validated with enhanced security measures, including stronger algorithms and key rotation considerations.

### User Impact

This release provides a more robust and secure experience for all Libre WebUI users. The addition of OpenRouter expands model options, while improved documentation empowers users to customize and extend the platform. The enhanced security features protect user data and ensure a reliable and trustworthy experience. The streamlined build process and improved changelog make development and contribution easier for the community.

---

## [0.1.4] - 2025-07-17

## Libre WebUI v0.1.4 - 2025-07-17

This release focuses on enhancing the security and reliability of Libre WebUI, introducing database encryption and improved error handling. We've also made significant improvements to API rate limiting and streamlined dependency management. These changes aim to provide a more secure and robust experience for all users.

### ✨ Added

- **Automatic Encryption Key Generation:** Libre WebUI now automatically generates and stores an encryption key in the `.env` file during initial setup, simplifying the configuration process.
- **Database Encryption Service:** Implemented a robust database encryption service utilizing AES-256-GCM to protect sensitive user data at rest.

### 🔧 Improved

- **API Rate Limiting:** Enhanced rate limiting for the `/api/personas` route, allowing up to 500 requests per window. This prevents abuse and ensures service stability. Rate limiting logic has been refined across persona operations for better performance.
- **Error Handling:** Improved error handling in database migration and encryption processes, providing more informative error messages and preventing unexpected failures.
- **Preference Decryption:** Refactored the preference decryption logic for improved clarity and maintainability.

### 🐛 Fixed

- **Dependency Updates:** Updated `@napi-rs/canvas` and other core dependencies to the latest versions, resolving potential vulnerabilities and improving performance.
- **Header Component Dependencies:** Cleaned up unnecessary dependencies within the Header component, reducing bundle size and improving load times.

### 📚 Documentation

- **Changelog Updates:** Added an "Unreleased" section to the changelog to facilitate smoother release automation and tracking of upcoming changes.
- **README Updates:** Updated the README.md file with relevant information about the latest features and improvements.

### 🔒 Security

- **AES-256-GCM Encryption:** Implemented AES-256-GCM encryption for the entire database, protecting user data from unauthorized access. The encryption key is securely stored and managed.
- **Dependency Updates:** Updated dependencies to address potential security vulnerabilities.

### ⚠️ Breaking Changes

- None. This release does not introduce any breaking changes.

### Technical Details

- **Encryption Implementation:** The database encryption service utilizes AES-256-GCM with a randomly generated key stored in the `.env` file. This key should be treated as highly sensitive and protected accordingly.
- **Rate Limiting:** Rate limiting is implemented using a sliding window algorithm to provide a balance between performance and protection against abuse.
- **Dependency Management:** `package-lock.json` has been updated to ensure consistent dependency versions across all environments.
- **`.env` Configuration:** The `.env` file now includes a variable for the encryption key. Users should ensure this file is not committed to version control.

### User Impact

- **Enhanced Security:** Database encryption protects your personal data from unauthorized access, providing peace of mind.
- **Improved Reliability:** Enhanced error handling and dependency updates contribute to a more stable and reliable experience.
- **Faster Performance:** Dependency cleanup and optimized rate limiting contribute to improved performance and responsiveness.
- **Simplified Setup:** Automatic encryption key generation simplifies the initial setup process.

---

## [0.1.3] - 2025-07-16

## Libre WebUI v0.1.3 - 2025-07-16

This release focuses on enhancing the Persona management experience, improving security, and laying the groundwork for more advanced features like memory and mutation engines. We've also made significant improvements to documentation and developer tooling, making it easier to contribute and extend Libre WebUI.

### ✨ Added

- **Persona Management:** Implemented avatar and background image upload components within the PersonaForm for richer persona customization.
- **Memory & Mutation Engine Services:** Added core services for Memory and Mutation engines, paving the way for more dynamic and intelligent chatbot behavior.
- **Gemini Plugin Support:** Added support for the Gemini plugin, including specific payload formatting and response conversion.
- **Contributor Recognition:** Added a `CONTRIBUTORS.md` file to publicly acknowledge and thank project maintainers and community contributors.
- **Model Updater Enhancements:** Expanded the model updater with support for new providers and models, increasing flexibility and choice.

### 🔧 Improved

- **Persona Export/Import:** Enhanced Persona export/import functionality to include embedding model, memory, and mutation settings, enabling complete persona backups and sharing.
- **Persona Interface:** Improved the Persona page layout and styles for a more intuitive user experience. Streamlined memory status display in the PersonaCard component.
- **Chat Input:** Updated the ChatInput component to display the version number and a warning message.
- **Embedding Model Selection:** Enhanced the Persona Development Framework section with dynamic embedding model selection and advanced memory systems documentation. The PersonaForm now supports dynamic model selection.
- **File Uploads:** Simplified API calls for file uploads by removing redundant headers, improving efficiency.
- **Dependency Management:** Updated dependencies across the project, ensuring compatibility and stability.

### 🐛 Fixed

- **Persona Download:** Improved error handling in the persona download function for more robust operation.
- **Network Access (Development):** Enabled network access for the development server using the `--host` flag, facilitating easier local testing.
- **Import Resolution:** Refactored imports to use file extensions, resolving potential import issues.

### 📚 Documentation

- **Persona Development Framework:** Expanded documentation to cover dynamic embedding model selection and advanced memory systems.
- **Contribution Guidelines:** Updated contribution guidelines to direct pull requests to the `dev` branch instead of `main`.

### 🔒 Security

- **SSRF Vulnerability:** Fixed a Server-Side Request Forgery (SSRF) vulnerability in `pluginService.ts`.
- **Format String Injection:** Fixed a format string injection vulnerability in `chatService.ts`.
- **JWT Secret Handling:** Updated JWT_SECRET handling for both production and development environments to improve security.
- **Rate Limiting:** Implemented rate limiting for persona operations to prevent abuse and ensure service availability. Reordered middleware and updated configuration for the `/api/personas` route to optimize rate limiting effectiveness. CodeQL analysis was performed to identify and address potential vulnerabilities.

### ⚠️ Breaking Changes

- None identified in this release.

### Technical Details

- **Docker Updates:** Updated the Dockerfile and package.json to ensure a consistent and reproducible build environment. Added a missing dependency (`lowlight`) to the Dockerfile.
- **CI/CD:** Updated the Docker build action to version 6.
- **Refactoring:** Removed unused components and cleaned up the codebase for improved maintainability. Simplified API calls and streamlined component rendering.
- **Rate Limiting Implementation:** Rate limiting is implemented using a token bucket algorithm with configurable limits per IP address.
- **Gemini Plugin Integration:** The Gemini plugin integration utilizes a specific payload format and response conversion logic to ensure compatibility with the Libre WebUI API.

---

## [0.1.2] - 2025-07-09

## Libre WebUI v0.1.2 - 2025-07-09

This release focuses on significantly expanding user personalization and management capabilities with the introduction of the Persona Development Framework. Alongside this, we’ve made substantial improvements to security, user experience, and core functionality like model pulling and chat interactions. This version delivers a more robust and customizable experience for all users.

### ✨ Added

- **Persona Development Framework:** Introduced a comprehensive framework for creating, managing, and utilizing custom personas within the chat interface. Users can now define unique personalities and backgrounds for their AI interactions.
- **Persona Import/Export:** Added functionality to export personas as JSON files, allowing for easy sharing and backup. Users can also import personas from existing JSON files.
- **Model Pulling with Streaming Progress:** Implemented a new model pulling mechanism with streaming progress updates and cancellation support, providing a more responsive and user-friendly experience when downloading models.
- **Conditional Keyboard Shortcuts Indicator:** Added a visual indicator to the chat interface to display available keyboard shortcuts, improving usability.
- **Loading Screen Branding:** Enhanced the loading screen during authentication with a logo and branding elements for a more polished user experience.

### 🔧 Improved

- **Chat Functionality with Persona Support:** Enhanced the chat functionality to seamlessly integrate with the Persona Development Framework. Users can now select and apply personas to their chat sessions.
- **Persona Management in Chat Sessions:** Improved chat session management to include persona selection and background application, ensuring consistent personality throughout the conversation.
- **User Management & CORS:** Enhanced user management features with optional password updates and improved CORS handling for multi-user environments.
- **Background Image Handling:** Improved background image handling for a more visually appealing and customizable interface.
- **Chat Input Enhancements:** Enhanced the ChatInput component with advanced features toggle and improved button layout for better usability.
- **Helmet Configuration:** Updated Helmet configuration with a production-ready Content Security Policy (CSP) for enhanced security.

### 🐛 Fixed

- **Persona Table Initialization:** Resolved an issue with the initialization of the persona table in the database.
- **Session Handling Redirection:** Corrected session handling to properly include the location pathname for redirection logic.
- **Raw JSON Response for Persona Download:** Fixed an issue where persona downloads were returning an API response wrapper instead of raw JSON.
- **Multi-User CORS Origin:** Resolved a CORS issue affecting multi-user environments.
- **Shell Command Injection Vulnerabilities:** Addressed and mitigated potential shell command injection vulnerabilities in release scripts.

### 📚 Documentation

- **Persona Development Framework Documentation:** Added comprehensive documentation detailing the Persona Development Framework, including instructions on creating, managing, and utilizing personas.

### 🔒 Security

- **Enhanced Security Headers & CSP:** Updated security headers and implemented a robust Content Security Policy (CSP) for improved protection against various attacks, especially for Docker deployments.
- **CSP Configuration for Production:** Fine-tuned the CSP configuration for production environments to maximize security without impacting functionality.

### ⚠️ Breaking Changes

- None identified in this release.

### Technical Details

- **Database Schema Update:** The persona table has been added to the database schema. Developers should ensure their database migrations are up-to-date.
- **API Endpoints:** New API endpoints have been added for persona management (creation, editing, deletion, import/export). Refer to the updated API documentation for details.
- **CORS Configuration:** The CORS configuration has been updated to allow for more flexible origin handling. Developers should review the configuration to ensure it meets their specific requirements.
- **CSP Configuration:** The CSP configuration has been significantly updated. Developers should review the configuration to ensure it aligns with their security policies and application requirements.
- **Chat Service Refactor:** The chat service has been refactored to integrate with the Persona Development Framework. Developers extending the chat service should be aware of these changes.
- **PersonaRow Interface:** The `PersonaRow` interface has been simplified by removing unused fields to improve code clarity and maintainability.

---

## [0.1.1] - 2025-07-07

## Libre WebUI v0.1.1 - 2025-07-07

This release focuses on significantly improving Docker deployment, enhancing configuration options, and streamlining the release process. We've added robust automation for releases and made it easier to customize and deploy Libre WebUI in various environments, including support for external Ollama instances. This version also lays the groundwork for future scalability and maintainability.

### ✨ Added

- **Automated Release System:** Implemented a fully automated release pipeline using conventional commits, enabling faster and more reliable releases. The release script now supports `--patch`, `--minor`, and `--major` flags for version bumping.
- **External Ollama Support (Docker):** The Docker setup now supports connecting to an external, pre-existing Ollama instance, providing greater flexibility in deployment scenarios.
- **Dynamic Version Display:** The application now dynamically displays the version number from `package.json` within the SettingsModal, ensuring users always have access to the current version information.
- **Configurable Data Directory:** Added the `DATA_DIR` environment variable, allowing users to specify the database path for persistent data storage.

### 🔧 Improved

- **Docker Deployment:** Major improvements to the Dockerfile and related files for multi-service startup, flexible frontend port configuration, and environment variable handling. WebSocket connection logic has been updated for improved stability.
- **Timeout Configurations:** Enhanced timeout configurations for both the Ollama service and API calls, improving responsiveness and reliability under varying network conditions.
- **Code Readability & Consistency:** Significant improvements to code formatting and consistency across the codebase, particularly within Docker-related files, enhancing maintainability and collaboration.

### 🐛 Fixed

- **Docker Configuration Issues:** Resolved several issues related to Docker deployment, including incorrect configurations and potential startup failures.
- **WebSocket Connection Stability:** Addressed issues with WebSocket connections within the Docker environment, improving the overall stability of the application.

### 📚 Documentation

- **Docker Documentation:** Updated the README with comprehensive documentation for Docker configurations, including instructions for external Ollama setup and environment variable usage. Improved table formatting for better readability.
- **General README Updates:** Clarified various sections of the README for improved user understanding.

### 🔒 Security

- No specific security changes in this release.

### ⚠️ Breaking Changes

- No breaking changes are introduced in this release.

### Technical Details

- **Conventional Commits:** The release process now leverages conventional commits for automated versioning and changelog generation.
- **Dockerfile Optimization:** The Dockerfile has been restructured to support multi-service startup and improved resource utilization.
- **Environment Variable Configuration:** The addition of `DATA_DIR` and improved handling of other environment variables provide greater control over application behavior.
- **WebSocket Updates:** WebSocket connection logic has been updated to handle potential connection issues and improve stability.

### User Impact

- **Easier Deployment:** The improved Docker configuration and external Ollama support make it significantly easier to deploy Libre WebUI in various environments.
- **Increased Customization:** The `DATA_DIR` environment variable allows users to customize data storage locations.
- **Enhanced Reliability:** Improved timeout configurations and WebSocket stability contribute to a more reliable and responsive user experience.
- **Automatic Updates:** The automated release system ensures users receive timely updates with new features and bug fixes.

---
