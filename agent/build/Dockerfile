ARG ALPINE_IMAGE
FROM ${ALPINE_IMAGE}

ARG RUSTUP_VERSION
ARG RUSTUP_SHA256
ARG RUST_CHANNEL
ARG RUST_TARGET

ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH=/usr/local/cargo/bin:$PATH
ENV RUSTUP_TOOLCHAIN=${RUST_CHANNEL}

RUN apk add --no-cache ca-certificates curl libgcc musl-dev \
 && arch=$(uname -m) \
 && curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${arch}-unknown-linux-musl/rustup-init" \
 && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && CARGO_HOME=/usr/local/cargo /tmp/rustup-init -y --no-modify-path --profile minimal \
      --default-toolchain none \
 && CARGO_HOME=/usr/local/cargo rustup toolchain install "${RUST_CHANNEL}" --profile minimal \
      --target "${RUST_TARGET}" \
 && ln -s libgcc_s.so.1 /usr/lib/libgcc_s.so \
 && rm /tmp/rustup-init \
 && chmod -R a+rX /usr/local/rustup /usr/local/cargo
