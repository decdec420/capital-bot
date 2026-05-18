export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      broker_credentials: {
        Row: {
          id: string;
          user_id: string;
          api_key_name: string;
          vault_secret_name: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          api_key_name: string;
          vault_secret_name: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          api_key_name?: string;
          vault_secret_name?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      settings: {
        Row: {
          id: string;
          user_id: string;
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
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          symbol?: string;
          buy_amount_usd?: number;
          entry_score_threshold?: number;
          rsi_buy_threshold?: number;
          rsi_sell_threshold?: number;
          enabled?: boolean;
          live_trading?: boolean;
          stop_loss_pct?: number;
          take_profit_pct?: number;
          trailing_stop_pct?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          symbol?: string;
          buy_amount_usd?: number;
          entry_score_threshold?: number;
          rsi_buy_threshold?: number;
          rsi_sell_threshold?: number;
          enabled?: boolean;
          live_trading?: boolean;
          stop_loss_pct?: number;
          take_profit_pct?: number;
          trailing_stop_pct?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tick_log: {
        Row: {
          id: string;
          user_id: string;
          symbol: string;
          rsi: number | null;
          price: number | null;
          action: string;
          reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          symbol: string;
          rsi?: number | null;
          price?: number | null;
          action: string;
          reason?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          symbol?: string;
          rsi?: number | null;
          price?: number | null;
          action?: string;
          reason?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      trades: {
        Row: {
          id: string;
          user_id: string;
          symbol: string;
          entry_price: number;
          size: number;
          quote_size: number;
          entry_fees_usd: number;
          current_price: number | null;
          unrealized_pnl: number | null;
          unrealized_pnl_pct: number | null;
          exit_price: number | null;
          exit_fees_usd: number | null;
          pnl_usd: number | null;
          pnl_pct: number | null;
          effective_pnl: number | null;
          status: string;
          coinbase_order_id: string | null;
          close_order_id: string | null;
          rsi_at_entry: number | null;
          trailing_high: number | null;
          close_reason: string | null;
          price_updated_at: string | null;
          closed_at: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          symbol: string;
          entry_price: number;
          size: number;
          quote_size: number;
          entry_fees_usd?: number;
          current_price?: number | null;
          unrealized_pnl?: number | null;
          unrealized_pnl_pct?: number | null;
          exit_price?: number | null;
          exit_fees_usd?: number | null;
          pnl_usd?: number | null;
          pnl_pct?: number | null;
          effective_pnl?: number | null;
          status?: string;
          coinbase_order_id?: string | null;
          close_order_id?: string | null;
          rsi_at_entry?: number | null;
          trailing_high?: number | null;
          close_reason?: string | null;
          price_updated_at?: string | null;
          closed_at?: string | null;
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          symbol?: string;
          entry_price?: number;
          size?: number;
          quote_size?: number;
          entry_fees_usd?: number;
          current_price?: number | null;
          unrealized_pnl?: number | null;
          unrealized_pnl_pct?: number | null;
          exit_price?: number | null;
          exit_fees_usd?: number | null;
          pnl_usd?: number | null;
          pnl_pct?: number | null;
          effective_pnl?: number | null;
          status?: string;
          coinbase_order_id?: string | null;
          close_order_id?: string | null;
          rsi_at_entry?: number | null;
          trailing_high?: number | null;
          close_reason?: string | null;
          price_updated_at?: string | null;
          closed_at?: string | null;
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      upsert_coinbase_pem: {
        Args: { p_secret_name: string; p_pem: string };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
