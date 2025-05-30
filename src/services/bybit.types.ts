import { OrderSideV5 } from "bybit-api";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  confirmed: boolean;
  isGreen: boolean;
}

export interface VolumeSignal {
  candle: Candle;
  isActive: boolean;
  waitingForLowerVolume: boolean;
}

export interface ActivePosition {
  side: OrderSideV5;
  entryPrice: number;
  entryTime: number;
  isTrailingActive: boolean;
  lastTrailingStopPrice: number | null;
  orderId: string;
  plannedTakeProfit?: number;
  plannedStopLoss?: number;
  executionNotificationSent?: boolean;
}
