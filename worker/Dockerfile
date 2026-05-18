FROM denoland/deno:2.3.3

WORKDIR /app/worker

# Cache dependencies first (only re-runs when worker or shared decision logic changes)
COPY worker/src/ ./src/
COPY supabase/functions/_shared/decision.ts ../supabase/functions/_shared/decision.ts
RUN deno cache ./src/worker.ts

# Copy remaining files
COPY worker/deno.json ./

# Fly.io expects the process to bind to 0.0.0.0:8080
EXPOSE 8080

CMD ["deno", "run", \
  "--allow-net", \
  "--allow-env", \
  "--allow-read", \
  "./src/worker.ts"]
