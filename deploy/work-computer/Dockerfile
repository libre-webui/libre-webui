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
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY start-computer.sh /usr/local/bin/start-computer
RUN chmod +x /usr/local/bin/start-computer

# A presentable desktop instead of a bare X root: wallpaper, dock config,
# and a start page for the browser — static assets baked at build time so
# the runtime stays read-only. Drop a wallpaper.png beside this Dockerfile
# to ship your own (the [g] glob makes it optional); otherwise a gradient
# is generated.
COPY start-page.html tint2rc wallpaper.pn[g] /usr/local/share/libre-computer/
# The site's own typefaces (Space Grotesk / Manrope / DM Mono), self-hosted
# exactly like librewebui.org hosts them.
COPY fonts /usr/local/share/libre-computer/fonts
RUN [ -f /usr/local/share/libre-computer/wallpaper.png ] \
    || convert -size 1280x800 \
      gradient:'#141824'-'#2b3350' \
      -attenuate 0.15 +noise Gaussian \
      /usr/local/share/libre-computer/wallpaper.png
