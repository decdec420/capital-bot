# capital-bot worker — Runbook

## App details

- **Fly.io app**: `capital-bot-worker-black-moonrise-2383`
- **Region**: `iad` (Washington DC)
- **Machines**: 2 (HA, both always-on)

---

## Viewing logs

```bash
fly logs --app capital-bot-worker-black-moonrise-2383 --tail
```

## Health check

```bash
curl https://capital-bot-worker-black-moonrise-2383.fly.dev/health
```

Returns: `{ ok, uptime, users, openPositions, symbols: { BTC-USD: { rsi, price, candles } } }`

---

## Deploy

```bash
cd ~/Desktop/capital-bot
fly deploy -c worker/fly.toml --app capital-bot-worker-black-moonrise-2383
```

## Rollback to previous image

```bash
# 1. Find the previous deployment image SHA
fly releases --app capital-bot-worker-black-moonrise-2383

# 2. Roll back to it (copy the image ref from the output above)
fly deploy --app capital-bot-worker-black-moonrise-2383 \
  --image registry.fly.io/capital-bot-worker-black-moonrise-2383:<previous-version-tag>
```

### Rollback triggers

Roll back immediately if you see:

- Duplicate orders appearing in Coinbase or the `trades` table
- `[signal]` logs firing when the bot is disabled in Settings
- Worker crashing in a restart loop (`fly logs` shows repeated `=== capital-bot worker starting ===`)
- Telegram alerts stop arriving for >30 minutes during market hours

---

## Secrets

```bash
# View current secrets (names only, not values)
fly secrets list --app capital-bot-worker-black-moonrise-2383

# Update a secret
fly secrets set SECRET_NAME=value --app capital-bot-worker-black-moonrise-2383
```

Required secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

---

## Switch from paper → live trading

1. Verify paper trades look correct in the Dashboard for at least one full cycle
2. In the capital-bot web UI → Settings → toggle **Live Trading** on
3. Worker picks up the change within 15 seconds (settings refresh interval)
4. Watch `fly logs` for `LIVE BUY` / `LIVE SELL` confirmation on next signal
5. Verify the fill appears in Coinbase and in the `trades` table

## Emergency stop

Disable the bot instantly from the UI (Settings → toggle **Enabled** off).  
The worker respects the flag within one candle close (≤5 min) and within 15s of the settings refresh.

For immediate kill: `fly machine stop <machine-id> --app capital-bot-worker-black-moonrise-2383`
