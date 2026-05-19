export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      broker_credentials: {
        Row: {
          api_key_name: string
          created_at: string
          id: string
          updated_at: string
          user_id: string
          vault_secret_name: string
        }
        Insert: {
          api_key_name: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
          vault_secret_name: string
        }
        Update: {
          api_key_name?: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
          vault_secret_name?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          buy_amount_usd: number
          compound_mode: boolean
          created_at: string
          daily_loss_limit_usd: number
          enabled: boolean
          entry_score_threshold: number
          id: string
          live_trading: boolean
          max_drawdown_pct: number
          max_spread_pct: number
          max_volatility_pct: number
          paper_balance_usd: number
          paper_starting_balance_usd: number
          rsi_buy_threshold: number
          rsi_sell_threshold: number
          stop_loss_pct: number
          symbol: string
          take_profit_pct: number
          trailing_stop_pct: number
          updated_at: string
          user_id: string
        }
        Insert: {
          buy_amount_usd?: number
          compound_mode?: boolean
          created_at?: string
          daily_loss_limit_usd?: number
          enabled?: boolean
          entry_score_threshold?: number
          id?: string
          live_trading?: boolean
          max_drawdown_pct?: number
          max_spread_pct?: number
          max_volatility_pct?: number
          paper_balance_usd?: number
          paper_starting_balance_usd?: number
          rsi_buy_threshold?: number
          rsi_sell_threshold?: number
          stop_loss_pct?: number
          symbol?: string
          take_profit_pct?: number
          trailing_stop_pct?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          buy_amount_usd?: number
          compound_mode?: boolean
          created_at?: string
          daily_loss_limit_usd?: number
          enabled?: boolean
          entry_score_threshold?: number
          id?: string
          live_trading?: boolean
          max_drawdown_pct?: number
          max_spread_pct?: number
          max_volatility_pct?: number
          paper_balance_usd?: number
          paper_starting_balance_usd?: number
          rsi_buy_threshold?: number
          rsi_sell_threshold?: number
          stop_loss_pct?: number
          symbol?: string
          take_profit_pct?: number
          trailing_stop_pct?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tick_log: {
        Row: {
          action: string
          created_at: string
          id: string
          price: number | null
          reason: string | null
          rsi: number | null
          symbol: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          price?: number | null
          reason?: string | null
          rsi?: number | null
          symbol: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          price?: number | null
          reason?: string | null
          rsi?: number | null
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          close_order_id: string | null
          close_reason: string | null
          closed_at: string | null
          coinbase_order_id: string | null
          created_at: string
          current_price: number | null
          effective_pnl: number | null
          entry_fees_usd: number
          entry_price: number
          exit_fees_usd: number | null
          exit_price: number | null
          id: string
          notes: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          price_updated_at: string | null
          quote_size: number
          rsi_at_entry: number | null
          size: number
          status: string
          symbol: string
          trailing_high: number | null
          unrealized_pnl: number | null
          unrealized_pnl_pct: number | null
          user_id: string
        }
        Insert: {
          close_order_id?: string | null
          close_reason?: string | null
          closed_at?: string | null
          coinbase_order_id?: string | null
          created_at?: string
          current_price?: number | null
          effective_pnl?: number | null
          entry_fees_usd?: number
          entry_price: number
          exit_fees_usd?: number | null
          exit_price?: number | null
          id?: string
          notes?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          price_updated_at?: string | null
          quote_size: number
          rsi_at_entry?: number | null
          size: number
          status?: string
          symbol: string
          trailing_high?: number | null
          unrealized_pnl?: number | null
          unrealized_pnl_pct?: number | null
          user_id: string
        }
        Update: {
          close_order_id?: string | null
          close_reason?: string | null
          closed_at?: string | null
          coinbase_order_id?: string | null
          created_at?: string
          current_price?: number | null
          effective_pnl?: number | null
          entry_fees_usd?: number
          entry_price?: number
          exit_fees_usd?: number | null
          exit_price?: number | null
          id?: string
          notes?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          price_updated_at?: string | null
          quote_size?: number
          rsi_at_entry?: number | null
          size?: number
          status?: string
          symbol?: string
          trailing_high?: number | null
          unrealized_pnl?: number | null
          unrealized_pnl_pct?: number | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      expire_old_ticks: { Args: never; Returns: undefined }
      get_coinbase_broker_credentials: {
        Args: never
        Returns: {
          api_key_name: string
          api_key_private_pem: string
        }[]
      }
      get_coinbase_credentials_for_user: {
        Args: { p_user_id: string }
        Returns: {
          api_key_name: string
          api_key_private_pem: string
        }[]
      }
      upsert_coinbase_pem: {
        Args: { p_pem: string; p_secret_name: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
