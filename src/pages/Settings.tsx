import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { ArrowLeft, Eye, EyeOff, Save, Zap, Shield, TrendingUp, LogOut, Sliders, RefreshCw } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface BotSettings {
  symbol: string;
  buy_amount_usd: number;
  entry_score_threshold: number;
  rsi_buy_threshold: number;
  rsi_sell_threshold: number;
  enabled: boolean;
  live_trading: boolean;
  stop_loss_pct: number;
  take_profit_pct: number;
  trailing_stop_pct: number;
  daily_loss_limit_usd: number;
  max_drawdown_pct: number;
  max_spread_pct: number;
  max_volatility_pct: number;
  compound_mode: boolean;
  paper_balance_usd: number;
  paper_starting_balance_usd: number;
}

const DEFAULT_BOT_SETTINGS: BotSettings = {
  symbol: "BTC-USD",
  buy_amount_usd: 10,
  entry_score_threshold: 65,
  rsi_buy_threshold: 40,
  rsi_sell_threshold: 60,
  enabled: false,
  live_trading: false,
  stop_loss_pct: 2,
  take_profit_pct: 5,
  trailing_stop_pct: 1.5,
  daily_loss_limit_usd: 25,
  max_drawdown_pct: 10,
  max_spread_pct: 0.25,
  max_volatility_pct: 3,
  compound_mode: false,
  paper_balance_usd: 20,
  paper_starting_balance_usd: 20,
};

const PRESETS = {
  loose: {
    label: "Loose",
    description: "More trades, good for validation",
    values: {
      rsi_buy_threshold: 38,
      entry_score_threshold: 30,
      stop_loss_pct: 3,
      take_profit_pct: 2,
      trailing_stop_pct: 1.5,
      max_volatility_pct: 5,
      max_spread_pct: 0.5,
    },
  },
  balanced: {
    label: "Balanced",
    description: "Moderate frequency, quality entries",
    values: {
      rsi_buy_threshold: 32,
      entry_score_threshold: 55,
      stop_loss_pct: 2.5,
      take_profit_pct: 4,
      trailing_stop_pct: 2,
      max_volatility_pct: 3,
      max_spread_pct: 0.25,
    },
  },
  strict: {
    label: "Strict",
    description: "Fewer, higher-conviction trades",
    values: {
      rsi_buy_threshold: 25,
      entry_score_threshold: 70,
      stop_loss_pct: 2,
      take_profit_pct: 6,
      trailing_stop_pct: 2.5,
      max_volatility_pct: 2,
      max_spread_pct: 0.15,
    },
  },
} as const;

function SectionCard({ icon, title, description, children }: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
      </div>
      <div className="space-y-5">
        {children}
      </div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-sm font-medium">{children}</label>;
}
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground mt-1">{children}</p>;
}
function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function SliderField({
  label, hint, value, min, max, step, format, onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-sm font-semibold tabular-nums text-foreground">{format(value)}</span>
      </div>
      <div className="relative">
        <input
          type="range" min={min} max={max} step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-primary"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
          <span>{format(min)}</span>
          <span>{format(max)}</span>
        </div>
      </div>
      <Hint>{hint}</Hint>
    </Field>
  );
}

