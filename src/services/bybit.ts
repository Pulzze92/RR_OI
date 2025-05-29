import { RestClientV5, WebsocketClient, WsKey } from 'bybit-api';
import { logger } from '../utils/logger';
import { Candle } from './bybit.types';
import { NotificationService } from './notificationService';
import { TradingLogicService, TradingLogicCallbacks } from './tradingLogicService';

export class BybitService {
    private wsClient!: WebsocketClient;
    private readonly client: RestClientV5;
    private candleHistory: Candle[] = [];
    private lastLogTime: number = 0;

    private readonly apiKey: string;
    private readonly apiSecret: string;

    private readonly SYMBOL = 'BTCUSDT';
    private readonly CANDLE_INTERVAL: string = '60';
    private readonly CANDLE_HISTORY_SIZE = 4;
    private readonly INITIAL_HISTORY_HOURS = 12;
    private readonly LOG_INTERVAL = 15 * 60 * 1000;

    private readonly TRADE_SIZE_USD = 10000;
    private readonly TAKE_PROFIT_POINTS = 800;
    private readonly STOP_LOSS_POINTS = 450;
    private readonly TRAILING_ACTIVATION_POINTS = 200;
    private readonly TRAILING_DISTANCE = 200;
    private readonly VOLUME_THRESHOLD = 3000;
    private VOLUME_MULTIPLIER: number = 3;

    private onTradeUpdate: (message: string) => void;
    private onSignalUpdate: (message: string) => void;

    private notificationService: NotificationService;
    private tradingLogicService: TradingLogicService;

    constructor(
        apiKey: string,
        apiSecret: string,
        onTradeUpdate: (message: string) => void,
        onSignalUpdate: (message: string) => void,
        volumeMultiplierParam?: number 
    ) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.client = new RestClientV5({ key: apiKey, secret: apiSecret, recv_window: 5000 });
        this.onTradeUpdate = onTradeUpdate;
        this.onSignalUpdate = onSignalUpdate;
        
        if (typeof volumeMultiplierParam === 'number') {
            this.VOLUME_MULTIPLIER = volumeMultiplierParam;
        }

        this.notificationService = new NotificationService(this.SYMBOL, this.TRADE_SIZE_USD, this.STOP_LOSS_POINTS);
        
        const tradingLogicCallbacks: TradingLogicCallbacks = {
            onTradeOperation: this.onTradeUpdate, 
            onSignalDetected: this.onSignalUpdate
        };

