# Pinned MimicWX-Linux image for the phase-1 real WeChat validation.
#
# Source:  https://github.com/wx-11/MimicWX-Linux
# Commit:  a42a3eec4e6efa2d023915e980e9af7d5fcf9439
# Client:  official Tencent WeChat Linux 4.1.13.26. The candidate's
#          extract_key.py is patched to locate setCipherKey by a byte-identical
#          function prologue; known offsets 4.1.0.16=0x6586C90,
#          4.1.13.26=0x87B3CF0.
#
# Build context is the repository root:
#   docker build -f deploy/image/Dockerfile -t wechat-bot-mimicwx:4.1.13.26 .
#
# Stage 1: build the Rust bridge binary.
FROM rust:1.85-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN sed -i 's@deb.debian.org@mirrors.aliyun.com@g; s@security.debian.org@mirrors.aliyun.com@g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    make pkg-config perl-modules-5.36 libtext-template-perl libxcb1-dev libxcb-xtest0-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
ENV CARGO_HOME=/build/.cargo
COPY deploy/image/cargo-config.toml /build/.cargo/config.toml
COPY sources/MimicWX-Linux/Cargo.toml sources/MimicWX-Linux/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && \
    cargo build --release 2>/dev/null || true && \
    rm -rf src target/release/mimicwx target/release/deps/mimicwx-*

COPY sources/MimicWX-Linux/src/ src/
RUN cargo build --release

# Stage 2: runtime desktop + official WeChat client.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Use a fast Ubuntu mirror. The base image has no CA bundle, so fetch
# ca-certificates over HTTP first, then switch the same mirror to HTTPS for the
# large package set.
RUN sed -i 's@http://archive.ubuntu.com/ubuntu@http://mirrors.aliyun.com/ubuntu@g; s@http://security.ubuntu.com/ubuntu@http://mirrors.aliyun.com/ubuntu@g' /etc/apt/sources.list
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN sed -i 's@http://mirrors.aliyun.com/ubuntu@https://mirrors.aliyun.com/ubuntu@g' /etc/apt/sources.list

ENV LANG=zh_CN.UTF-8
ENV LANGUAGE=zh_CN:zh
ENV LC_ALL=zh_CN.UTF-8
ENV TZ=Asia/Shanghai

RUN apt-get update && apt-get install -y --no-install-recommends \
    locales ca-certificates fonts-wqy-microhei fonts-wqy-zenhei \
    openbox xterm dbus-x11 dbus \
    tigervnc-standalone-server tigervnc-common \
    novnc websockify \
    at-spi2-core \
    xclip x11-utils x11-xserver-utils xdotool scrot \
    wget curl procps net-tools gpg \
    gdb python3 \
    libcap2-bin libatomic1 \
    libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Chinese locale + timezone.
RUN locale-gen zh_CN.UTF-8 && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# Runtime Qt/xcb dependencies used by the official Linux client.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxkbcommon-x11-0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 \
    libxcb-render-util0 libxcb-xinerama0 libxcb-shape0 libxcb-cursor0 \
    libxcb-xkb1 libxcb-randr0 libxcb-xfixes0 libxcb-sync1 libxcb-shm0 \
    libxcb-glx0 libxcb-dri2-0 libxcb-dri3-0 libxcb-present0 \
    libxcb-xinput0 libxcb-xtest0 libxshmfence1 \
    libxdamage1 libxcomposite1 libxrandr2 libxi6 libxtst6 \
    libsm6 libice6 libfontconfig1 libfreetype6 libx11-xcb1 \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libgbm1 libasound2 libpango-1.0-0 \
    libcairo2 libatspi2.0-0 libgtk-3-0 sqlcipher \
    && rm -rf /var/lib/apt/lists/*

# Official client, pinned by checksum. Install it AFTER the runtime library
# layer: its optional Noto CJK dependency is intentionally not installed, and
# an already-installed broken dependency would make apt refuse to resolve the
# runtime libraries.
COPY sources/artifacts/WeChatLinux_x86_64.deb /tmp/wechat.deb
RUN echo "a0db8caeee8d1e6cfe0aa5ce58710270f8d74a90ff4920f53a3fc22aa0956fe9  /tmp/wechat.deb" | sha256sum -c -
RUN dpkg -i --force-depends /tmp/wechat.deb
RUN rm -f /tmp/wechat.deb

# vncpasswd is in tigervnc-tools, not tigervnc-common. WeChat's unmet optional
# font dependency makes apt refuse this package, so install the small .deb
# directly with dpkg.
COPY sources/artifacts/tigervnc-tools_1.12.0+dfsg-4ubuntu0.22.04.1_amd64.deb /tmp/
RUN dpkg -i --force-depends /tmp/tigervnc-tools_1.12.0+dfsg-4ubuntu0.22.04.1_amd64.deb \
    && rm -f /tmp/tigervnc-tools_*.deb

# WeChat 4.1.13.26's embedded Chromium/Radium runtime dlopens EGL/GLES.
# apt is blocked by WeChat's intentionally-unmet Noto font dependency, so
# download the small runtime .debs and install them with dpkg.
RUN apt-get update \
    && cd /tmp \
    && apt-get download libegl1 libegl-mesa0 libgles2 libvulkan1 \
    && dpkg -i --force-depends /tmp/libegl1_*.deb /tmp/libegl-mesa0_*.deb /tmp/libgles2_*.deb /tmp/libvulkan1_*.deb \
    && rm -f /tmp/libegl1_*.deb /tmp/libegl-mesa0_*.deb /tmp/libgles2_*.deb /tmp/libvulkan1_*.deb \
    && rm -rf /var/lib/apt/lists/*

# Non-root desktop user. UID 1000 matches the project owner on the host, so
# bind-mounted persistent data remains accessible.
RUN useradd -m -s /bin/bash -u 1000 wechat

# Candidate binary.
COPY --from=builder /build/target/release/mimicwx /usr/local/bin/mimicwx
COPY --from=builder /build/target/release/wechat-ingest /usr/local/bin/wechat-ingest
RUN chmod +x /usr/local/bin/mimicwx /usr/local/bin/wechat-ingest && \
    setcap cap_sys_admin+ep /usr/local/bin/mimicwx

# Startup scripts / D-Bus policy.
COPY deploy/image/dbus-mimicwx.conf /etc/dbus-1/session.d/mimicwx.conf
COPY deploy/image/start.sh /usr/local/bin/start.sh
COPY deploy/image/gdb-watch.sh /usr/local/bin/gdb-watch.sh
COPY deploy/image/extract_key.py /usr/local/bin/extract_key.py
RUN sed -i 's/\r$//' /usr/local/bin/start.sh /usr/local/bin/gdb-watch.sh /usr/local/bin/extract_key.py && \
    chmod +x /usr/local/bin/start.sh /usr/local/bin/gdb-watch.sh /usr/local/bin/extract_key.py

USER root
WORKDIR /home/wechat

EXPOSE 5901 6080 8899

CMD ["/usr/local/bin/start.sh"]
