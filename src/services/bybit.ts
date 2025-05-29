import { RestClientV5, WebsocketClient, WSClientConfigurableOptions, OrderSideV5 } from 'bybit-api';
import { logger } from '../utils/logger';
import { Candle, VolumeSignal } from '../types/candle';

const CANDLE_HISTORY_SIZE = 4;
const INITIAL_HISTORY_HOURS = 1;
const CANDLE_INTERVAL = '15';
const WS_MARKET = 'v5';
const CATEGORY = 'linear';

type WSEventHandler = (data: any) => void;
type WSErrorHandler = (error: unknown) => void;
type WSCloseHandler = () => void;

export class BybitService {
    private wsClient!: WebsocketClient;
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
    private readonly LOG_INTERVAL = 2 * 60 * 1000;

    constructor(
        apiKey: string,
        apiSecret: string,
        volumeMultiplier: number = 4
    ) {
        if (!apiKey || !apiSecret) {
            throw new Error('API ключи не предоставлены');
        }

        this.volumeMultiplier = volumeMultiplier;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;

        this.client = new RestClientV5({
            key: apiKey,
            secret: apiSecret,
            testnet: false
        });

        this.initializeWebSocket();
    }

    private initializeWebSocket(): void {
        const wsConfig: WSClientConfigurableOptions = {
            key: this.apiKey,
            secret: this.apiSecret,
            market: WS_MARKET,
            testnet: false
        };

        this.wsClient = new WebsocketClient(wsConfig);
        this.setupWebSocketHandlers();
    }

    private setupWebSocketHandlers(): void {
        (this.wsClient as any).on('update', ((data: any) => {
            if (data.topic?.startsWith('kline')) {
                this.handleKlineUpdate(data);
            }
        }) as WSEventHandler);

        (this.wsClient as any).on('error', ((error: unknown) => {
            logger.error('WebSocket error:', error);
        }) as WSErrorHandler);

        (this.wsClient as any).on('close', (() => {
            logger.warn('WebSocket connection closed');
            this.reconnect();
        }) as WSCloseHandler);
    }

    private async reconnect(): Promise<void> {
        logger.info('🔄 Попытка переподключения...');
        try {
            await this.wsClient.closeAll();
            await new Promise(resolve => setTimeout(resolve, 1000));
            this.initializeWebSocket();
            await this.subscribeToSymbol();
        } catch (error) {
            logger.error('❌ Ошибка переподключения:', error);
            setTimeout(() => this.reconnect(), 5000);
        }
    }

    private async initializeCandleHistory(): Promise<void> {
        try {
            logger.info(`📥 Загружаем начальную историю свечей для ${this.SYMBOL}`);
            
            const endTime = Date.now();
            const startTime = endTime - (INITIAL_HISTORY_HOURS * 60 * 60 * 1000);

            const response = await this.client.getKline({
                category: CATEGORY,
                symbol: this.SYMBOL,
                interval: CANDLE_INTERVAL,
                start: Math.floor(startTime),
                end: Math.floor(endTime),
                limit: CANDLE_HISTORY_SIZE
            });

            if (response.retCode === 0 && response.result.list) {
                const candles: Candle[] = response.result.list.reverse().map((item) => this.mapKlineToCandle(item));
                this.candleHistory = candles;
                this.logInitialCandles(candles);
            }
        } catch (error) {
            logger.error('❌ Ошибка при загрузке истории свечей:', error);
            throw error;
        }
    }

    private mapKlineToCandle(item: any[]): Candle {
        return {
            timestamp: Number(item[0]),
            open: Number(item[1]),
            high: Number(item[2]),
            low: Number(item[3]),
            close: Number(item[4]),
            volume: Number(item[5]),
            symbol: this.SYMBOL,
            isGreen: Number(item[4]) >= Number(item[1]),
            confirmed: true
        };
    }

    private logInitialCandles(candles: Candle[]): void {
        logger.info(`✅ Загружено ${candles.length} исторических свечей`);
        
        const lastCandle = candles[candles.length - 1];
        const previousCandle = candles[candles.length - 2];
        
        if (lastCandle && previousCandle) {
            logger.info('📊 Последние свечи:');
            logger.info(`Предыдущая (${new Date(previousCandle.timestamp).toLocaleTimeString()}): объем ${previousCandle.volume.toFixed(2)}`);
            logger.info(`Текущая (${new Date(lastCandle.timestamp).toLocaleTimeString()}): объем ${lastCandle.volume.toFixed(2)}`);
        }
    }

