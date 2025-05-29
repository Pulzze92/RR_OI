import { RestClientV5, OrderSideV5, LinearInverseInstrumentInfoV5 } from 'bybit-api';
import { Candle, VolumeSignal, ActivePosition } from './bybit.types';
import { NotificationService } from './notificationService';
import { logger } from '../utils/logger';

export interface TradingLogicCallbacks {
    onTradeOperation: (message: string) => void;
    onSignalDetected: (message: string) => void;
}

export class TradingLogicService {
    private currentSignal: VolumeSignal | null = null;
    private activePosition: ActivePosition | null = null;
    private trailingStopInterval: NodeJS.Timeout | null = null;

    private readonly TAKE_PROFIT_POINTS: number;
    private readonly STOP_LOSS_POINTS: number;
    private readonly TRAILING_ACTIVATION_POINTS: number;
    private readonly TRAILING_DISTANCE: number;
    private readonly VOLUME_THRESHOLD: number;
    private readonly VOLUME_MULTIPLIER: number;
    private readonly TRADE_SIZE_USD: number;
    private readonly SYMBOL: string;
    private readonly TRAILING_STOP_INTERVAL_MS = 3000;

    constructor(
        private client: RestClientV5,
        private notificationService: NotificationService,
        private callbacks: TradingLogicCallbacks,
        options: {
            symbol: string;
            tradeSizeUsd: number;
            takeProfitPoints: number;
            stopLossPoints: number;
            trailingActivationPoints: number;
            trailingDistance: number;
            volumeThreshold: number;
            volumeMultiplier: number;
        }
    ) {
        this.SYMBOL = options.symbol;
        this.TRADE_SIZE_USD = options.tradeSizeUsd;
        this.TAKE_PROFIT_POINTS = options.takeProfitPoints;
        this.STOP_LOSS_POINTS = options.stopLossPoints;
        this.TRAILING_ACTIVATION_POINTS = options.trailingActivationPoints;
        this.TRAILING_DISTANCE = options.trailingDistance;
        this.VOLUME_THRESHOLD = options.volumeThreshold;
        this.VOLUME_MULTIPLIER = options.volumeMultiplier;
    }

    public getActivePosition(): ActivePosition | null {
        return this.activePosition;
    }

    public getCurrentSignal(): VolumeSignal | null {
        return this.currentSignal;
    }
    
    public resetSignal(): void {
        if (this.currentSignal) {
            logger.info('🔄 Сигнал отменен из-за отсутствия условий для входа.');
            this.currentSignal = null;
        }
    }

    public checkVolumeSpike(completedCandle: Candle, previousCandle: Candle): void {
        if (!completedCandle.confirmed) {
            return;
        }

        const volumeRatio = completedCandle.volume / previousCandle.volume;
        
        if (volumeRatio >= this.VOLUME_MULTIPLIER && this.activePosition) {
            const timeSinceEntry = completedCandle.timestamp - this.activePosition.entryTime;
            if (timeSinceEntry > 0) {
                logger.info(`🚨 ОБНАРУЖЕН АНОМАЛЬНЫЙ ОБЪЕМ ПОСЛЕ ВХОДА! Закрытие позиции.`);
                logger.info(`📊 Объем вырос в ${volumeRatio.toFixed(2)}x раз`);
                this.closePosition(completedCandle, 'Аномальный объем после входа');
                return;
            }
        }

        const isVolumeSpike = volumeRatio >= this.VOLUME_MULTIPLIER;
        const isHighVolume = completedCandle.volume >= this.VOLUME_THRESHOLD;

        if (!this.currentSignal?.isActive && (isVolumeSpike || isHighVolume)) {
            let signalReason = '';
            if (isVolumeSpike && isHighVolume) {
                signalReason = `ВЫСОКИЙ ОБЪЕМ (${completedCandle.volume.toFixed(2)}) И ВСПЛЕСК ОБЪЕМА (${volumeRatio.toFixed(2)}x)`;
            } else if (isVolumeSpike) {
                signalReason = `ВСПЛЕСК ОБЪЕМА (${volumeRatio.toFixed(2)}x)`;
            } else {
                signalReason = `ВЫСОКИЙ ОБЪЕМ (${completedCandle.volume.toFixed(2)})`;
            }
            logger.info(`🚨 ОБНАРУЖЕН СИГНАЛ: ${signalReason} В ЗАКРЫТОЙ СВЕЧЕ!`);
            logger.info(`💰 Цена закрытия: ${completedCandle.close}`);
            
            const message = this.notificationService.formatVolumeAlert(completedCandle, previousCandle);
            this.callbacks.onSignalDetected(message);

            this.currentSignal = {
                candle: completedCandle,
                isActive: true,
                waitingForLowerVolume: true
            };
            logger.info(`✅ Сигнал активирован, ожидаем следующую свечу с меньшим объемом`);
        } else if (this.currentSignal?.isActive && (completedCandle.volume > previousCandle.volume && completedCandle.volume / previousCandle.volume >= this.VOLUME_MULTIPLIER || completedCandle.volume >= this.VOLUME_THRESHOLD )) {
            logger.info(`🔄 ОБНОВЛЕНИЕ СИГНАЛА: Новая свеча также соответствует условиям.`);
             this.currentSignal = {
                candle: completedCandle,
                isActive: true,
                waitingForLowerVolume: true
            };
            logger.info(`✅ Сигнал обновлен, ожидаем следующую свечу с меньшим объемом`);
        } else if (volumeRatio >= this.VOLUME_MULTIPLIER * 0.8 || completedCandle.volume >= this.VOLUME_THRESHOLD * 0.8) {
             logger.info(`🔍 ПРОВЕРКА ОБЪЕМОВ ЗАКРЫТОЙ СВЕЧИ (близко к сигналу): Объем ${completedCandle.volume.toFixed(2)}, Ратио ${volumeRatio.toFixed(2)}x`);
        }
    }

