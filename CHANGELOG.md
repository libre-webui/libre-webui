# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ✨ New Features

### 🔧 Improvements

### 🐛 Bug Fixes

### 📚 Documentation

## [0.4.0] - 2026-01-14

### What's New

This release introduces comprehensive internationalization support, making Libre WebUI accessible to users worldwide with 21 new language options. The interface now supports multiple languages with proper right-to-left text rendering for Arabic and includes a convenient language switcher component.

### ✨ New Features

- **Multi-language support**: Added translations for 24 languages including Arabic (with RTL support), Chinese, French, German, Spanish, Italian, Japanese, Korean, Russian, Hindi, Bengali, Thai, Vietnamese, Indonesian, Dutch, Polish, Czech, Ukrainian, Danish, Swedish, Portuguese, Icelandic, Malay, and Turkish
- **Language switcher component**: New interface element allowing users to easily change the application language
- **Right-to-left text support**: Proper RTL rendering for Arabic and other RTL languages

### 🔧 Improvements

- Enhanced type safety across backend routes with improved type assertions
- Updated workflow permissions configuration for better security compliance

## [0.3.3] - 2026-01-13

### What's New

This release introduces private chat sessions with in-memory storage, allowing users to have conversations that aren't persisted to the main chat history. We've also refreshed the brand with a new "Libre" wordmark and improved typography, plus added native macOS installation support through Homebrew.

### ✨ New Features

- **Private Chat Sessions**: Start private conversations with in-memory storage and clear UI indicators to distinguish from regular chats
- **macOS Installation**: Native Homebrew formula and cask support for easy installation on macOS systems
- **Enhanced WebSocket Communication**: Message history now included in private chat sessions for better context preservation

### 🔧 Improvements

- **New Branding**: Updated to "Libre" wordmark with refreshed logos and favicons across the application
- **Typography Update**: Switched to 'Roboto Slab' font for consistent branding throughout the interface
- **Better Error Handling**: Global 401 Unauthorized error handling in API response interceptor
- **Enhanced Chat Layout**: Improved ChatMessage component styling and updated LoginPage branding
- **Documentation Expansion**: Added comprehensive guides for Docker, Kubernetes, hardware requirements, and environment variables

### 🐛 Bug Fixes

- Fixed Helm package version synchronization in CI pipeline

## [0.3.2] - 2026-01-09

### What's New

This release introduces Kubernetes deployment support with a complete Helm chart, making it easier to deploy Libre WebUI in production environments. We've also enhanced the Docker development workflow with dedicated development builds and improved documentation.

### ✨ New Features

- **Kubernetes Support**: Added comprehensive Helm chart for Kubernetes deployments with configurable services, ingress, autoscaling, and Ollama integration
- **Development Docker Images**: Introduced dedicated `-dev` tagged Docker images for development builds
- **Enhanced Docker Compose**: Added GPU-enabled and external Ollama configurations for both development and production environments

### 🔧 Improvements

- **CI/CD Pipeline**: Automated Docker image building and Helm chart publishing workflows
- **Documentation**: Expanded README with comprehensive Docker and Kubernetes deployment guides
- **Development Experience**: Added development-specific Docker Compose configurations for various use cases
- **Version Display**: Settings modal now clearly shows `-dev` tag for development builds

## [0.3.1] - 2026-01-08

### What's New

This release focuses on security and stability improvements with a critical fix for plugin authentication handling and updated dependencies. The plugin service now properly respects authentication requirements, ensuring better security for authenticated environments.

### 🔧 Improvements

- Updated React Router to version 7.12.0 for enhanced security and performance

### 🐛 Bug Fixes

- Fixed plugin service to properly respect `no_auth_required` setting when filtering plugins by capability

## [0.3.0] - 2026-01-08

### What's New

This release introduces a comprehensive image generation system with gallery management, plugin support, and enhanced UI components. Major security improvements include rate limiting and vulnerability fixes, while the interface receives theme consistency updates and better navigation.

### ✨ New Features

- **Image Generation Plugin System**: Full plugin architecture supporting image generation with ComfyUI integration
- **Image Gallery**: Dedicated gallery page with lightbox viewer and organized image management
- **Enhanced Model Selector**: Improved model selection interface with expanded options
- **Plugin Credentials Service**: Secure credential management for plugin authentication

