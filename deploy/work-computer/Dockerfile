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
      fluxbox \
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
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY start-computer.sh /usr/local/bin/start-computer
RUN chmod +x /usr/local/bin/start-computer

# A presentable desktop instead of a bare X root: a generated wallpaper and
# a minimal start page for the browser. Both are static assets baked at
# build time so the runtime stays read-only. fbsetbg becomes a no-op: this
# minimal install has no image backend for it, and every invocation (from
# fluxbox's default styles) would otherwise pop a permanent xmessage error
# dialog on the agent's screen.
COPY start-page.html /usr/local/share/libre-computer/start-page.html
RUN mkdir -p /usr/local/share/libre-computer \
    && convert -size 1280x800 \
      gradient:'#141824'-'#2b3350' \
      -attenuate 0.15 +noise Gaussian \
      /usr/local/share/libre-computer/wallpaper.png \
    && printf '#!/bin/sh\nexit 0\n' > /usr/bin/fbsetbg \
    && chmod +x /usr/bin/fbsetbg
