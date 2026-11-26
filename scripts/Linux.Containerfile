ARG BASE_IMAGE=node:24-bookworm
FROM ${BASE_IMAGE}

ARG NODE_VERSION=24.15.0
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 update \
    && apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
        patchelf cmake build-essential pkg-config file dbus-x11 xvfb xauth xdotool fonts-noto-cjk \
        ca-certificates curl xz-utils appstream gpg squashfs-tools desktop-file-utils zsync \
    && rm -rf /var/lib/apt/lists/*

# 使用已有的 Debian 基础镜像时，安装与前端声明一致的 Node.js。
RUN if ! command -v node >/dev/null; then \
      case "$(dpkg --print-architecture)" in arm64) node_arch=arm64;; amd64) node_arch=x64;; *) exit 1;; esac \
      && pkg="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      && cd /tmp \
      && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${pkg}" \
      && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
      && awk -v pkg="$pkg" '$2 == pkg' SHASUMS256.txt | sha256sum -c - \
      && tar -xJf "$pkg" --strip-components=1 -C /usr/local \
      && rm "$pkg" SHASUMS256.txt; \
    fi
RUN npm install -g pnpm@10.33.3 \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /workspace
