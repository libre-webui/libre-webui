---
sidebar_position: 17
title: "Development Branch Guide"
description: "Use the experimental dev branch to test latest features and help improve Libre WebUI. Learn how to report bugs and contribute."
slug: /DEV_BRANCH
keywords: [development, dev branch, experimental, testing, bug reports, contributing, latest features]
image: /img/social/17.png
---

# 🧪 Development Branch Guide

Want to try the latest features before they're officially released? The `dev` branch contains cutting-edge improvements and experimental features that will eventually make it to the main release.

:::warning Experimental Software
The `dev` branch is **experimental** and may contain bugs, incomplete features, or breaking changes. Use it only if you're comfortable with potential instability and want to help improve Libre WebUI.
:::

## 🎯 What is the Dev Branch?

The development branch (`dev`) is where new features are tested before being merged into the stable `main` branch. It includes:

- **Latest features** not yet in stable releases
- **Bug fixes** being tested
- **Experimental improvements** to the UI and functionality
- **Performance optimizations** under development

## 🚀 How to Use the Dev Branch

### Docker Setup (Recommended)

**With External Ollama:**
```bash
# Clone the repository
git clone https://github.com/libre-webui/libre-webui.git
cd libre-webui

# Switch to dev branch
git checkout dev

# Start with external Ollama configuration
docker-compose -f docker-compose.external-ollama.yml up -d
```

**Simple Docker:**
```bash
# Use the dev branch image
docker run -d -p 3000:8080 -v libre-webui:/app/backend/data --name libre-webui-dev --restart always ghcr.io/libre-webui/libre-webui:dev
```

### From Source

```bash
# Clone and switch to dev branch
git clone https://github.com/libre-webui/libre-webui.git
cd libre-webui
git checkout dev

# Install dependencies
npm install

# Start development server
npm run dev
```

## 🔄 Staying Updated

The dev branch is updated frequently. To get the latest changes:

```bash
# Update your local dev branch
git pull origin dev

# Rebuild Docker containers
docker-compose -f docker-compose.external-ollama.yml up -d --build

# Or restart simple Docker
docker pull ghcr.io/libre-webui/libre-webui:dev
docker stop libre-webui-dev && docker rm libre-webui-dev
docker run -d -p 3000:8080 -v libre-webui:/app/backend/data --name libre-webui-dev --restart always ghcr.io/libre-webui/libre-webui:dev
```

## 🐛 Found a Bug? Help Us Improve!

Your bug reports are incredibly valuable! Here's how to report issues effectively:

### Before Reporting

1. **Check existing issues**: Search [GitHub Issues](https://github.com/libre-webui/libre-webui/issues) to avoid duplicates
2. **Try the stable version**: Confirm the bug exists only in dev (not in main branch)
3. **Reproduce consistently**: Can you make the bug happen again?

### How to Report Bugs

[**🐛 Report a Bug on GitHub**](https://github.com/libre-webui/libre-webui/issues/new)

**Include this information:**

```markdown
**Environment:**
- Branch: dev
- Version: [git commit hash or date]
- OS: [Windows/macOS/Linux]
- Browser: [Chrome/Firefox/Safari version]
- Setup: [Docker/Source/etc.]

**Bug Description:**
Clear description of what went wrong

**Steps to Reproduce:**
1. Go to...
2. Click on...
3. See error...

**Expected Behavior:**
What should have happened

**Actual Behavior:**
What actually happened

**Screenshots/Logs:**
[If applicable, add screenshots or error logs]
```

### Get Your Git Commit Hash

```bash
# Find your current dev branch commit
git rev-parse HEAD

# Or get a short version
git rev-parse --short HEAD
```

## 🏆 Contributing & Recognition

Using the dev branch makes you part of our testing community! Contributors are recognized in several ways:

### Recognition for Contributors

- **Listed in [CONTRIBUTORS.md](https://github.com/libre-webui/libre-webui/blob/main/CONTRIBUTORS.md)**
- **Mentioned in release notes** for significant contributions
- **Co-author attribution** in commit messages
- **Special thanks** in project announcements

### Current Contributors

Our amazing community includes:

- **[rob](https://github.com/kroonen)** - Project Maintainer
- **[jm](https://github.com/jmoney7823956789378)** - Network Access Enhancement
- **And more contributors!** Check the [full list](https://github.com/libre-webui/libre-webui/blob/main/CONTRIBUTORS.md)

### Want to Contribute Code?

1. **Fork the repository**
2. **Create a feature branch from `dev`**: `git checkout -b feature/amazing-feature dev`
3. **Make your changes**
4. **Submit a Pull Request against the `dev` branch**

See our [Contributing Guidelines](https://github.com/libre-webui/libre-webui/blob/main/CONTRIBUTORS.md#contribution-guidelines) for detailed instructions and our [Community Charter](./CHARTER) for the project's ethical guidelines and governance model.

## ⚠️ Important Notes

### Data Safety

- **Backup your data** before switching to dev branch
- **Use a separate Docker volume** for dev testing:
  ```bash
  # Use different volume name for dev
  docker run -d -p 3000:8080 -v libre-webui-dev:/app/backend/data --name libre-webui-dev ghcr.io/libre-webui/libre-webui:dev
  ```

### Potential Issues

- **Breaking changes** may require configuration updates
- **Features may be incomplete** or change without notice
- **Performance** may vary as optimizations are tested
- **UI elements** might look different or behave unexpectedly

### When to Use Stable

Switch back to the stable `main` branch if you:
- Need reliability for important work
- Experience too many bugs
- Want a tested, stable experience

```bash
# Switch back to stable
git checkout main
docker-compose -f docker-compose.external-ollama.yml up -d --build
```

## 🌟 Join the Community

- **GitHub Discussions**: [Share ideas and ask questions](https://github.com/libre-webui/libre-webui/discussions)
- **Issues**: [Report bugs and request features](https://github.com/libre-webui/libre-webui/issues)
- **Contributors**: [See who's helping build Libre WebUI](https://github.com/libre-webui/libre-webui/blob/main/CONTRIBUTORS.md)

---

**Ready to help shape the future of Libre WebUI?** 🚀

Your testing, feedback, and contributions on the dev branch directly improve the experience for all users. Thank you for being part of our development community!
