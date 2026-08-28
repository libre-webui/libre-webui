# Libre Work Computer — GUI-capable Work sandbox.
#
# Layers a virtual desktop (Xvfb + fluxbox), Chromium, and a localhost-only
# VNC-to-WebSocket bridge over the standard Work image. xdotool and
# imagemagick ship now so later phases (agent control, teach mode) need no
# image change. Adds ~650 MB over the base image.
ARG WORK_BASE_IMAGE
FROM ${WORK_BASE_IMAGE}

USER root

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb \
      openbox \
      tint2 \
      lxterminal \
      adwaita-icon-theme \
      x11vnc \
      websockify \
      chromium \
      xdotool \
      imagemagick \
      x11-utils \
      pulseaudio \
      pulseaudio-utils \
      socat \
      dbus-x11 \
      fonts-dejavu-core \
      fonts-noto-color-emoji \
      ca-certificates \
      curl \
      unzip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ads and cookie banners waste the agent's screenshots, tokens, and clicks,
# so the browser ships with content blocking baked in: uBlock Origin Lite
# (ads/trackers, zero-config MV3) and "I still don't care about cookies"
# (consent-banner auto-dismissal). Versions are pinned and checksum-verified;
# bump both together when refreshing the image.
ARG UBOL_VERSION=2026.820.1159
ARG UBOL_SHA256=45642289ed7c2c46dc8a3a20e801e452a1d180a9718be9a1074021d3d5b94205
ARG ISDCAC_VERSION=v1.1.9
ARG ISDCAC_SHA256=8f70ab947cb2d274f4022a970f5dd3cecd8ec02b060e05187bef9ee3cb18bbcb
RUN set -eu; \
    mkdir -p /usr/local/share/libre-computer/extensions; \
    curl -fsSL -o /tmp/ubol.zip \
      "https://github.com/uBlockOrigin/uBOL-home/releases/download/${UBOL_VERSION}/uBOLite_${UBOL_VERSION}.chromium.zip"; \
    echo "${UBOL_SHA256}  /tmp/ubol.zip" | sha256sum -c -; \
    unzip -q /tmp/ubol.zip -d /usr/local/share/libre-computer/extensions/ubol; \
    curl -fsSL -o /tmp/isdcac.zip \
      "https://github.com/OhMyGuus/I-Still-Dont-Care-About-Cookies/releases/download/${ISDCAC_VERSION}/ISDCAC-chrome-source.zip"; \
    echo "${ISDCAC_SHA256}  /tmp/isdcac.zip" | sha256sum -c -; \
    unzip -q /tmp/isdcac.zip -d /usr/local/share/libre-computer/extensions/isdcac; \
    test -f /usr/local/share/libre-computer/extensions/ubol/manifest.json; \
    test -f /usr/local/share/libre-computer/extensions/isdcac/manifest.json; \
    rm -f /tmp/ubol.zip /tmp/isdcac.zip

# Pin the blocker's filtering mode through Chromium's managed policy so
# every session filters deterministically (no first-run choice). The
# extension id is stable: unpacked ids derive from the load path, and the
# session always loads from $STATE_DIR/extensions (default /tmp/libre-computer).
RUN mkdir -p /etc/chromium/policies/managed && \
    printf '%s\n' \
      '{' \
      '  "3rdparty": {' \
      '    "extensions": {' \
      '      "albnihhfmkaodpabmkgnaccipdaecnpe": {' \
      '        "defaultFiltering": "optimal",' \
      '        "disableFirstRunPage": true,' \
      '        "showBlockedCount": false' \
      '      }' \
      '    }' \
      '  }' \
      '}' > /etc/chromium/policies/managed/libre-content-blockers.json

COPY start-computer.sh /usr/local/bin/start-computer
RUN chmod +x /usr/local/bin/start-computer

# A presentable desktop instead of a bare X root: wallpaper, dock config,
# and a start page for the browser — static assets baked at build time so
# the runtime stays read-only. Drop a wallpaper.png beside this Dockerfile
# to ship your own (the [g] glob makes it optional); otherwise a gradient
# is generated.
COPY start-page.html valley-scene.js three.min.js tint2rc wallpaper.pn[g] /usr/local/share/libre-computer/
# The site's own typefaces (Space Grotesk / Manrope / DM Mono), self-hosted
# exactly like librewebui.org hosts them.
COPY fonts /usr/local/share/libre-computer/fonts
RUN [ -f /usr/local/share/libre-computer/wallpaper.png ] \
    || convert -size 1280x800 \
      gradient:'#141824'-'#2b3350' \
      -attenuate 0.15 +noise Gaussian \
      /usr/local/share/libre-computer/wallpaper.png