        this.tradingLogicService = new TradingLogicService(
            this.client, 
            this.notificationService, 
            tradingLogicCallbacks, 
            {
                symbol: this.SYMBOL,
                tradeSizeUsd: this.TRADE_SIZE_USD,
                takeProfitPoints: this.TAKE_PROFIT_POINTS,
                stopLossPoints: this.STOP_LOSS_POINTS,
                trailingActivationPoints: this.TRAILING_ACTIVATION_POINTS,
                trailingDistance: this.TRAILING_DISTANCE,
                volumeThreshold: this.VOLUME_THRESHOLD,
                volumeMultiplier: this.VOLUME_MULTIPLIER
            }
        );
    }

    public async initialize(): Promise<void> {
        try {
            await this.loadInitialCandleHistory();
            this.subscribeToCandleUpdates();
            const startMessage = `🤖 БОТ ЗАПУЩЕН\n\n` +
                               `📊 Торговая пара: ${this.SYMBOL}\n` +
                               `💰 Размер позиции: $${this.TRADE_SIZE_USD}\n` +
                               `📈 Множитель объема: ${this.VOLUME_MULTIPLIER}x\n` +
                               `⏱️ Таймфрейм: ${this.CANDLE_INTERVAL}h\n` +
                               `📥 Загружено свечей: ${this.candleHistory.length}`;
            this.onTradeUpdate(startMessage);
            logger.info('Сервис Bybit инициализирован, подписан на обновления свечей и стартовое сообщение отправлено.');
        } catch (error) {
            logger.error('Ошибка инициализации сервиса Bybit:', error);
            throw error;
        }
    }

    private async loadInitialCandleHistory(): Promise<void> {
        try {
            const limit = Math.min(this.CANDLE_HISTORY_SIZE, 200); 
            const endTime = Date.now();
            const startTime = endTime - (this.INITIAL_HISTORY_HOURS * 60 * 60 * 1000);

            const response = await this.client.getKline({
                category: 'linear',
                symbol: this.SYMBOL,
                interval: this.CANDLE_INTERVAL as any,
                start: startTime,
                end: endTime,
                limit: limit
            });

            if (response.retCode === 0 && response.result && response.result.list) {
                this.candleHistory = response.result.list.map(k => ({
                    timestamp: Number(k[0]),
                    open: Number(k[1]),
                    high: Number(k[2]),
                    low: Number(k[3]),
                    close: Number(k[4]),
                    volume: Number(k[5]),
                    turnover: Number(k[6]),
                    confirmed: true, 
                    isGreen: Number(k[4]) >= Number(k[1])
                })).sort((a, b) => a.timestamp - b.timestamp); 
                logger.info(`Загружено ${this.candleHistory.length} начальных свечей для ${this.SYMBOL}`);
            } else {
                logger.error('Не удалось загрузить начальную историю свечей:', response.retMsg);
                throw new Error('Failed to load initial candle history: ' + response.retMsg);
            }
        } catch (error) {
            logger.error('Ошибка при загрузке истории свечей:', error);
            throw error;
        }
    }

    private subscribeToCandleUpdates(): void {
        this.wsClient = new WebsocketClient({key: this.apiKey, secret: this.apiSecret, market: 'v5'});

        this.wsClient.subscribeV5([`kline.${this.CANDLE_INTERVAL}.${this.SYMBOL}`], 'linear');

        this.wsClient.on('update', (data: any) => {
            if (data.topic && data.topic.startsWith('kline')) {
                const candleData = data.data[0];
                this.updateCandleHistory({
                    timestamp: Number(candleData.start),
                    open: Number(candleData.open),
                    high: Number(candleData.high),
                    low: Number(candleData.low),
                    close: Number(candleData.close),
                    volume: Number(candleData.volume),
                    turnover: Number(candleData.turnover),
                    confirmed: candleData.confirm,
                    isGreen: Number(candleData.close) >= Number(candleData.open)
                });
            }
        });


        this.wsClient.on('close', () => {
            logger.info('Соединение WebSocket закрыто. Попытка переподключения через 5 секунд...');
            setTimeout(() => {
                logger.info('Переподключение WebSocket...');
                this.subscribeToCandleUpdates(); 
            }, 5000);
        });
        
        this.wsClient.on('open', (evt: { wsKey: WsKey; event: any }) => {
            logger.info(`Соединение WebSocket открыто. wsKey: ${evt.wsKey}`);
        });
    }

    private updateCandleHistory(newCandle: Candle): void {
        const currentTime = Date.now();
        if (currentTime - this.lastLogTime > this.LOG_INTERVAL) {
            logger.info(`Текущий объем формирующейся свечи (${new Date(newCandle.timestamp).toLocaleTimeString()}): ${newCandle.volume.toFixed(2)}, Закрытие: ${newCandle.close}`);
            this.lastLogTime = currentTime;
        }
        
        const existingCandleIndex = this.candleHistory.findIndex(c => c.timestamp === newCandle.timestamp);

        if (existingCandleIndex !== -1) {
            this.candleHistory[existingCandleIndex] = newCandle;
        } else {
            this.candleHistory.push(newCandle);
            if (this.candleHistory.length > this.CANDLE_HISTORY_SIZE) {
                this.candleHistory.shift();
            }
        }
        
        this.candleHistory.sort((a, b) => a.timestamp - b.timestamp);

        if (newCandle.confirmed) {
            logger.info(`🕯️ Новая ЗАВЕРШЕННАЯ свеча (${new Date(newCandle.timestamp).toLocaleTimeString()}): O=${newCandle.open} H=${newCandle.high} L=${newCandle.low} C=${newCandle.close} V=${newCandle.volume.toFixed(2)}`);
            this.processCompletedCandle(newCandle);
        }
    }

    private processCompletedCandle(completedCandle: Candle): void {
        if (this.candleHistory.length < 2) {
            return;
        }
        
        const completedCandleActualIndex = this.candleHistory.findIndex(c => c.timestamp === completedCandle.timestamp);
        if (completedCandleActualIndex < 1) {
            logger.warn(`Не найдена предыдущая свеча для анализа завершенной свечи ${new Date(completedCandle.timestamp).toLocaleTimeString()}`);
            return;
        }
        const previousCandle = this.candleHistory[completedCandleActualIndex - 1];

        this.tradingLogicService.checkVolumeSpike(completedCandle, previousCandle);
        this.tradingLogicService.processCompletedCandle(completedCandle, [...this.candleHistory]); 
    }

    public async getAccountBalance(): Promise<any> { 
        try {
            const response = await this.client.getWalletBalance({ accountType: 'UNIFIED' });
            if (response.retCode === 0 && response.result.list && response.result.list.length > 0) {
                return response.result.list[0];
            }
            logger.error('Ошибка при получении баланса или пустой список:', response.retMsg);
            return null;
        } catch (error) {
            logger.error('Исключение при получении баланса:', error);
            return null;
        }
    }
}