### 🔧 Improvements

- **Imagine Workflow**: Image generation now redirects to gallery page with additional options
- **Chat Input**: Removed auto-send behavior when generating images for better user control
- **Theme Consistency**: Primary theme colors now applied to Imagine page
- **Plugin Network Access**: HTTP connections now allowed for private network IPs

### 🐛 Bug Fixes

- **Security**: Added rate limiting and resolved format string vulnerabilities
- **Artifact Navigation**: Fixed navigation issues within iframe components
- **AMOLED Theme**: Drag handle now correctly uses purple accent color

## [0.2.9] - 2026-01-08

### What's New

This release introduces a major overhaul of the artifacts viewing experience with a new slide-out panel system and resizable interface. We've also added secure per-user API key storage for plugins, giving users better control over their plugin credentials.

### ✨ New Features

- **Artifacts slide-out panel**: View artifacts in a dedicated resizable panel with drag handle for better content inspection
- **Per-user plugin API keys**: Store and manage API keys securely on a per-user basis for enhanced plugin functionality

### 🔧 Improvements

- Enhanced input field styling consistency across dark and light themes
- Updated plugin interface with improved button alignment and status indicators

### 🐛 Bug Fixes

- Fixed artifact expand button visibility when titles are too long
- Prevented inline artifact height overflow by adding proper constraints
- Resolved package version synchronization issues
- Corrected plugin status dot visibility problems

## [0.2.8] - 2026-01-07

### 🐛 Bug Fixes

- Fixed crash when running via `npx libre-webui` - the backend couldn't find `package.json` to read the version number because the file path structure is different when installed via npm vs development. The server would start but immediately crash with "Cannot find module '../package.json'".

## [0.2.7] - 2026-01-06

### 🐛 Bug Fixes

- Fixed data persistence when running via npx (data now stored in `~/.libre-webui/`)
- Fixed first-time setup not showing encryption key to user

### 🔧 Improvements

- Changed default port to 8080 in production
- Added startup message with version and URL
- Browser now opens automatically on startup

## [0.2.6] - 2026-01-06

### What's New

This release fixes critical issues preventing `npx libre-webui` from running correctly.

### 🐛 Bug Fixes

- Fixed `__dirname is not defined` error in ESM modules (encryptionService)
- Fixed Express 5 wildcard route syntax (`*` → `{*splat}`)
- Fixed CORS blocking API requests when frontend is served from same port
- Fixed frontend not serving on root path in production
- Fixed frontend connecting to wrong API port in production builds
- Fixed route registration order (routes now register before error handlers)
- Fixed missing packages error when installing via npx

## [0.2.2] - 2026-01-05

### What's New

This release brings significant enhancements to the chat experience with live LaTeX formula rendering and improved UI navigation. The persona system has been upgraded with better memory capabilities and streamlined display, while new code-aware input features enhance developer workflows.

### ✨ New Features

- **Live LaTeX formatting** - Scientific formulas now render automatically in chat messages
- **Code-aware text input** - Enhanced text area with syntax highlighting and code-specific features
- **Copy button for messages** - Quickly copy any chat message content
- **Scroll-to-bottom button** - Easy navigation in long chat conversations
- **Media upload component** - New interface for uploading files and media

### 🔧 Improvements

- **Enhanced persona memory system** - Improved context retention and recall capabilities
- **Redesigned persona display** - Cleaner sidebar layout for persona and TTS controls
- **Better persona management** - Streamlined persona cards and quick-switch functionality
- **Code signing support** - Electron app builds now include code signing with fallback options
- **Updated dependencies** - Latest versions of development tools and GitHub Actions

### 🐛 Bug Fixes

- Fixed background image state conflicts between system and persona themes
- Resolved persona button z-index layering issues
- Improved sidebar display consistency for persona and TTS elements

## [0.2.1] - 2026-01-04

### What's New

This release introduces conversation branching functionality, allowing users to explore different response paths and regenerate AI responses while maintaining conversation history. We've also enhanced the visual experience with improved syntax highlighting and better text-to-speech handling for longer messages.

