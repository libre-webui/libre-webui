# Libre WebUI Cask Formula
# Desktop application for Libre WebUI
#
# Installation:
#   brew tap libre-webui/tap
#   brew install --cask libre-webui
#
# Or install directly:
#   brew install --cask libre-webui/tap/libre-webui

cask "libre-webui" do
  version "0.3.2"
  sha256 "c9023ab5970ce47d96208769b6cf455b20c3deb7580ca9bd4a9006fb62809f52"

  url "https://github.com/libre-webui/libre-webui/releases/download/v#{version}/Libre.WebUI-#{version}-mac-arm64.dmg"

  # Note: Only ARM64 build available currently
  # on_intel support can be added when x64 builds are published

  name "Libre WebUI"
  desc "Privacy-first AI chat interface - Self-hosted, open source, extensible"
  homepage "https://librewebui.org"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :monterey"

  app "Libre WebUI.app"

  zap trash: [
    "~/Library/Application Support/libre-webui",
    "~/Library/Caches/libre-webui",
    "~/Library/Preferences/org.librewebui.app.plist",
    "~/Library/Saved Application State/org.librewebui.app.savedState",
    "~/.libre-webui",
  ]

  caveats <<~EOS
    Libre WebUI desktop app has been installed!

    For local LLM support, install and run Ollama:
      brew install ollama
      ollama serve

    For API providers, configure in the app settings or set:
      export OPENAI_API_KEY=your-key
      export ANTHROPIC_API_KEY=your-key

    CLI version also available:
      brew install libre-webui

    Documentation: https://docs.librewebui.org
  EOS
end
