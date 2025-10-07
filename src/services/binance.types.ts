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
  waitingForEntry?: boolean;
  confirmingCandle?: Candle;
}

export interface ActivePosition {
  side: "Buy" | "Sell";
  entryPrice: number;
  entryTime: number;
  isTrailingActive: boolean;
  lastTrailingStopPrice: number | null;
  orderId: string;
  plannedTakeProfit: number;
  plannedStopLoss: number;
  executionNotificationSent: boolean;
  actualTradeSize?: number; // Размер позиции на момент открытия
}