### ✨ New Features

- **Conversation Branching**: Create and navigate different response paths within conversations with persistent branching support
- **Response Regeneration**: Regenerate AI responses while preserving conversation branches
- **Desktop Application**: Added official desktop app support
- **Cosmic Space Theme**: New purple AMOLED theme with custom syntax highlighting

### 🔧 Improvements

- Updated title generation prompts for better conversation naming
- Enhanced syntax highlighter with optimized performance
- Improved settings interface with cleaner organization
- Updated documentation with new screenshots and v0.2.0 features

### 🐛 Bug Fixes

- Fixed text-to-speech chunking for large messages to prevent audio cutoffs
- Resolved background chat image display issues
- Fixed database saving to skip undefined values and prevent data corruption

## [0.2.0] - 2026-01-04

### What's New

This release introduces a native desktop app for macOS, comprehensive text-to-speech functionality, and enhanced model discovery with Ollama integration. The update also brings visual improvements with new themes and better chat experience features.

### ✨ New Features

- **Desktop App**: Native Electron app for macOS Silicon with DMG installer and proper macOS integration
- **Text-to-Speech**: Complete TTS system with voice selection, settings panel, and one-click message playback
- **Model Discovery**: Browse Library section with Ollama model discovery and installation
- **Auto-Title Generation**: Automatic chat session titles for better organization
- **Chain-of-Thought**: Support for `<thinking>` tag in AI responses
- **New Theme**: Purple/AMOLED theme option

### 🔧 Improvements

- Enhanced first-time setup wizard now displays encryption key
- Improved new session styling and user experience
- Better plugin support for images across Anthropic, Gemini, and OpenAI
- Updated model provider configurations
- Darkened background view for better readability

### 🐛 Bug Fixes

- Fixed background image persistence and user data isolation
- Resolved TTS voice settings not being saved or loaded properly
- Fixed macOS desktop app click issues and traffic light button overlap
- Corrected API URL handling in Electron file:// protocol
- Auto-retry backend connection when starting desktop app
- Fixed environment file path detection for encryption key generation

## [0.1.11] - 2025-12-16

### 🔒 Security Fixes

- **Fixed High-Severity Vulnerabilities:** Resolved 3 critical security issues identified by Dependabot
  - HIGH: glob CLI command injection via -c/--cmd (GHSA-5j98-mcp5-4vw2)
  - HIGH: auth0/node-jws improperly verifies HMAC signature
  - MODERATE: mdast-util-to-hast unsanitized class attribute (GHSA-4fh9-h7wg-q85m)
  - MODERATE: body-parser denial of service vulnerability
  - MODERATE: js-yaml prototype pollution in merge (GHSA-mh29-5h37-fv8m)
  - MODERATE: vite server.fs.deny bypass on Windows
- **Zero Vulnerabilities:** All security issues resolved via npm audit fix

### 🐛 Bug Fixes

- Fixed React linting errors for OAuth components (useEffect dependencies)
- Replaced Math.random() with React.useId() hook in form components for proper ID generation
- Resolved setState-in-effect warnings in useChat hook

### 🔧 Technical Improvements

- Updated 47+ dependencies for improved stability and security
- CI pipeline enhancements: actions/checkout (5→6), actions/setup-node (5→6)
- Code quality improvements to pass stricter React linting rules

## [0.1.10] - 2025-09-17

### 🎨 UI/UX Enhancements

- **Fixed SettingsModal Corner Rendering:** Resolved visual bug where header border overlapped with container's rounded corners, creating an imperfect border appearance in the upper corners
- **Enhanced Keyboard Shortcuts Indicator:** Repositioned the KeyboardShortcutsIndicator to the top-right corner for better visual hierarchy and accessibility
- **Improved SettingsModal Layout:** Enhanced responsive behavior and layout consistency across different screen sizes

### ⚙️ Developer Experience

- **Enhanced Update Script:** Added environment variable loading support to the update script tool, enabling dynamic configuration during plugin updates and system maintenance
- **Plugin System Improvements:** Streamlined the plugin update process with better environment configuration handling

### 🔧 Technical Improvements