    public processCompletedCandle(completedCandle: Candle, candleHistory: Candle[]): void {
        logger.info(`[TradingLogic] processCompletedCandle вызван для свечи: ${new Date(completedCandle.timestamp).toLocaleTimeString()}, V=${completedCandle.volume.toFixed(2)}, Confirmed: ${completedCandle.confirmed}`);
        logger.info(`[TradingLogic] Текущий сигнал: ${this.currentSignal ? `Активен, время: ${new Date(this.currentSignal.candle.timestamp).toLocaleTimeString()}, V=${this.currentSignal.candle.volume.toFixed(2)}` : 'НЕТ АКТИВНОГО СИГНАЛА'}`);

        if (!this.currentSignal?.isActive || !this.currentSignal.waitingForLowerVolume) {
            logger.info('[TradingLogic] Сигнал неактивен или не ожидаем свечу с меньшим объемом. Выход.');
            return;
        }

        if (completedCandle.timestamp === this.currentSignal.candle.timestamp) {
            logger.info('[TradingLogic] Завершенная свеча является сигнальной. Пропускаем.');
            return;
        }
        
        logger.info(`[TradingLogic] Ищем сигнальную свечу (${new Date(this.currentSignal.candle.timestamp).toLocaleTimeString()}) и завершенную (${new Date(completedCandle.timestamp).toLocaleTimeString()}) в истории (размер: ${candleHistory.length})`);
        const signalCandleFromHistory = candleHistory.find(c => c.timestamp === this.currentSignal!.candle.timestamp);
        const completedCandleFromHistory = candleHistory.find(c => c.timestamp === completedCandle.timestamp);

        if (!signalCandleFromHistory || !completedCandleFromHistory) {
            logger.warn("[TradingLogic] Не удалось найти сигнальную или завершенную свечу в переданной истории.");
            // Логируем содержимое истории для отладки, если она не слишком большая
            if (candleHistory.length < 10) {
                logger.debug("[TradingLogic] Содержимое candleHistory:", JSON.stringify(candleHistory.map(c => ({t: new Date(c.timestamp).toLocaleTimeString(), v:c.volume, conf: c.confirmed}))));
            }
            this.resetSignal(); // Возможно, стоит пересмотреть, нужно ли сбрасывать сигнал в этом случае или ждать дальше
            return;
        }
        logger.info(`[TradingLogic] Сигнальная свеча найдена в истории: V=${signalCandleFromHistory.volume.toFixed(2)}. Завершенная свеча найдена: V=${completedCandleFromHistory.volume.toFixed(2)}`);


        if (completedCandle.volume <= this.currentSignal.candle.volume) {
            logger.info(`✅ [TradingLogic] Условие для входа выполнено: объем текущей свечи (${completedCandle.volume.toFixed(2)}) <= объема сигнальной (${this.currentSignal.candle.volume.toFixed(2)})`);
            this.openPosition(this.currentSignal.candle, completedCandle);
            // Сбрасываем сигнал только ПОСЛЕ успешной попытки открытия (или если она не удалась, но решение принято)
            this.currentSignal.isActive = false; 
            this.currentSignal.waitingForLowerVolume = false;
            logger.info('[TradingLogic] Сигнал деактивирован после попытки входа.');
        } else {
            logger.info(`❌ [TradingLogic] Условие для входа НЕ выполнено: объем текущей свечи (${completedCandle.volume.toFixed(2)}) > объема сигнальной (${this.currentSignal.candle.volume.toFixed(2)})`);
            logger.info(`🕯️ [TradingLogic] Ожидаем следующую свечу... Сигнал остается активным.`);
        }
    }

