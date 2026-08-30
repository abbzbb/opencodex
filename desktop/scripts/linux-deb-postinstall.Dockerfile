FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      dbus-x11 \
      libayatana-appindicator3-1 \
      libgtk-3-0 \
      libwebkit2gtk-4.1-0 \
      procps \
      util-linux \
      xauth \
      xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/sh probe \
    && install -d -m 0700 -o probe -g probe \
      /home/probe/codex \
      /home/probe/opencodex \
      /home/probe/tmp \
      /home/probe/xdg-cache \
      /home/probe/xdg-config \
      /home/probe/xdg-data \
      /home/probe/xdg-runtime \
      /home/probe/xdg-state \
    && install -d -m 0700 /probe

COPY probe-linux-deb-postinstall-container.ts /usr/local/lib/ocx-linux-deb-postinstall.ts
COPY probe-linux-deb-postinstall-entrypoint.sh /usr/local/bin/ocx-linux-deb-postinstall

RUN chmod 0555 /usr/local/bin/ocx-linux-deb-postinstall \
    && chmod 0444 /usr/local/lib/ocx-linux-deb-postinstall.ts

ENTRYPOINT ["/usr/local/bin/ocx-linux-deb-postinstall"]
