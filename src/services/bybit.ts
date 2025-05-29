import { RestClientV5, WebsocketClient, WSClientConfigurableOptions, OrderSideV5 } from 'bybit-api';
import { logger } from '../utils/logger';

interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    symbol: string;
    isGreen: boolean;
}

interface VolumeSignal {
    candle: Candle;
    isActive: boolean;
    waitingForLowerVolume: boolean;
}

export class BybitService {
    private wsClient: WebsocketClient;
    private readonly client: RestClientV5;
    private readonly SYMBOL = 'BTCUSDT';
    private readonly TRADE_SIZE = 10000;
    private readonly TAKE_PROFIT_POINTS = 300;
    private readonly STOP_LOSS_POINTS = 300;
    private candleHistory: Candle[] = [];
    private currentSignal: VolumeSignal | null = null;
    private readonly volumeMultiplier: number;
    private readonly apiKey: string;
    private readonly apiSecret: string;
    private lastLogTime: number = 0;
    private readonly LOG_INTERVAL = 5 * 60 * 1000;

    constructor(
        apiKey: string,
        apiSecret: string,
        volumeMultiplier: number = 4
    ) {
        this.volumeMultiplier = volumeMultiplier;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;

        this.client = new RestClientV5({
            key: apiKey,
            secret: apiSecret,
            testnet: false
        });

        const wsConfig: WSClientConfigurableOptions = {
            key: apiKey,
            secret: apiSecret,
            market: 'v5',
            testnet: false
        };

        this.wsClient = new WebsocketClient(wsConfig);
        this.setupWebSocketHandlers();
    }

    private setupWebSocketHandlers(): void {
        (this.wsClient as any).on('update', (data: any) => {
            if (data.topic?.startsWith('kline')) {
                this.handleKlineUpdate(data);
            }
        });

        (this.wsClient as any).on('error', (error: any) => {
            logger.error('WebSocket error:', error);
        });

        (this.wsClient as any).on('close', () => {
            logger.warn('WebSocket connection closed');
            this.reconnect();
        });
    }

    private async reconnect(): Promise<void> {
        logger.info('Attempting to reconnect...');
        try {
            await this.wsClient.closeAll();
            
            const wsConfig: WSClientConfigurableOptions = {
                key: this.apiKey,
                secret: this.apiSecret,
                market: 'v5',
                testnet: false
            };

            this.wsClient = new WebsocketClient(wsConfig);
            this.setupWebSocketHandlers();
            await this.subscribeToSymbol();
        } catch (error) {
            logger.error('Failed to reconnect:', error);
            setTimeout(() => this.reconnect(), 5000);
        }
    }

    private handleKlineUpdate(data: any): void {
        try {
            const kline = data.data[0];
            const symbol = data.topic.split('.')[2];

            if (symbol !== this.SYMBOL) return;
            
            const candle: Candle = {
                timestamp: Number(kline.start),
                open: Number(kline.open),
                high: Number(kline.high),
                low: Number(kline.low),
                close: Number(kline.close),
                volume: Number(kline.volume),
                symbol,
                isGreen: Number(kline.close) >= Number(kline.open)
            };

            const currentTime = Date.now();
            if (currentTime - this.lastLogTime >= this.LOG_INTERVAL) {
                this.logCurrentState(candle);
                this.lastLogTime = currentTime;
            }

            const isNewCandle = this.candleHistory.length === 0 || 
                              this.candleHistory[this.candleHistory.length - 1].timestamp !== candle.timestamp;

            if (isNewCandle) {
                if (this.candleHistory.length > 0) {
                    this.processCompletedCandle(this.candleHistory[this.candleHistory.length - 1], candle);
                }
                this.candleHistory.push(candle);
                if (this.candleHistory.length > 10) {
                    this.candleHistory.shift();
                }
            } else {
                this.candleHistory[this.candleHistory.length - 1] = candle;
            }

            // Проверяем объем только для новых свечей
            if (isNewCandle && this.candleHistory.length >= 2) {
                const previousCandle = this.candleHistory[this.candleHistory.length - 2];
                this.checkVolumeSpike(candle, previousCandle);
            }
        } catch (error) {
            logger.error('Error handling kline update:', error);
        }
    }

    private logCurrentState(currentCandle: Candle): void {
        const previousCandle = this.candleHistory[this.candleHistory.length - 2];
        const requiredVolume = previousCandle ? previousCandle.volume * this.volumeMultiplier : 0;
        
        logger.info('📊 MONITORING STATUS:');
        logger.info(`🕒 Time: ${new Date().toLocaleTimeString()}`);
        logger.info(`💰 Current price: $${currentCandle.close}`);
        logger.info(`📈 Current volume: ${currentCandle.volume.toFixed(2)}`);
        
        if (previousCandle) {
            const volumeRatio = currentCandle.volume / previousCandle.volume;
            logger.info(`📊 Previous volume: ${previousCandle.volume.toFixed(2)}`);
            logger.info(`📊 Current volume ratio: ${volumeRatio.toFixed(2)}x (goal: ${this.volumeMultiplier}x)`);
            logger.info(`🎯 Need to increase volume by ${Math.max(0, this.volumeMultiplier - volumeRatio).toFixed(2)}x`);
        }

        if (this.currentSignal?.isActive) {
            logger.info('⚠️ ACTIVE SIGNAL:');
            logger.info(`📊 Signal candle volume: ${this.currentSignal.candle.volume.toFixed(2)}`);
            logger.info(`🎯 Waiting for lower volume candle to enter position`);
        }

        logger.info('➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖');
    }

