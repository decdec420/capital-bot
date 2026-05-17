import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { ArrowLeft, Eye, EyeOff, Save, Zap } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface BotSettings {
  symbol: string;
  buy_amount_usd: number;
  rsi_buy_threshold: number;
  rsi_sell_threshold: number;
  enabled: boolean;
  live_trading: boolean;
  stop_loss_pct: number;
  take_profit_pct: number;
  trailing_stop_pct: number;
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-sm font-medium mb-1">{children}</label>;
}
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground mt-1">{children}</p>;
}
function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1">{children}</div>;
}

export default function Settings() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [form, setForm] = useState<BotSettings>({
    symbol: "BTC-USD", buy_amount_usd: 10, rsi_buy_threshold: 30,
    rsi_sell_threshold: 70, enabled: false, live_trading: false,
    stop_loss_pct: 5, take_profit_pct: 10, trailing_stop_pct: 3,
  });
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
    if (savedSettings) setForm(savedSettings as BotSettings);
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

      // Save or update the vault secret
      const { error: vaultErr } = await supabase.rpc("upsert_coinbase_pem", {
        p_secret_name: vaultSecretName,
        p_pem: privatePem.trim(),
      });
      if (vaultErr) throw new Error(`Vault error: ${vaultErr.message}`);

      // Save key name + vault reference
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

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-3 flex items-center gap-3">
        <Link to="/" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" /> Dashboard
        </Link>
        <span className="text-border">·</span>
        <span className="text-sm font-medium">Settings</span>
      </header>

      <main className="max-w-xl mx-auto px-6 py-8 space-y-10">

        {/* Bot controls */}
        <section className="space-y-5">
          <h2 className="text-base font-semibold">Bot controls</h2>

          <Field>
            <div className="flex items-center justify-between">
              <div>
                <Label>Bot enabled</Label>
                <Hint>When off, the cron runs but skips all actions.</Hint>
              </div>
              <button
                onClick={() => set("enabled")(!form.enabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.enabled ? "bg-primary" : "bg-muted"}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${form.enabled ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <div>
                <Label>Live trading</Label>
                <Hint>Off = paper mode (no real orders). Only enable after testing.</Hint>
              </div>
              <button
                onClick={() => {
                  if (!form.live_trading && !confirm("Enable LIVE trading? Real money will be used.")) return;
                  set("live_trading")(!form.live_trading);
                }}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.live_trading ? "bg-green-600" : "bg-muted"}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${form.live_trading ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
            {form.live_trading && (
              <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 mt-1">
                <Zap className="w-3 h-3" /> Live mode active — real orders will be placed
              </div>
            )}
          </Field>
        </section>

        {/* Strategy */}
        <section className="space-y-5">
          <h2 className="text-base font-semibold">Strategy</h2>

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
            <Hint>The asset the bot will trade.</Hint>
          </Field>

          <Field>
            <Label>Buy amount per trade (USD)</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <input
                type="number" min="1" max="10000" step="1"
                value={form.buy_amount_usd}
                onChange={(e) => set("buy_amount_usd")(Number(e.target.value))}
                className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <Hint>How much USD to spend per buy. Start small — $10–$50 is plenty to test.</Hint>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <Label>RSI buy threshold</Label>
              <span className="text-sm font-medium tabular-nums">{form.rsi_buy_threshold}</span>
            </div>
            <input
              type="range" min="10" max="45" step="1"
              value={form.rsi_buy_threshold}
              onChange={(e) => set("rsi_buy_threshold")(Number(e.target.value))}
              className="w-full"
            />
            <Hint>Buy when RSI drops below this value (oversold). Default 30 is conservative.</Hint>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <Label>RSI sell threshold</Label>
              <span className="text-sm font-medium tabular-nums">{form.rsi_sell_threshold}</span>
            </div>
            <input
              type="range" min="55" max="90" step="1"
              value={form.rsi_sell_threshold}
              onChange={(e) => set("rsi_sell_threshold")(Number(e.target.value))}
              className="w-full"
            />
            <Hint>Sell when RSI rises above this value (overbought). Default 70.</Hint>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <Label>Stop-loss %</Label>
              <span className="text-sm font-medium tabular-nums">{form.stop_loss_pct === 0 ? "Off" : `${form.stop_loss_pct}%`}</span>
            </div>
            <input
              type="range" min="0" max="20" step="0.5"
              value={form.stop_loss_pct}
              onChange={(e) => set("stop_loss_pct")(Number(e.target.value))}
              className="w-full"
            />
            <Hint>Close position if price drops this % below entry. 0 = disabled. Default 5%.</Hint>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <Label>Trailing stop %</Label>
              <span className="text-sm font-medium tabular-nums">{form.trailing_stop_pct === 0 ? "Off" : `${form.trailing_stop_pct}%`}</span>
            </div>
            <input
              type="range" min="0" max="15" step="0.5"
              value={form.trailing_stop_pct}
              onChange={(e) => set("trailing_stop_pct")(Number(e.target.value))}
              className="w-full"
            />
            <Hint>Sell if price drops this % below its peak since entry. Locks in gains on the way up. Default 3%.</Hint>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <Label>Take-profit %</Label>
              <span className="text-sm font-medium tabular-nums">{form.take_profit_pct === 0 ? "Off" : `${form.take_profit_pct}%`}</span>
            </div>
            <input
              type="range" min="0" max="50" step="0.5"
              value={form.take_profit_pct}
              onChange={(e) => set("take_profit_pct")(Number(e.target.value))}
              className="w-full"
            />
            <Hint>Close position if price rises this % above entry. 0 = disabled. Default 10%.</Hint>
          </Field>

          <div className="pt-1">
            <button
              onClick={() => saveSettings.mutate()}
              disabled={saveSettings.isPending}
              className="flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saveSettings.isPending ? "Saving…" : "Save settings"}
            </button>
          </div>
        </section>

        {/* Coinbase credentials */}
        <section className="space-y-5">
          <div>
            <h2 className="text-base font-semibold">Coinbase API credentials</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Create a CDP API key at <a href="https://portal.cdp.coinbase.com" target="_blank" rel="noreferrer" className="underline">portal.cdp.coinbase.com</a>. 
              Give it <strong>Trade</strong> permission only. The private key is stored encrypted in Supabase Vault.
            </p>
          </div>

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
              <button onClick={() => setShowPem(!showPem)} className="text-xs text-muted-foreground flex items-center gap-1">
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
            <Hint>Paste the full PEM including the BEGIN/END lines. Stored encrypted, never exposed to the browser again after saving.</Hint>
          </Field>

          <div className="flex items-center gap-2">
            <button
              onClick={testConnection}
              disabled={testingConn}
              className="h-9 px-4 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {testingConn ? "Testing…" : "Test connection"}
            </button>
            <button
              onClick={() => saveCredentials.mutate()}
              disabled={saveCredentials.isPending || !apiKeyName || !privatePem}
              className="flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saveCredentials.isPending ? "Saving…" : "Save credentials"}
            </button>
          </div>
        </section>

        <div className="border-t border-border pt-6 text-xs text-muted-foreground space-y-1">
          <p>• Bot checks RSI every 5 minutes via scheduled cron.</p>
          <p>• Only one position open at a time per account.</p>
          <p>• Paper mode simulates trades without touching real funds.</p>
          <p>• Run "Test connection" before enabling live trading.</p>
        </div>
      </main>
    </div>
  );
}
