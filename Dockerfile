# syntax=docker/dockerfile:1
#
# UploadMyShit's signaling server. The page is compiled into the binary, so the image is
# the binary and nothing else.
#
#   docker build -t uploadmyshit .
#   docker run -p 8080:8080 uploadmyshit
#
# It needs no volume and no state: rooms live in memory, and files go browser to browser.

# ---------------------------------------------------------------- build
FROM rust:1.98-bookworm AS build
WORKDIR /src
# The whole repository, `.git` included: build.rs stamps the binary with the commit git
# reports, so a build without it says `unknown`. CI may also pass the commit explicitly.
COPY . .
ARG UMS_BUILD_SHA=""
ENV UMS_BUILD_SHA=${UMS_BUILD_SHA}
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked \
 && install -D target/release/uploadmyshit /out/uploadmyshit

# ---------------------------------------------------------------- runtime
# glibc, libgcc and CA certificates (for the Cloudflare TURN API), and nothing else: no
# shell, no package manager. `nonroot` is uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/uploadmyshit /usr/local/bin/uploadmyshit
ENV UMS_BIND=0.0.0.0:8080 \
    UMS_LOG_FORMAT=json
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/uploadmyshit"]
