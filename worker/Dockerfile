FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies first (only re-runs when src changes)
COPY src/ ./src/
RUN deno cache ./src/worker.ts

# Copy remaining files
COPY deno.json ./

# /data is the Fly Volume mount point for candle persistence.
# mkdir -p ensures the container starts cleanly even without a volume.
RUN mkdir -p /data

# Fly.io expects the process to bind to 0.0.0.0:8080
EXPOSE 8080

CMD ["deno", "run", \
  "--allow-net", \
  "--allow-env", \
  "--allow-read", \
  "--allow-write=/data", \
  "./src/worker.ts"]
