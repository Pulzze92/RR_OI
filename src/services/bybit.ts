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
    private readonly TRADE_SIZE_USD = 1000;
    private readonly TAKE_PROFIT_POINTS = 300;
    private readonly STOP_LOSS_POINTS = 150;
    private candleHistory: Candle[] = [];
    private currentSignal: VolumeSignal | null = null;
    private readonly volumeMultiplier: number;
    private readonly apiKey: string;
    private readonly apiSecret: string;
    private lastLogTime: number = 0;
    private readonly LOG_INTERVAL = 5 * 60 * 1000;
    private activePosition: {
        side: OrderSideV5;
        entryPrice: number;
        entryTime: number;
    } | null = null;

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
        const isConfirmed = kline.confirm === true || kline.confirm === 'true';
        if (isConfirmed) {
            logger.info(`✅ Получено подтверждение свечи ${new Date(Number(kline.start)).toLocaleTimeString()}`);
        }
        
        return {
            timestamp: Number(kline.start),
            open: Number(kline.open),
            high: Number(kline.high),
            low: Number(kline.low),
            close: Number(kline.close),
            volume: Number(kline.volume),
            symbol: this.SYMBOL,
            isGreen: Number(kline.close) >= Number(kline.open),
            confirmed: isConfirmed
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
                // Проверяем объем только у закрытой свечи
                if (lastCandle.confirmed && this.candleHistory.length >= 2) {
                    const previousCandle = this.candleHistory[this.candleHistory.length - 2];
                    this.checkVolumeSpike(lastCandle, previousCandle);
                }
                this.processCompletedCandle(lastCandle, candle);
            }
            this.candleHistory.push(candle);
            if (this.candleHistory.length > CANDLE_HISTORY_SIZE) {
                this.candleHistory.shift();
            }
        } else {
            // Обновляем текущую свечу
            this.candleHistory[this.candleHistory.length - 1] = candle;
            
            // Убираем проверку объема при обновлении текущей свечи
            // Теперь проверяем объем только после закрытия свечи
        }

        // Логируем текущее состояние
        this.checkAndLogState(candle);
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
        
        if (this.currentSignal?.isActive) {
            logger.info('📊 СТАТУС АКТИВНОГО СИГНАЛА:');
            logger.info(`💰 Текущая цена: $${currentCandle.close}`);
            logger.info(`📈 Текущий объем: ${currentCandle.volume.toFixed(2)}`);
            
            if (previousCandle) {
                const volumeRatio = currentCandle.volume / previousCandle.volume;
                logger.info(`📊 Соотношение с предыдущим объемом: ${volumeRatio.toFixed(2)}x`);
            }

            logger.info(`⏱️ Время сигнальной свечи: ${new Date(this.currentSignal.candle.timestamp).toLocaleTimeString()}`);
            logger.info(`🎯 Ожидаем свечу с меньшим объемом для входа`);
            logger.info('➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖');
        }
    }

    private async processCompletedCandle(completedCandle: Candle, newCandle: Candle): Promise<void> {
        if (!this.currentSignal?.isActive) {
            return;
        }

        // Проверяем, что это не та же самая свеча, в которой был обнаружен сигнал
        if (completedCandle.timestamp === this.currentSignal.candle.timestamp) {
            logger.info(`⏳ Ожидаем следующую свечу после сигнальной (${new Date(completedCandle.timestamp).toLocaleTimeString()})`);
            return;
        }

        if (this.currentSignal.waitingForLowerVolume && completedCandle.confirmed) {
            logger.info(`🔍 Проверка завершенной свечи:`);
            logger.info(`📊 Объем сигнальной свечи (C0): ${this.currentSignal.candle.volume.toFixed(2)}`);
            logger.info(`📊 Объем следующей свечи (C+1): ${completedCandle.volume.toFixed(2)}`);
            
            // Проверяем, что свеча закрыта, подтверждена и её объем НЕ ВЫШЕ сигнальной
            if (completedCandle.confirmed && completedCandle.volume <= this.currentSignal.candle.volume) {
                logger.info(`✅ УСЛОВИЯ ДЛЯ ВХОДА ВЫПОЛНЕНЫ:`);
                logger.info(`📊 Объем сигнальной свечи (C0): ${this.currentSignal.candle.volume.toFixed(2)}`);
                logger.info(`📊 Объем следующей свечи (C+1): ${completedCandle.volume.toFixed(2)}`);
                logger.info(`📈 Соотношение объемов: ${(completedCandle.volume / this.currentSignal.candle.volume).toFixed(2)}x`);
                
                try {
                    await this.openPosition(this.currentSignal.candle, completedCandle);
                    this.currentSignal.isActive = false;
                    this.currentSignal.waitingForLowerVolume = false;
                } catch (error) {
                    logger.error(`❌ Ошибка при открытии позиции:`, error);
                }
            } else if (!completedCandle.confirmed) {
                logger.info(`⏳ Ожидаем подтверждения свечи`);
            } else if (completedCandle.volume > this.currentSignal.candle.volume) {
                logger.info(`⚠️ Объем следующей свечи (${completedCandle.volume.toFixed(2)}) выше сигнальной (${this.currentSignal.candle.volume.toFixed(2)}), пропускаем вход`);
            }
            logger.info('➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖');
        }
    }

    private async openPosition(signalCandle: Candle, currentCandle: Candle): Promise<void> {
        try {
            const side: OrderSideV5 = signalCandle.isGreen ? 'Sell' : 'Buy';
            
            // Для лонга (красная сигнальная свеча):
            // - если лой текущей свечи ниже лоя сигнальной, берем лой текущей
            // - если лой сигнальной ниже, берем её лой
            // Для шорта (зеленая сигнальная свеча):
            // - если хай текущей свечи выше хая сигнальной, берем хай текущей
            // - если хай сигнальной выше, берем её хай
            const stopLossLevel = side === 'Buy' ? 
                Math.min(signalCandle.low, currentCandle.low) :    // Для лонга берем самый низкий лой
                Math.max(signalCandle.high, currentCandle.high);   // Для шорта берем самый высокий хай

            const stopLoss = side === 'Buy' ? 
                stopLossLevel - this.STOP_LOSS_POINTS :   // Для лонга стоп ниже минимума
                stopLossLevel + this.STOP_LOSS_POINTS;    // Для шорта стоп выше максимума

            const takeProfit = currentCandle.close + (side === 'Buy' ? 
                this.TAKE_PROFIT_POINTS : 
                -this.TAKE_PROFIT_POINTS);

            // Конвертируем размер позиции из USD в контракты
            const contractSize = (this.TRADE_SIZE_USD / currentCandle.close).toFixed(3);

            logger.info(`🎯 Попытка открытия позиции:`);
            logger.info(`📈 Направление: ${side} (сигнальная свеча ${signalCandle.isGreen ? 'зеленая' : 'красная'})`);
            logger.info(`💰 Цена входа: ${currentCandle.close}`);
            logger.info(`🎯 Тейк-профит: ${takeProfit}`);
            logger.info(`🛑 Стоп-лосс: ${stopLoss}`);
            logger.info(`📊 Экстремумы свечей:`);
            logger.info(`  Сигнальная (${signalCandle.isGreen ? 'зеленая' : 'красная'}): High=${signalCandle.high}, Low=${signalCandle.low}`);
            logger.info(`  Текущая: High=${currentCandle.high}, Low=${currentCandle.low}`);
            logger.info(`  Выбран ${side === 'Buy' ? 'минимум' : 'максимум'}: ${stopLossLevel}`);
            logger.info(`  Стоп установлен на ${Math.abs(this.STOP_LOSS_POINTS)} пунктов ${side === 'Buy' ? 'ниже' : 'выше'}`);
            logger.info(`📊 Размер позиции: $${this.TRADE_SIZE_USD} (${contractSize} контрактов)`);

            const response = await this.client.submitOrder({
                category: 'linear',
                symbol: this.SYMBOL,
                side: side,
                orderType: 'Market',
                qty: contractSize,
                timeInForce: 'GTC'
            });

            logger.info(`📡 Ответ от API при открытии позиции:`, response);

            if (response.retCode === 0) {
                logger.info(`✅ Позиция успешно открыта, устанавливаю стоп-лосс и тейк-профит`);
                
                // Сохраняем информацию об открытой позиции
                this.activePosition = {
                    side: side,
                    entryPrice: currentCandle.close,
                    entryTime: currentCandle.timestamp
                };

                const tpSlResponse = await this.client.setTradingStop({
                    category: 'linear',
                    symbol: this.SYMBOL,
                    takeProfit: takeProfit.toString(),
                    stopLoss: stopLoss.toString(),
                    positionIdx: 0,
                    tpTriggerBy: 'MarkPrice',
                    slTriggerBy: 'MarkPrice'
                });

                const message = this.formatTradeAlert(side, currentCandle.close, takeProfit, stopLoss, signalCandle, currentCandle);
                this.onTradeOpen(message);
                logger.info(`✅ Сделка полностью оформлена и уведомление отправлено`);
            } else {
                logger.error(`❌ Ошибка при открытии позиции, код: ${response.retCode}, сообщение: ${response.retMsg}`);
            }
        } catch (error) {
            logger.error('❌ Ошибка при открытии позиции:', error);
            if (error instanceof Error) {
                logger.error('Детали ошибки:', error.message);
                logger.error('Стек ошибки:', error.stack);
            }
        }
    }

    private formatTradeAlert(side: OrderSideV5, entry: number, takeProfit: number, stopLoss: number, signalCandle: Candle, currentCandle: Candle): string {
        const contractSize = (this.TRADE_SIZE_USD / entry).toFixed(3);
        const stopLossLevel = signalCandle.isGreen ? 
            Math.max(signalCandle.high, currentCandle.high) :
            Math.min(signalCandle.low, currentCandle.low);
            
        return `🎯 ОТКРЫТА НОВАЯ СДЕЛКА ${this.SYMBOL}\n\n` +
               `${side === 'Buy' ? '📈 ЛОНГ' : '📉 ШОРТ'}\n` +
               `💵 Цена входа: ${entry}\n` +
               `🎯 Тейк-профит: ${takeProfit}\n` +
               `🛑 Стоп-лосс: ${stopLoss}\n` +
               `📊 Расчет стопа:\n` +
               `  • Сигнальная свеча (${signalCandle.isGreen ? '🟢' : '🔴'}): ${signalCandle.isGreen ? `High=${signalCandle.high}` : `Low=${signalCandle.low}`}\n` +
               `  • Текущая свеча: ${signalCandle.isGreen ? `High=${currentCandle.high}` : `Low=${currentCandle.low}`}\n` +
               `  • Выбран ${signalCandle.isGreen ? 'максимум' : 'минимум'}: ${stopLossLevel}\n` +
               `  • Стоп: ${Math.abs(this.STOP_LOSS_POINTS)} пунктов ${signalCandle.isGreen ? 'выше' : 'ниже'}\n` +
               `💰 Размер позиции: $${this.TRADE_SIZE_USD} (${contractSize} BTC)\n` +
               `📊 Потенциальная прибыль: $${((Math.abs(takeProfit - entry) / entry) * this.TRADE_SIZE_USD).toFixed(2)}\n` +
               `⚠️ Максимальный убыток: $${((Math.abs(stopLoss - entry) / entry) * this.TRADE_SIZE_USD).toFixed(2)}`;
    }

    private async closePosition(candle: Candle, reason: string): Promise<void> {
        if (!this.activePosition) return;

        try {
            // Закрываем позицию противоположным ордером
            const closeSide: OrderSideV5 = this.activePosition.side === 'Buy' ? 'Sell' : 'Buy';
            const contractSize = (this.TRADE_SIZE_USD / candle.close).toFixed(3);

            logger.info(`🚨 Закрытие позиции по причине: ${reason}`);
            logger.info(`📊 Направление закрытия: ${closeSide}`);
            logger.info(`💰 Цена закрытия: ${candle.close}`);

            const response = await this.client.submitOrder({
                category: 'linear',
                symbol: this.SYMBOL,
                side: closeSide,
                orderType: 'Market',
                qty: contractSize,
                timeInForce: 'GTC'
            });

            if (response.retCode === 0) {
                const profit = this.activePosition.side === 'Buy' ? 
                    candle.close - this.activePosition.entryPrice :
                    this.activePosition.entryPrice - candle.close;
                
                const profitPercent = (profit / this.activePosition.entryPrice) * 100;
                const profitUSD = (profit / this.activePosition.entryPrice) * this.TRADE_SIZE_USD;

                const message = `🔄 ПОЗИЦИЯ ЗАКРЫТА ${this.SYMBOL}\n\n` +
                    `${this.activePosition.side === 'Buy' ? '📈 ЛОНГ' : '📉 ШОРТ'}\n` +
                    `💵 Цена входа: ${this.activePosition.entryPrice}\n` +
                    `💰 Цена выхода: ${candle.close}\n` +
                    `📊 Прибыль/Убыток: $${profitUSD.toFixed(2)} (${profitPercent.toFixed(2)}%)\n` +
                    `⚠️ Причина закрытия: ${reason}`;

                this.onTradeOpen(message);
                logger.info(`✅ Позиция успешно закрыта`);
                this.activePosition = null;
            } else {
                logger.error(`❌ Ошибка при закрытии позиции, код: ${response.retCode}, сообщение: ${response.retMsg}`);
            }
        } catch (error) {
            logger.error('❌ Ошибка при закрытии позиции:', error);
            if (error instanceof Error) {
                logger.error('Детали ошибки:', error.message);
                logger.error('Стек ошибки:', error.stack);
            }
        }
    }

    private checkVolumeSpike(completedCandle: Candle, previousCandle: Candle): void {
        if (!completedCandle.confirmed) {
            return;
        }

        const volumeRatio = completedCandle.volume / previousCandle.volume;
        
        // Если есть активная позиция и обнаружен аномальный объем - закрываем
        if (volumeRatio >= this.volumeMultiplier && this.activePosition) {
            const timeSinceEntry = completedCandle.timestamp - this.activePosition.entryTime;
            // Проверяем, что это не та же свеча, на которой мы вошли
            if (timeSinceEntry > 0) {
                logger.info(`🚨 ОБНАРУЖЕН АНОМАЛЬНЫЙ ОБЪЕМ ПОСЛЕ ВХОДА В ПОЗИЦИЮ!`);
                logger.info(`📊 Объем вырос в ${volumeRatio.toFixed(2)}x раз`);
                this.closePosition(completedCandle, 'Аномальный объем после входа');
                return;
            }
        }

        // Остальная логика проверки объема для входа остается без изменений
        if (volumeRatio >= this.volumeMultiplier * 0.8) {
            logger.info(`🔍 ПРОВЕРКА ОБЪЕМОВ ЗАКРЫТОЙ СВЕЧИ:`);
            logger.info(`📊 Объем закрытой свечи: ${completedCandle.volume.toFixed(2)}`);
            logger.info(`📊 Объем предыдущей свечи: ${previousCandle.volume.toFixed(2)}`);
            logger.info(`📈 Соотношение: ${volumeRatio.toFixed(2)}x (цель: ${this.volumeMultiplier}x)`);
            logger.info(`⏱️ Время свечи: ${new Date(completedCandle.timestamp).toLocaleTimeString()}`);
            logger.info(`📊 Цена закрытия: ${completedCandle.close}`);
            logger.info('➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖');
        }
        
        if (volumeRatio >= this.volumeMultiplier && !this.currentSignal?.isActive) {
            logger.info(`🚨 ОБНАРУЖЕН ВСПЛЕСК ОБЪЕМА В ЗАКРЫТОЙ СВЕЧЕ!`);
            logger.info(`📊 Объем вырос в ${volumeRatio.toFixed(2)}x раз`);
            logger.info(`💰 Цена закрытия: ${completedCandle.close}`);
            logger.info(`📈 Движение цены: ${((completedCandle.close - completedCandle.open) / completedCandle.open * 100).toFixed(2)}%`);
            
            const message = this.formatVolumeAlert(completedCandle, previousCandle);
            this.onVolumeSpike(message);

            this.currentSignal = {
                candle: completedCandle,
                isActive: true,
                waitingForLowerVolume: true
            };
            
            logger.info(`✅ Сигнал активирован, ожидаем следующую свечу с меньшим объемом`);
            logger.info('➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖');
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

    public onVolumeSpike: (message: string) => void = () => {};
    public onTradeOpen: (message: string) => void = () => {};

    public async subscribeToSymbol(): Promise<void> {
        try {
            await this.initializeCandleHistory();
            await this.wsClient.subscribeV5([`kline.${CANDLE_INTERVAL}.${this.SYMBOL}`], CATEGORY as 'linear');
            
            const startMessage = `🤖 БОТ ЗАПУЩЕН\n\n` +
                               `📊 Торговая пара: ${this.SYMBOL}\n` +
                               `💰 Размер позиции: $${this.TRADE_SIZE_USD}\n` +
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