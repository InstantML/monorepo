FROM rust:1.86-bookworm AS rust-builder

WORKDIR /app

COPY apps/rust-server ./apps/rust-server
RUN cargo build --release --manifest-path apps/rust-server/Cargo.toml

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=rust-builder /app/apps/rust-server/target/release/instantml-rust-server /usr/local/bin/instantml-rust-server

EXPOSE 8000
VOLUME ["/data/artifacts"]

ENV INSTANTML_BIND_ADDR=0.0.0.0:8000
ENV INSTANTML_AUTH_MODE=local
ENV INSTANTML_SERVICE_PLANE=combined
ENV INSTANTML_HOSTED_CLICKHOUSE_ENABLED=false
ENV INSTANTML_ARTIFACT_ROOT=/data/artifacts
ENV INSTANTML_LOG_FORMAT=json

CMD ["instantml-rust-server", "serve"]