    private handleKlineUpdate(data: any): void {
        try {
            const kline = data.data[0];
            const symbol = data.topic.split('.')[2];

            if (symbol !== this.SYMBOL) return;
            
            const candle = this.createCandleFromKline(kline);
            this.updateCandleHistory(candle);
            this.checkAndLogState(candle);
        } catch (error) {
            logger.error('❌ Ошибка обработки обновления свечи:', error);
        }
    }

    private createCandleFromKline(kline: any): Candle {
        return {
            timestamp: Number(kline.start),
            open: Number(kline.open),
            high: Number(kline.high),
            low: Number(kline.low),
            close: Number(kline.close),
            volume: Number(kline.volume),
            symbol: this.SYMBOL,
            isGreen: Number(kline.close) >= Number(kline.open),
            confirmed: kline.confirm || false
        };
    }

    private updateCandleHistory(candle: Candle): void {
        const isNewCandle = this.candleHistory.length === 0 || 
                          this.candleHistory[this.candleHistory.length - 1].timestamp !== candle.timestamp;

        if (isNewCandle) {
            if (this.candleHistory.length > 0) {
                const lastCandle = this.candleHistory[this.candleHistory.length - 1];
                if (!lastCandle.confirmed) {
                    logger.warn(`⚠️ Предыдущая свеча не была подтверждена: ${new Date(lastCandle.timestamp).toLocaleTimeString()}`);
                }
                this.processCompletedCandle(lastCandle, candle);
            }
            this.candleHistory.push(candle);
            if (this.candleHistory.length > CANDLE_HISTORY_SIZE) {
                this.candleHistory.shift();
            }
        } else {
            this.candleHistory[this.candleHistory.length - 1] = candle;
        }

        if (isNewCandle && this.candleHistory.length >= 2) {
            const previousCandle = this.candleHistory[this.candleHistory.length - 2];
            this.checkVolumeSpike(candle, previousCandle);
        }
    }

    private checkAndLogState(currentCandle: Candle): void {
        const currentTime = Date.now();
        if (currentTime - this.lastLogTime >= this.LOG_INTERVAL) {
            this.logCurrentState(currentCandle);
            this.lastLogTime = currentTime;
        }
    }

    private logCurrentState(currentCandle: Candle): void {
        const previousCandle = this.candleHistory.length >= 2 ? 
            this.candleHistory[this.candleHistory.length - 2] : null;
        
        logger.info('📊 СТАТУС МОНИТОРИНГА:');
        logger.info(`🕒 Время: ${new Date().toLocaleTimeString()}`);
        logger.info(`💰 Текущая цена: $${currentCandle.close}`);
        logger.info(`📈 Текущий объем: ${currentCandle.volume.toFixed(2)}`);
        
        if (previousCandle) {
            const volumeRatio = currentCandle.volume / previousCandle.volume;
            logger.info(`📊 Предыдущий объем: ${previousCandle.volume.toFixed(2)}`);
            logger.info(`📊 Текущее соотношение объемов: ${volumeRatio.toFixed(2)}x (цель: ${this.volumeMultiplier}x)`);
            logger.info(`🎯 Нужно увеличение объема еще в ${Math.max(0, this.volumeMultiplier - volumeRatio).toFixed(2)}x раз`);
            logger.info(`🔒 Текущая свеча подтверждена: ${currentCandle.confirmed ? 'Да' : 'Нет'}`);
            logger.info(`⏱️ Время свечи: ${new Date(currentCandle.timestamp).toLocaleTimeString()}`);
        } else {
            logger.info(`⚠️ Ожидаем накопления истории свечей (нужно минимум 2 свечи)`);
        }

        if (this.currentSignal?.isActive) {
            logger.info('⚠️ АКТИВНЫЙ СИГНАЛ:');
            logger.info(`📊 Объем сигнальной свечи: ${this.currentSignal.candle.volume.toFixed(2)}`);
            logger.info(`🎯 Ожидаем свечу с меньшим объемом для входа в позицию`);
        }

        logger.info('➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖');
    }

