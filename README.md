# capital-bot

A minimal autonomous crypto trading bot. Buys BTC-USD when RSI dips below a threshold, sells when it recovers. No AI. No personas. No doctrine system.

## How it works

1. `signal-tick` runs every 5 minutes via pg_cron
2. Fetches the last 30 hourly candles from Coinbase
3. Computes RSI(14) on close prices
4. **RSI < 30 + no open position** → market buy (your configured USD amount)
5. **RSI > 70 + open position** → market sell
6. Otherwise → hold, log, exit

## Setup

### 1. Supabase project
Create a new project at supabase.com. Copy the project ref, URL, and anon key.

### 2. Apply migration
```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

### 3. Deploy edge functions
```bash
supabase functions deploy signal-tick
supabase functions deploy trade-close
supabase functions deploy position-sync
```

### 4. Set edge function secrets
In Supabase dashboard → Edge Functions → Manage secrets:
```
SIGNAL_TICK_CRON_TOKEN   = <generate a random UUID>
POSITION_SYNC_CRON_TOKEN = <generate a random UUID>
```

### 5. Enable cron jobs
In Supabase SQL editor, uncomment and run the cron.schedule() blocks
at the bottom of the migration file. Replace `<PROJECT_REF>` and the
token placeholders with your actual values.

### 6. Frontend
```bash
cp .env.example .env
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

### 7. Add Coinbase credentials
1. Go to Settings in the app
2. Create a CDP API key at portal.cdp.coinbase.com (Trade permission only)
3. Paste the API key name and private key PEM
4. Click "Test connection" — should say success
5. Click "Save credentials"

### 8. Start in paper mode
- Keep Live trading OFF
- Enable the bot
- Watch the tick log for a few days
- Once you're satisfied, enable Live trading

## Edge functions

| Function | Purpose | Trigger |
|---|---|---|
| `signal-tick` | Core bot loop — RSI → buy/sell | cron every 5 min + manual |
| `trade-close` | Manual position close from dashboard | user action |
| `position-sync` | Updates unrealized P&L on open trades | cron every hour |

## Database tables

| Table | Purpose |
|---|---|
| `settings` | Bot config per user (thresholds, amount, enabled) |
| `broker_credentials` | Coinbase key name + vault reference |
| `trades` | All buy/sell records |
| `tick_log` | Audit log of every bot decision |

## What was removed from capital-calm-ai
- All 9 Billions character agents (Bobby, Chuck, Hall, Jessica, Katrina, etc.)
- The doctrine / guardrail / regime system
- Market intelligence (fired every 1 min)
- AI calls on every tick (claude-sonnet-4-6 via Lovable gateway)
- Strategy lab, backtesting, experiments
- 10 of 13 frontend pages
- 20 of 24 cron schedules
- The signal FSM lifecycle layers
- ~48,000 lines of code