function Toggle({ checked, onChange, danger }: { checked: boolean; onChange: (v: boolean) => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? (danger ? "bg-red-600" : "bg-primary") : "bg-muted"
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [form, setForm] = useState<BotSettings>(DEFAULT_BOT_SETTINGS);
  const [apiKeyName, setApiKeyName] = useState("");
  const [privatePem, setPrivatePem] = useState("");
  const [showPem, setShowPem] = useState(false);
  const [testingConn, setTestingConn] = useState(false);

  const { data: savedSettings } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data } = await supabase.from("settings").select("*").eq("user_id", user!.id).maybeSingle();
      return data;
    },
    enabled: !!user,
  });

  const { data: savedCreds } = useQuery({
    queryKey: ["broker-credentials"],
    queryFn: async () => {
      const { data } = await supabase.from("broker_credentials").select("api_key_name").eq("user_id", user!.id).maybeSingle();
      return data;
    },
    enabled: !!user,
  });

  useEffect(() => {
    if (savedSettings) setForm({ ...DEFAULT_BOT_SETTINGS, ...savedSettings } as BotSettings);
  }, [savedSettings]);

  useEffect(() => {
    if (savedCreds?.api_key_name) setApiKeyName(savedCreds.api_key_name);
  }, [savedCreds]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("settings").upsert({
        user_id: user!.id, ...form, updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Settings saved"); qc.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const saveCredentials = useMutation({
    mutationFn: async () => {
      if (!apiKeyName.trim()) throw new Error("API key name is required");
      const vaultSecretName = `coinbase_pem_${user!.id}`;
      const { error: vaultErr } = await supabase.rpc("upsert_coinbase_pem", {
        p_secret_name: vaultSecretName,
        p_pem: privatePem.trim(),
      });
      if (vaultErr) throw new Error(`Vault error: ${vaultErr.message}`);
      const { error } = await supabase.from("broker_credentials").upsert({
        user_id: user!.id,
        api_key_name: apiKeyName.trim(),
        vault_secret_name: vaultSecretName,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Coinbase credentials saved"); qc.invalidateQueries({ queryKey: ["broker-credentials"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to save credentials"),
  });

  async function testConnection() {
    if (!apiKeyName || !privatePem) { toast.error("Enter API key name and private key first"); return; }
    setTestingConn(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("Session expired — please log in again"); return; }
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const r = await fetch(`${SUPABASE_URL}/functions/v1/broker-connection`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", apiKeyName, privatePem }),
      });
      const json = await r.json();
      if (json.ok) toast.success("Coinbase connection successful");
      else toast.error(`Connection failed: ${json.error}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTestingConn(false);
    }
  }

  const set = (k: keyof BotSettings) => (v: BotSettings[keyof BotSettings]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  function applyPreset(key: keyof typeof PRESETS) {
    setForm((prev) => ({ ...prev, ...PRESETS[key].values }));
    toast.success(`${PRESETS[key].label} preset applied — save to confirm`);
  }

  const pct = (v: number) => v === 0 ? "Off" : `${v}%`;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur px-6 py-3 flex items-center gap-3">
        <Link to="/" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" /> Dashboard
        </Link>
        <span className="text-border">·</span>
        <span className="text-sm font-medium">Settings</span>
      </header>

      <main className="max-w-xl mx-auto px-4 py-8 space-y-4">

        {/* Presets */}
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Quick presets</p>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((key) => (
              <button
                key={key}
                onClick={() => applyPreset(key)}
                className="rounded-lg border border-border p-3 text-left hover:bg-muted/60 transition-colors"
              >
                <p className="text-sm font-medium">{PRESETS[key].label}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{PRESETS[key].description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Bot Controls */}
        <SectionCard icon={<Zap className="w-4 h-4" />} title="Bot controls">
          <Field>
            <div className="flex items-center justify-between">
              <div>
                <Label>Bot enabled</Label>
                <Hint>When off, the worker runs but skips all trade actions.</Hint>
              </div>
              <Toggle checked={form.enabled} onChange={(v) => set("enabled")(v)} />
            </div>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <div>
                <Label>Live trading</Label>
                <Hint>Off = paper mode (no real orders). Only enable after testing.</Hint>
              </div>
              <Toggle
                checked={form.live_trading}
                danger
                onChange={(v) => {
                  if (v && !confirm("Enable LIVE trading? Real money will be used.")) return;
                  set("live_trading")(v);
                }}
              />
            </div>
            {form.live_trading && (
              <div className="flex items-center gap-1.5 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-md px-2.5 py-1.5">
                <Zap className="w-3 h-3 shrink-0" /> Live mode — real orders will be placed on Coinbase
              </div>
            )}
          </Field>
        </SectionCard>

        {/* Strategy */}
        <SectionCard
          icon={<TrendingUp className="w-4 h-4" />}
          title="Strategy"
          description="What to trade and how much to commit per position."
        >
          <Field>
            <Label>Asset</Label>
            <select
              value={form.symbol}
              onChange={(e) => set("symbol")(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="BTC-USD">BTC-USD — Bitcoin</option>
              <option value="ETH-USD">ETH-USD — Ethereum</option>
            </select>
          </Field>

          <Field>
            <Label>Buy amount per trade</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <input
                type="number" min="1" max="10000" step="1"
                value={form.buy_amount_usd}
                onChange={(e) => set("buy_amount_usd")(Number(e.target.value))}
                className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <Hint>How much USD to spend per buy. $10–$50 is plenty while testing.</Hint>
          </Field>
        </SectionCard>

        {/* Entry Conditions */}
        <SectionCard
          icon={<Sliders className="w-4 h-4" />}
          title="Entry conditions"
          description="Controls when the bot considers opening a position."
        >
          <SliderField
            label="RSI buy threshold"
            hint="Bot only considers buying when RSI drops below this level. 38 = normal dips, 25 = near-crash only."
            value={form.rsi_buy_threshold}
            min={20} max={50} step={1}
            format={(v) => `RSI < ${v}`}
            onChange={(v) => set("rsi_buy_threshold")(v)}
          />

          <SliderField
            label="Minimum setup quality"
            hint="Multi-factor score gate (RSI depth, trend, volume, support). Higher = fewer, better-conviction entries."
            value={form.entry_score_threshold}
            min={0} max={100} step={5}
            format={(v) => `${v}%`}
            onChange={(v) => set("entry_score_threshold")(v)}
          />

          <SliderField
            label="RSI sell threshold"
            hint="Sell signal fires when RSI rises above this after a buy. Higher = holds longer for bigger moves. Checked on every price tick so it exits promptly."
            value={form.rsi_sell_threshold}
            min={50} max={85} step={1}
            format={(v) => `RSI > ${v}`}
            onChange={(v) => set("rsi_sell_threshold")(v)}
          />
        </SectionCard>

        {/* Exit Strategy */}
        <SectionCard
          icon={<LogOut className="w-4 h-4" />}
          title="Exit strategy"
          description="How the bot closes positions. At least one should be non-zero."
        >
          <SliderField
            label="Stop-loss"
            hint="Hard exit if price falls this % below entry. Cuts losers fast. 0 = disabled."
            value={form.stop_loss_pct}
            min={0} max={10} step={0.5}
            format={pct}
            onChange={(v) => set("stop_loss_pct")(v)}
          />

          <SliderField
            label="Trailing stop"
            hint="Sell if price drops this % from its peak since entry. Locks in gains as price rises. 0 = disabled."
            value={form.trailing_stop_pct}
            min={0} max={10} step={0.5}
            format={pct}
            onChange={(v) => set("trailing_stop_pct")(v)}
          />

          <SliderField
            label="Take-profit"
            hint="Hard exit once up this % from entry. 0 = rely on RSI signal or trailing stop only."
            value={form.take_profit_pct}
            min={0} max={20} step={0.5}
            format={pct}
            onChange={(v) => set("take_profit_pct")(v)}
          />
        </SectionCard>

        {/* Compound Mode */}
        <SectionCard
          icon={<RefreshCw className="w-4 h-4" />}
          title="Compound mode"
          description="Reinvest gains automatically — position size grows with your balance over time."
        >
          <Field>
            <div className="flex items-center justify-between">
              <div>
                <Label>Compound mode</Label>
                <Hint>When on, ignores the fixed buy amount and sizes each trade as a % of current balance.</Hint>
              </div>
              <Toggle checked={form.compound_mode} onChange={(v) => set("compound_mode")(v)} />
            </div>
          </Field>

          {form.compound_mode && (
            <>
              <Field>
                <Label>Starting balance (paper mode)</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <input
                    type="number" min="1" max="100000" step="1"
                    value={form.paper_starting_balance_usd}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      set("paper_starting_balance_usd")(v);
                    }}
                    className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <Hint>Your seed capital. The bot compounds from this amount.</Hint>
              </Field>

              <Field>
                <div className="flex items-center justify-between">
                  <Label>Current paper balance</Label>
                  <span className="text-sm font-semibold tabular-nums">${form.paper_balance_usd.toFixed(2)}</span>
                </div>
                <Hint>Running balance updated after each simulated trade. Reset by setting it back to your starting balance.</Hint>
                <button
                  type="button"
                  onClick={() => set("paper_balance_usd")(form.paper_starting_balance_usd)}
                  className="mt-1 text-xs text-muted-foreground hover:text-foreground underline"
                >
                  Reset to starting balance
                </button>
              </Field>

              <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Position sizing tiers</p>
                <p>Under $100 → deploy <strong>90%</strong> per trade</p>
                <p>$100 – $500 → deploy <strong>80%</strong> per trade</p>
                <p>$500 – $1,000 → deploy <strong>70%</strong> per trade</p>
                <p>Over $1,000 → deploy <strong>50%</strong> per trade</p>
              </div>
            </>
          )}
        </SectionCard>

        {/* Risk Gates */}
        <SectionCard
          icon={<Shield className="w-4 h-4" />}
          title="Risk gates"
          description="Hard limits that block new entries when market or account conditions are unsafe."
        >
          <Field>
            <Label>Daily loss limit</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <input
                type="number" min="0" max="1000" step="5"
                value={form.daily_loss_limit_usd}
                onChange={(e) => set("daily_loss_limit_usd")(Number(e.target.value))}
                className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <Hint>No new buys if closed-trade losses today exceed this amount. Resets at midnight UTC.</Hint>
          </Field>

          <SliderField
            label="Max portfolio drawdown"
            hint="Blocks new entries if total closed-trade losses exceed this % of peak value. Protects against runaway losses."
            value={form.max_drawdown_pct}
            min={1} max={30} step={0.5}
            format={pct}
            onChange={(v) => set("max_drawdown_pct")(v)}
          />

          <SliderField
            label="Max bid/ask spread"
            hint="Skips entry if the live Coinbase spread exceeds this %. High spreads mean poor fill quality."
            value={form.max_spread_pct}
            min={0.05} max={1} step={0.05}
            format={pct}
            onChange={(v) => set("max_spread_pct")(v)}
          />

          <SliderField
            label="Max candle volatility"
            hint="Blocks entry if the latest candle range exceeds this % of price. Avoids buying into erratic price spikes."
            value={form.max_volatility_pct}
            min={0.5} max={10} step={0.25}
            format={pct}
            onChange={(v) => set("max_volatility_pct")(v)}
          />
        </SectionCard>

        {/* Save */}
        <button
          onClick={() => saveSettings.mutate()}
          disabled={saveSettings.isPending}
          className="w-full flex items-center justify-center gap-2 h-10 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <Save className="w-4 h-4" />
          {saveSettings.isPending ? "Saving…" : "Save settings"}
        </button>

        {/* Coinbase credentials */}
        <SectionCard
          icon={<Shield className="w-4 h-4" />}
          title="Coinbase API credentials"
          description={`Create a CDP API key at portal.cdp.coinbase.com — Trade permission only. Stored encrypted in Supabase Vault.`}
        >
          <Field>
            <Label>API key name</Label>
            <input
              type="text"
              value={apiKeyName}
              onChange={(e) => setApiKeyName(e.target.value)}
              placeholder="organizations/.../apiKeys/..."
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
            />
            <Hint>The "Key Name" shown in the Coinbase CDP portal.</Hint>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <Label>Private key (PEM)</Label>
              <button type="button" onClick={() => setShowPem(!showPem)} className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground transition-colors">
                {showPem ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {showPem ? "Hide" : "Show"}
              </button>
            </div>
            <textarea
              rows={showPem ? 6 : 2}
              value={privatePem}
              onChange={(e) => setPrivatePem(e.target.value)}
              placeholder="-----BEGIN PRIVATE KEY-----&#10;..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-ring resize-none"
            />
            <Hint>Paste the full PEM including BEGIN/END lines. Never exposed to the browser again after saving.</Hint>
          </Field>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={testConnection}
              disabled={testingConn}
              className="h-9 px-4 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {testingConn ? "Testing…" : "Test connection"}
            </button>
            <button
              type="button"
              onClick={() => saveCredentials.mutate()}
              disabled={saveCredentials.isPending || !apiKeyName || !privatePem}
              className="flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saveCredentials.isPending ? "Saving…" : "Save credentials"}
            </button>
          </div>
        </SectionCard>

        <div className="pb-8" />
      </main>
    </div>
  );
}