    private async processCompletedCandle(completedCandle: Candle, newCandle: Candle): Promise<void> {
        if (!this.currentSignal?.isActive) return;

        if (this.currentSignal.waitingForLowerVolume && completedCandle.confirmed) {
            if (completedCandle.volume < this.currentSignal.candle.volume) {
                logger.info(`🔒 Свеча закрыта и подтверждена`);
                logger.info(`📊 Объем сигнальной свечи: ${this.currentSignal.candle.volume.toFixed(2)}`);
                logger.info(`📊 Объем входной свечи: ${completedCandle.volume.toFixed(2)}`);
                await this.openPosition(this.currentSignal.candle, completedCandle);
                this.currentSignal.isActive = false;
                this.currentSignal.waitingForLowerVolume = false;
            }
        } else if (!completedCandle.confirmed && this.currentSignal.waitingForLowerVolume) {
            logger.info(`⏳ Ожидаем подтверждения закрытия свечи`);
        }
    }

    private async openPosition(signalCandle: Candle, currentCandle: Candle): Promise<void> {
        try {
            const side: OrderSideV5 = signalCandle.isGreen ? 'Sell' : 'Buy';
            
            const stopLoss = signalCandle.isGreen ? 
                signalCandle.high + this.STOP_LOSS_POINTS :
                signalCandle.low - this.STOP_LOSS_POINTS;

            const takeProfit = currentCandle.close + (side === 'Buy' ? 
                this.TAKE_PROFIT_POINTS : 
                -this.TAKE_PROFIT_POINTS);

            const response = await this.client.submitOrder({
                category: 'linear',
                symbol: this.SYMBOL,
                side: side,
                orderType: 'Market',
                qty: this.TRADE_SIZE.toString(),
                timeInForce: 'GTC'
            });

            if (response.retCode === 0) {
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
        return `🔍 ОБНАРУЖЕНО АНОМАЛЬНОЕ УВЕЛИЧЕНИЕ ОБЪЕМА ${this.SYMBOL}:\n\n` +
               `📊 Текущий объем: ${currentCandle.volume.toFixed(2)}\n` +
               `📈 Предыдущий объем: ${previousCandle.volume.toFixed(2)}\n` +
               `💹 Увеличение: ${((currentCandle.volume - previousCandle.volume) / previousCandle.volume * 100).toFixed(2)}%\n` +
               `${currentCandle.isGreen ? '🟢' : '🔴'} Цвет свечи: ${currentCandle.isGreen ? 'ЗЕЛЕНЫЙ' : 'КРАСНЫЙ'}\n` +
               `📉 Движение цены: ${((currentCandle.close - currentCandle.open) / currentCandle.open * 100).toFixed(2)}%\n` +
               `💰 Текущая цена: ${currentCandle.close}`;
    }

    private formatTradeAlert(side: OrderSideV5, entry: number, takeProfit: number, stopLoss: number): string {
        return `🎯 ОТКРЫТА НОВАЯ СДЕЛКА ${this.SYMBOL}\n\n` +
               `${side === 'Buy' ? '📈 ЛОНГ' : '📉 ШОРТ'}\n` +
               `💵 Цена входа: ${entry}\n` +
               `🎯 Тейк-профит: ${takeProfit}\n` +
               `🛑 Стоп-лосс: ${stopLoss}\n` +
               `💰 Размер позиции: $${this.TRADE_SIZE}\n` +
               `📊 Потенциальная прибыль: $${((Math.abs(takeProfit - entry) / entry) * this.TRADE_SIZE).toFixed(2)}\n` +
               `⚠️ Максимальный убыток: $${((Math.abs(stopLoss - entry) / entry) * this.TRADE_SIZE).toFixed(2)}`;
    }

    public onVolumeSpike: (message: string) => void = () => {};
    public onTradeOpen: (message: string) => void = () => {};

    public async subscribeToSymbol(): Promise<void> {
        try {
            await this.initializeCandleHistory();
            await this.wsClient.subscribeV5([`kline.${CANDLE_INTERVAL}.${this.SYMBOL}`], CATEGORY as 'linear');
            
            const startMessage = `🤖 БОТ ЗАПУЩЕН\n\n` +
                               `📊 Торговая пара: ${this.SYMBOL}\n` +
                               `💰 Размер позиции: $${this.TRADE_SIZE}\n` +
                               `📈 Множитель объема: ${this.volumeMultiplier}x\n` +
                               `⏱️ Таймфрейм: ${CANDLE_INTERVAL}m\n` +
                               `📥 Загружено свечей: ${this.candleHistory.length}`;
            this.onTradeOpen(startMessage);
            logger.info(`✅ Подписка на ${this.SYMBOL} активирована`);
        } catch (error) {
            logger.error(`❌ Ошибка при инициализации бота:`, error);
            throw error;
        }
    }
}