export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    symbol: string;
    isGreen: boolean;
    confirmed: boolean;
}

export interface VolumeSignal {
    candle: Candle;
    isActive: boolean;
    waitingForLowerVolume: boolean;
} 