    private async openPosition(signalCandle: Candle, currentCandle: Candle): Promise<void> {
        if (this.activePosition) {
            logger.warn("Попытка открыть позицию, когда уже есть активная. Отклонено.");
            return;
        }
        try {
            // Проверяем баланс перед открытием позиции
            const balanceResponse = await this.client.getWalletBalance({ accountType: 'UNIFIED' });
            if (balanceResponse.retCode === 0 && balanceResponse.result?.list?.[0]?.coin) {
                const usdtBalance = balanceResponse.result.list[0].coin.find(c => c.coin === 'USDT');
                if (usdtBalance) {
                    const availableBalance = Number(usdtBalance.availableToWithdraw);
                    logger.info(`💰 Доступный баланс USDT: ${availableBalance.toFixed(2)}, Требуется для позиции: ${this.TRADE_SIZE_USD}`);
                    
                    if (availableBalance < this.TRADE_SIZE_USD) {
                        logger.error(`❌ Недостаточно средств! Доступно: ${availableBalance.toFixed(2)} USDT, требуется: ${this.TRADE_SIZE_USD} USDT`);
                        return;
                    }
                }
            }

            const side: OrderSideV5 = signalCandle.isGreen ? 'Sell' : 'Buy';
            
            const stopLossLevel = side === 'Buy' ? 
                Math.min(signalCandle.low, currentCandle.low) :    
                Math.max(signalCandle.high, currentCandle.high);   

            const stopLoss = side === 'Buy' ? 
                stopLossLevel - this.STOP_LOSS_POINTS :   
                stopLossLevel + this.STOP_LOSS_POINTS;    

            const takeProfit = currentCandle.close + (side === 'Buy' ? 
                this.TAKE_PROFIT_POINTS : 
                -this.TAKE_PROFIT_POINTS);

            const contractSize = (this.TRADE_SIZE_USD / currentCandle.close).toFixed(3);
            const orderPrice = currentCandle.close.toString();

            logger.info(`🎯 Попытка открытия позиции (Лимитный ордер PostOnly):`);
            logger.info(`📈 Направление: ${side}, Цена ордера: ${orderPrice}, ТП: ${takeProfit}, СЛ: ${stopLoss}`);
            logger.info(`📊 Размер контракта: ${contractSize} BTC (${this.TRADE_SIZE_USD} USD)`);

            const response = await this.client.submitOrder({
                category: 'linear',
                symbol: this.SYMBOL,
                side: side,
                orderType: 'Limit',
                qty: contractSize,
                price: orderPrice,
                timeInForce: 'PostOnly',
            });

            logger.info(`📡 Ответ от API при открытии лимитной PostOnly позиции: RetCode=${response.retCode}, RetMsg=${response.retMsg}, OrderId=${response.result?.orderId}`);

            if (response.retCode === 0 && response.result && response.result.orderId) {
                logger.info(`✅ Лимитный ордер PostOnly успешно размещен (orderId: ${response.result.orderId}).`);
                
                this.activePosition = {
                    side: side,
                    entryPrice: currentCandle.close, 
                    entryTime: currentCandle.timestamp,
                    isTrailingActive: false,
                    lastTrailingStopPrice: null,
                    orderId: response.result.orderId 
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
                logger.info(`🛡️ Установка TP/SL: RetCode=${tpSlResponse.retCode}, RetMsg=${tpSlResponse.retMsg}`);

                this.startTrailingStopCheck();

                const message = this.notificationService.formatTradeOpenAlert(this.activePosition, takeProfit, stopLoss, signalCandle, currentCandle, true);
                this.callbacks.onTradeOperation(message);
                logger.info(`✅ Сделка (лимитный ордер) полностью оформлена и уведомление отправлено`);
            } else {
                logger.error(`❌ Лимитный ордер PostOnly не был размещен. Код: ${response.retCode}, сообщение: ${response.retMsg}`);
                if (response.retCode === 110007) {
                    logger.error(`💡 Рекомендация: Пополните счет или уменьшите размер позиции TRADE_SIZE_USD в настройках`);
                }
            }
        } catch (error) {
            logger.error('❌ Ошибка при открытии лимитной позиции:', error);
        }
    }

    public async closePosition(triggeringCandle: Candle, reason: string): Promise<void> {
        if (!this.activePosition) return;

        const positionToClose = { ...this.activePosition };
        this.activePosition = null;
        this.stopTrailingStopCheck();
        
        try {
            const closeSide: OrderSideV5 = positionToClose.side === 'Buy' ? 'Sell' : 'Buy';
            const contractSize = (this.TRADE_SIZE_USD / positionToClose.entryPrice).toFixed(3);

            logger.info(`🎯 Попытка закрытия позиции (Рыночный ордер): ${reason}`);
            logger.info(`📈 Направление закрытия: ${closeSide}, Размер: ${contractSize}`);
            
            const response = await this.client.submitOrder({
                category: 'linear',
                symbol: this.SYMBOL,
                side: closeSide,
                orderType: 'Market',
                qty: contractSize,
                reduceOnly: true
            });
            logger.info(`📡 Ответ от API при закрытии позиции: RetCode=${response.retCode}, RetMsg=${response.retMsg}`);

            if (response.retCode === 0) {
                logger.info(`✅ Позиция успешно закрыта по рынку.`);
                const message = this.notificationService.formatTradeCloseAlert(positionToClose, triggeringCandle.close, reason);
                this.callbacks.onTradeOperation(message);
            } else {
                 logger.error(`❌ Ошибка при закрытии позиции рыночным ордером. Код: ${response.retCode}, сообщение: ${response.retMsg}. Возможно, позиция уже была закрыта.`);
            }
        } catch (error) {
            logger.error('❌ Критическая ошибка при закрытии позиции:', error);
        }
    }
    
    private startTrailingStopCheck(): void {
        this.stopTrailingStopCheck(); 

        this.trailingStopInterval = setInterval(async () => {
            await this.updateTrailingStop();
        }, this.TRAILING_STOP_INTERVAL_MS);
        logger.info(`⏱️ Трейлинг-стоп активирован с интервалом ${this.TRAILING_STOP_INTERVAL_MS / 1000} сек.`);
    }

    private stopTrailingStopCheck(): void {
        if (this.trailingStopInterval) {
            clearInterval(this.trailingStopInterval);
            this.trailingStopInterval = null;
            logger.info('⏱️ Трейлинг-стоп деактивирован.');
        }
    }

    private async updateTrailingStop(): Promise<void> {
        if (!this.activePosition || !this.activePosition.orderId) {
            this.stopTrailingStopCheck();
            return;
        }

        try {
            const response = await this.client.getTickers({ category: 'linear', symbol: this.SYMBOL });

            if (response.retCode === 0 && response.result.list && response.result.list[0]) {
                const currentPrice = Number(response.result.list[0].lastPrice);
                const entryPrice = this.activePosition.entryPrice;
                const side = this.activePosition.side;

                const profitPoints = side === 'Buy' ? currentPrice - entryPrice : entryPrice - currentPrice;

                if (profitPoints >= this.TRAILING_ACTIVATION_POINTS) {
                    const newStopPrice = side === 'Buy' ? 
                        currentPrice - this.TRAILING_DISTANCE : 
                        currentPrice + this.TRAILING_DISTANCE;

                    if (!this.activePosition.isTrailingActive ||
                        (side === 'Buy' && newStopPrice > (this.activePosition.lastTrailingStopPrice || 0)) ||
                        (side === 'Sell' && newStopPrice < (this.activePosition.lastTrailingStopPrice || Infinity))) {
                        
                        let tpSlParams: any = {
                            category: 'linear',
                            symbol: this.SYMBOL,
                            stopLoss: newStopPrice.toString(),
                            slTriggerBy: 'MarkPrice',
                            positionIdx: 0 
                        };

                        if (!this.activePosition.isTrailingActive) {
                            logger.info(this.notificationService.formatTrailingStopActivation());
                            this.callbacks.onTradeOperation(this.notificationService.formatTrailingStopActivation());
                            tpSlParams.takeProfit = '0';
                            tpSlParams.tpTriggerBy = 'MarkPrice';
                            this.activePosition.isTrailingActive = true;
                        }
                        
                        await this.client.setTradingStop(tpSlParams);
                        this.activePosition.lastTrailingStopPrice = newStopPrice;
                        
                        const updateMessage = this.notificationService.formatTrailingStopUpdate(newStopPrice, this.TRAILING_DISTANCE, currentPrice);
                        logger.info(updateMessage);
                        this.callbacks.onTradeOperation(updateMessage);
                    }
                }
            }
        } catch (error) {
            logger.error('❌ Ошибка при обновлении трейлинг-стопа:', error);
        }
    }
} 