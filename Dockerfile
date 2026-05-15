FROM rust:1.86-bookworm AS rust-builder

WORKDIR /app

COPY apps/rust-server ./apps/rust-server
RUN cargo build --release --manifest-path apps/rust-server/Cargo.toml

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=rust-builder /app/apps/rust-server/target/release/rlobs-rust-server /usr/local/bin/rlobs-rust-server

EXPOSE 8000
VOLUME ["/data/artifacts"]

ENV RLOBS_BIND_ADDR=0.0.0.0:8000
ENV RLOBS_AUTH_MODE=local
ENV RLOBS_ARTIFACT_ROOT=/data/artifacts
ENV RLOBS_LOG_FORMAT=json

CMD ["rlobs-rust-server", "serve"]
