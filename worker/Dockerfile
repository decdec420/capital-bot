FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies first (only re-runs when src changes)
COPY src/ ./src/
RUN deno cache ./src/worker.ts

# Copy remaining files
COPY deno.json ./

# Fly.io expects the process to bind to 0.0.0.0:8080
EXPOSE 8080

CMD ["deno", "run", \
  "--allow-net", \
  "--allow-env", \
  "--allow-read", \
  "./src/worker.ts"]