    private async processCompletedCandle(completedCandle: Candle, newCandle: Candle): Promise<void> {
        if (!this.currentSignal?.isActive) return;

        if (this.currentSignal.waitingForLowerVolume) {
            if (newCandle.volume < this.currentSignal.candle.volume) {
                // Нашли свечу с меньшим объемом, открываем позицию
                await this.openPosition(this.currentSignal.candle, newCandle);
                this.currentSignal.isActive = false;
                this.currentSignal.waitingForLowerVolume = false;
            }
        }
    }

    private async openPosition(signalCandle: Candle, currentCandle: Candle): Promise<void> {
        try {
            // Определяем направление сделки (противоположное направлению сигнальной свечи)
            const side: OrderSideV5 = signalCandle.isGreen ? 'Sell' : 'Buy';
            
            // Рассчитываем стоп-лосс
            const stopLoss = signalCandle.isGreen ? 
                signalCandle.high + this.STOP_LOSS_POINTS :
                signalCandle.low - this.STOP_LOSS_POINTS;

            // Рассчитываем тейк-профит
            const takeProfit = currentCandle.close + (side === 'Buy' ? 
                this.TAKE_PROFIT_POINTS : 
                -this.TAKE_PROFIT_POINTS);

            // Открываем позицию
            const response = await this.client.submitOrder({
                category: 'linear',
                symbol: this.SYMBOL,
                side: side,
                orderType: 'Market',
                qty: this.TRADE_SIZE.toString(),
                timeInForce: 'GTC'
            });

            if (response.retCode === 0) {
                // Устанавливаем TP/SL
                await this.client.setTradingStop({
                    category: 'linear',
                    symbol: this.SYMBOL,
                    takeProfit: takeProfit.toString(),
                    stopLoss: stopLoss.toString(),
                    positionIdx: 0,
                    tpTriggerBy: 'MarkPrice',
                    slTriggerBy: 'MarkPrice'
                });

                const message = this.formatTradeAlert(side, currentCandle.close, takeProfit, stopLoss);
                this.onTradeOpen(message);
            }
        } catch (error) {
            logger.error('Failed to open position:', error);
        }
    }

    private checkVolumeSpike(currentCandle: Candle, previousCandle: Candle): void {
        if (currentCandle.volume >= previousCandle.volume * this.volumeMultiplier) {
            const message = this.formatVolumeAlert(currentCandle, previousCandle);
            this.onVolumeSpike(message);

            this.currentSignal = {
                candle: currentCandle,
                isActive: true,
                waitingForLowerVolume: true
            };
        }
    }

    private formatVolumeAlert(currentCandle: Candle, previousCandle: Candle): string {
        return `🔍 ANOMALOUS INCREASE IN VOLUME DETECTED FOR ${this.SYMBOL}:\n\n` +
               `📊 Current volume: ${currentCandle.volume.toFixed(2)}\n` +
               `📈 Previous volume: ${previousCandle.volume.toFixed(2)}\n` +
               `💹 Candle trend: ${((currentCandle.volume - previousCandle.volume) / previousCandle.volume * 100).toFixed(2)}%\n` +
               `${currentCandle.isGreen ? '🟢' : '🔴'} Candle color: ${currentCandle.isGreen ? 'GREEN' : 'RED'}\n` +
               `📉 Price direction: ${((currentCandle.close - currentCandle.open) / currentCandle.open * 100).toFixed(2)}%\n` +
               `💰 Current price: ${currentCandle.close}`;
    }

    private formatTradeAlert(side: OrderSideV5, entry: number, takeProfit: number, stopLoss: number): string {
        return `🎯 NEW TRADE OPENED FOR ${this.SYMBOL}\n\n` +
               `${side === 'Buy' ? '📈 LONG' : '📉 SHORT'}\n` +
               `💵 Entry price: ${entry}\n` +
               `🎯 Take-profit: ${takeProfit}\n` +
               `🛑 Stop-loss: ${stopLoss}\n` +
               `💰 Position size: $${this.TRADE_SIZE}\n` +
               `📊 Potential profit: $${((Math.abs(takeProfit - entry) / entry) * this.TRADE_SIZE).toFixed(2)}\n` +
               `⚠️ Maximum loss: $${((Math.abs(stopLoss - entry) / entry) * this.TRADE_SIZE).toFixed(2)}`;
    }

    public onVolumeSpike: (message: string) => void = () => {};
    public onTradeOpen: (message: string) => void = () => {};

    public async subscribeToSymbol(): Promise<void> {
        try {
            await this.wsClient.subscribeV5([`kline.15.${this.SYMBOL}`], 'linear');
            const startMessage = `🤖 BOT STARTED\n\n` +
                               `📊 Trading pair: ${this.SYMBOL}\n` +
                               `💰 Position size: $${this.TRADE_SIZE}\n` +
                               `📈 Volume multiplier: ${this.volumeMultiplier}x\n` +
                               `⏱️ Timeframe: 15m`;
            this.onTradeOpen(startMessage);
            logger.info(`Subscribed to ${this.SYMBOL} klines`);
        } catch (error) {
            logger.error(`Failed to subscribe to ${this.SYMBOL}:`, error);
        }
    }
} 