- **Dependency Security Updates:** Comprehensive dependency updates including 47+ package updates across development and production dependencies
- **CI Pipeline Enhancements:** Updated GitHub Actions workflow dependencies (actions/setup-node v4→v5, actions/checkout v4→v5) for improved build reliability
- **Package Management:** Optimized package-lock.json for better dependency resolution and security

## [0.1.9] - 2025-08-04

### 📱 Mobile Experience Revolution

- **Responsive Sidebar System:** Completely redesigned mobile sidebar behavior with intelligent layout switching - compact sidebar pushes content on mobile while expanded sidebar overlays, ensuring optimal space usage
- **Unified Chat Input Design:** Transformed the chat input into a modern, integrated interface similar to ChatGPT/Claude with all controls (attachment, model selector, send button) seamlessly embedded within a single rounded container
- **Mobile-First Artifact Display:** Redesigned artifact preview components with responsive dimensions (256px on mobile, 320px on tablet, 384px on desktop) and intelligent vertical stacking to prevent content overflow
- **Smart Model Name Truncation:** Long model names now truncate gracefully with responsive width limits (128px mobile, 192px desktop) and hover tooltips showing full names

### 🎨 User Interface Enhancements

- **Vertical Artifact Headers on Mobile:** Artifact headers now stack title above buttons on mobile for better space utilization and touch accessibility
- **Perfect Icon Alignment:** Fixed all button icon centering issues in chat input and artifact components for pixel-perfect visual consistency
- **Compact Mobile Controls:** Ultra-compact artifact controls (20px buttons) on mobile with icon-only interface, expanding to full-sized buttons with labels on desktop
- **Seamless Textarea Integration:** Chat input textarea now blends invisibly into the input container with transparent background and perfect text alignment

### ✨ Added

- **Live System Message Updates:** Dynamic system message updating capability for real-time configuration changes
- **Responsive Breakpoint System:** Comprehensive responsive design with mobile (< 640px), tablet (640px-1024px), and desktop (≥ 1024px) specific layouts
- **Touch-Optimized Interactions:** Enhanced touch manipulation and proper tap targets for all mobile controls

### 🔧 Technical Improvements

- **Mobile-Responsive Component Architecture:** Complete refactoring of layout components to support dual desktop/mobile layouts with intelligent switching
- **Flexbox Layout Optimization:** Advanced flexbox implementations for perfect alignment and responsive behavior across all screen sizes
- **CSS Class Hierarchy:** Implemented comprehensive responsive class system with mobile-first approach and desktop enhancements
- **Container Overflow Management:** Added proper overflow handling and width constraints to prevent horizontal scrolling issues

### 🐛 Bug Fixes

- **Mobile Content Overflow:** Fixed artifact content appearing beside preview windows instead of below on mobile screens
- **Sidebar Overlay Issues:** Resolved sidebar positioning conflicts where content would be pushed off-screen or overlap incorrectly
- **Icon Alignment Problems:** Corrected vertical centering issues across all button icons in chat interface and artifact controls
- **Model Name Display:** Fixed long model names breaking layout and overlapping with other UI elements
- **Container Spacing:** Resolved inconsistent spacing and padding issues across mobile and desktop layouts

### 🚀 Performance Improvements

- **Reduced Mobile Bundle:** Optimized mobile interfaces with conditional rendering and smaller component sizes
- **Smooth Animations:** Enhanced transitions and hover effects for better user feedback
- **Touch Performance:** Improved touch responsiveness with proper touch-action CSS properties

### 📚 User Experience Impact

- **Consistent Cross-Device Experience:** Seamless functionality whether using mobile phone, tablet, or desktop
- **Modern Chat Interface:** Contemporary design matching leading AI chat applications
- **Improved Accessibility:** Better touch targets, readable text sizes, and intuitive navigation patterns
- **Professional Visual Polish:** Pixel-perfect alignment and consistent spacing throughout the interface

### ⚠️ Breaking Changes

- None. All changes are backward compatible and enhance existing functionality.

### 🎯 Developer Experience

- **Responsive Design Patterns:** Established reusable patterns for mobile-first responsive components
- **Component Architecture:** Modular approach to layout components supporting multiple screen sizes
- **CSS Utility System:** Comprehensive responsive utility classes for consistent styling

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
