FROM denoland/deno:latest

WORKDIR /app

# Copy source code
COPY *.ts ./

# Create directories for outputs
RUN mkdir -p screenshots changes

# Set environment variables
ENV BROWSERLESS_URL=ws://browserless:3000
ENV BROWSERLESS_TOKEN=6R0W53R135510
ENV SITEMAP_URL=https://zu.com/sitemap-0.xml
ENV CONCURRENT=10

ENV DENO_PERMISSIONS="--allow-read --allow-env --allow-sys --allow-ffi --allow-write --allow-run --allow-net"

ENTRYPOINT ["deno", "run", "--allow-read", "--allow-env", "--allow-sys", "--allow-ffi", "--allow-write", "--allow-run", "--allow-net", "compare-prod-and-preview.ts"]