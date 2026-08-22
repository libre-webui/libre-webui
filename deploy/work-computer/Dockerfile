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
      dbus-x11 \
      fonts-dejavu-core \
      fonts-noto-color-emoji \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY start-computer.sh /usr/local/bin/start-computer
RUN chmod +x /usr/local/bin/start-computer
