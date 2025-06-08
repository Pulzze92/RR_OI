import {
  RestClientV5,
  OrderSideV5,
  LinearInverseInstrumentInfoV5
} from "bybit-api";
import { Candle, VolumeSignal, ActivePosition } from "./bybit.types";
import { NotificationService } from "./notificationService";
import { logger } from "../utils/logger";

export interface TradingLogicCallbacks {
  onTradeOperation: (message: string) => void;
  onSignalDetected: (message: string) => void;
}

export interface TradingLogicOptions {
  symbol: string;
  tradeSizeUsd: number;
  takeProfitPoints: number;
  stopLossPoints: number;
  trailingActivationPoints: number;
  trailingDistance: number;
  volumeThreshold: number;
  useTrailingStop: boolean;
}

export class TradingLogicService {
  private currentSignal: VolumeSignal | null = null;
  private candleHistory: Candle[] = [];
  private readonly usedSignalTimestamps: Set<number> = new Set();
  private activePosition: ActivePosition | null = null;
  private trailingStopCheckInterval: NodeJS.Timeout | null = null;
  private isOpeningPosition: boolean = false;
  private lastSignalNotificationTime: number = 0;
  private lastRestCheckTime: number = 0;
  private readonly REST_CHECK_INTERVAL = 5 * 60 * 1000; // 5 минут
  private hasInitialSync = false;
  private lastPositionOpenTime: number = 0;

  private readonly TAKE_PROFIT_POINTS: number;
  private readonly STOP_LOSS_POINTS: number;
  private readonly TRAILING_ACTIVATION_POINTS: number;
  private readonly TRAILING_DISTANCE: number;
  private readonly VOLUME_THRESHOLD: number;
  private readonly TRADE_SIZE_USD: number;
  private readonly SYMBOL: string;
  private readonly LEVERAGE: number = 25;
  private readonly TRAILING_STOP_INTERVAL_MS = 60000;
  private readonly USE_TRAILING_STOP: boolean;

  constructor(
    private client: RestClientV5,
    private notificationService: NotificationService,
    private callbacks: TradingLogicCallbacks,
    options: TradingLogicOptions
  ) {
    this.SYMBOL = options.symbol;
    this.TRADE_SIZE_USD = options.tradeSizeUsd;
    this.TAKE_PROFIT_POINTS = options.takeProfitPoints;
    this.STOP_LOSS_POINTS = options.stopLossPoints;
    this.TRAILING_ACTIVATION_POINTS = options.trailingActivationPoints;
    this.TRAILING_DISTANCE = options.trailingDistance;
    this.VOLUME_THRESHOLD = options.volumeThreshold;
    this.USE_TRAILING_STOP = options.useTrailingStop;
  }

  public getActivePosition(): ActivePosition | null {
    return this.activePosition;
  }

  public getCurrentSignal(): VolumeSignal | null {
    return this.currentSignal;
  }

  public resetSignal(): void {
    if (this.currentSignal) {
      // На часовом таймфрейме не сохраняем время последнего сигнала
      // this.lastSignalCandleTimestamp = this.currentSignal.candle.timestamp;
      logger.info("🔄 Сигнал отменен из-за отсутствия условий для входа.");
      this.currentSignal = null;
    }
  }

  public setSignal(signal: VolumeSignal | null): void {
    this.currentSignal = signal;
    if (signal) {
      logger.info(
        `🔄 Сигнал установлен: ${new Date(
          signal.candle.timestamp
        ).toLocaleTimeString()}, V=${signal.candle.volume.toFixed(2)}`
      );
    } else {
      logger.info("🔄 Сигнал сброшен");
    }
  }

  public async syncPositionState(candleHistory: Candle[] = []): Promise<void> {
    try {
      // Сохраняем историю свечей
      this.candleHistory = [...candleHistory];

      // Проверяем только при запуске бота
      if (!this.hasInitialSync) {
        const positionsResponse = await this.client.getPositionInfo({
          category: "linear",
          symbol: this.SYMBOL
        });

        if (positionsResponse.retCode === 0 && positionsResponse.result?.list) {
          const openPositions = positionsResponse.result.list.filter(
            pos => Number(pos.size) > 0
          );

          if (openPositions.length > 0) {
            const position = openPositions[0];
            // Проверяем, не является ли это нашей только что открытой позицией
            if (
              Date.now() - this.lastPositionOpenTime < 5000 &&
              this.activePosition &&
              this.activePosition.side === position.side &&
              Math.abs(
                Number(position.avgPrice) - this.activePosition.entryPrice
              ) < 0.1
            ) {
              logger.info(
                "⚠️ Пропускаем усыновление - это наша недавно открытая позиция"
              );
              return;
            }
            const positionSize = position.size;
            const currentPrice = Number(position.markPrice);
            const side = position.side;
            const entryPrice = Number(position.avgPrice);

            logger.info(`🔄 УСЫНОВЛЕНИЕ СУЩЕСТВУЮЩЕЙ ПОЗИЦИИ:`);
            logger.info(`    Размер: ${positionSize} ${position.symbol}`);
            logger.info(`   📈 Сторона: ${side}`);
            logger.info(`   💰 Средняя цена входа: ${entryPrice}`);
            logger.info(`   💹 Текущая P&L: ${position.unrealisedPnl} USDT`);

            // Получаем текущие TP/SL
            let currentTakeProfit: number | undefined;
            let currentStopLoss: number | undefined;
            let isTrailingActive = false;

            // Проверяем профит для активации трейлинга
            const profitPoints =
              side === "Buy"
                ? currentPrice - entryPrice
                : entryPrice - currentPrice;

            // Ищем последний сигнал для установки стоп-лосса
            let stopLossLevel = currentPrice;
            let foundSignal = false;

            // Берем последние две свечи из истории
            if (this.candleHistory.length >= 2) {
              const lastCandle = this.candleHistory[
                this.candleHistory.length - 1
              ];
              const prevCandle = this.candleHistory[
                this.candleHistory.length - 2
              ];

              // Проверяем объем для определения сигнальной свечи
              if (prevCandle.volume > this.VOLUME_THRESHOLD) {
                foundSignal = true;
                stopLossLevel =
                  side === "Buy"
                    ? Math.min(prevCandle.low, lastCandle.low)
                    : Math.max(prevCandle.high, lastCandle.high);
              }
            }

            // Устанавливаем стоп-лосс
            const stopLoss =
              side === "Buy"
                ? foundSignal
                  ? stopLossLevel - this.STOP_LOSS_POINTS
                  : currentPrice - this.STOP_LOSS_POINTS
                : foundSignal
                ? stopLossLevel + this.STOP_LOSS_POINTS
                : currentPrice + this.STOP_LOSS_POINTS;

            // Рассчитываем тейк-профит от текущей цены
            const takeProfit =
              currentPrice +
              (side === "Buy"
                ? this.TAKE_PROFIT_POINTS
                : -this.TAKE_PROFIT_POINTS);

            // Отменяем все существующие ордера
            try {
              const activeOrders = await this.client.getActiveOrders({
                category: "linear",
                symbol: this.SYMBOL
              });

              if (activeOrders.retCode === 0 && activeOrders.result?.list) {
                for (const order of activeOrders.result.list) {
                  if (order.reduceOnly) {
                    await this.client.cancelOrder({
                      category: "linear",
                      symbol: this.SYMBOL,
                      orderId: order.orderId
                    });
                    logger.info(
                      `✅ Отменен существующий ордер: ${order.orderId}`
                    );
                  }
                }
              }
            } catch (error) {
              logger.error("❌ Ошибка при отмене существующих ордеров:", error);
            }

            // Устанавливаем новый TP
            const tpResponse = await this.client.submitOrder({
              category: "linear",
              symbol: this.SYMBOL,
              side: side === "Buy" ? "Sell" : "Buy",
              orderType: "Limit",
              qty: positionSize.toString(),
              price: takeProfit.toString(),
              triggerPrice: takeProfit.toString(),
              triggerDirection: side === "Buy" ? 1 : 2,
              timeInForce: "GTC",
              triggerBy: "MarkPrice",
              reduceOnly: true,
              orderLinkId: `tp_${Date.now()}`
            });

            // Устанавливаем новый SL
            const slResponse = await this.client.submitOrder({
              category: "linear",
              symbol: this.SYMBOL,
              side: side === "Buy" ? "Sell" : "Buy",
              orderType: "Limit",
              qty: positionSize.toString(),
              price: stopLoss.toString(),
              triggerPrice: stopLoss.toString(),
              triggerDirection: side === "Buy" ? 2 : 1,
              timeInForce: "GTC",
              triggerBy: "MarkPrice",
              reduceOnly: true,
              orderLinkId: `sl_${Date.now()}`
            });

            if (tpResponse.retCode === 0 && slResponse.retCode === 0) {
              logger.info(
                `✅ Установлены новые уровни TP=${takeProfit.toFixed(
                  2
                )}, SL=${stopLoss.toFixed(2)}`
              );
            } else {
              logger.error(
                `❌ Ошибка при установке новых уровней: TP=${tpResponse.retMsg}, SL=${slResponse.retMsg}`
              );
            }

            // Проверяем условия для активации трейлинга
            isTrailingActive =
              this.USE_TRAILING_STOP &&
              profitPoints >= this.TRAILING_ACTIVATION_POINTS;

            this.activePosition = {
              side: side as any,
              entryPrice: entryPrice,
              entryTime: Date.now(),
              isTrailingActive: isTrailingActive,
              lastTrailingStopPrice: stopLoss,
              orderId: "",
              plannedTakeProfit: takeProfit,
              plannedStopLoss: stopLoss,
              executionNotificationSent: true
            };

            // Отправляем уведомление об усыновлении
            const adoptMessage = this.formatPositionAdoptedAlert(position);
            await this.callbacks.onTradeOperation(adoptMessage);

            // Запускаем трейлинг-стоп для существующей позиции только если он должен быть активен
            if (isTrailingActive) {
              logger.info(
                `🚀 Трейлинг-стоп активирован при усыновлении (профит: ${profitPoints.toFixed(
                  2
                )} пунктов)`
              );
              this.startTrailingStopCheck();
            } else {
              logger.info(
                `ℹ️ Трейлинг-стоп не активирован (профит: ${profitPoints.toFixed(
                  2
                )} пунктов, требуется: ${this.TRAILING_ACTIVATION_POINTS})`
              );
            }
          } else {
            logger.info("✅ Открытых позиций не найдено, состояние чистое");
          }
        }
        this.hasInitialSync = true;
      }
    } catch (error) {
      logger.error("❌ Ошибка при синхронизации состояния позиций:", error);
    }
  }

  private formatPositionAdoptedAlert(position: any): string {
    const side = position.side === "Buy" ? "ШОРТ" : "ЛОНГ";
    const pnl = Number(position.unrealisedPnl);
    const pnlEmoji = pnl >= 0 ? "📈" : "📉";
    const pnlText = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);

    let message = `🔄 ПОЗИЦИЯ УСЫНОВЛЕНА\n\n`;
    message += `📊 Направление: ${side}\n`;
    message += `💰 Размер: ${position.size} BTC\n`;
    message += `📈 Цена входа: ${position.avgPrice}\n`;
    message += `💹 Текущая P&L: ${pnlEmoji} ${pnlText} USDT\n`;

    // Добавляем больше информации о позиции
    message += `\n📊 Дополнительная информация:\n`;
    message += `⚡️ Ликвидационная цена: ${position.liqPrice || "Н/Д"}\n`;
    message += `💵 Маржа позиции: ${position.positionMargin || "Н/Д"} USDT\n`;
    message += `📅 Время создания: ${new Date().toLocaleString()}\n`;

    if (position.takeProfit && Number(position.takeProfit) > 0) {
      message += `🎯 Take Profit: ${position.takeProfit}\n`;
    }

    if (position.stopLoss && Number(position.stopLoss) > 0) {
      message += `🛡️ Stop Loss: ${position.stopLoss}\n`;
    }

    message += `\n⏱️ Трейлинг-стоп будет активирован при прибыли > 300 пунктов`;

    return message;
  }

  private cleanupOldSignals(oldestCandleTimestamp: number): void {
    // Очищаем сигналы старше 24 часов
    const MAX_SIGNAL_AGE = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах
    const now = Date.now();

    // Очищаем старые сигналы из множества использованных
    for (const timestamp of this.usedSignalTimestamps) {
      if (now - timestamp > MAX_SIGNAL_AGE) {
        this.usedSignalTimestamps.delete(timestamp);
      }
    }

    // Если текущий сигнал слишком старый - сбрасываем его
    if (
      this.currentSignal &&
      now - this.currentSignal.candle.timestamp > MAX_SIGNAL_AGE
    ) {
      logger.info(
        `🧹 Сброс устаревшего сигнала от ${new Date(
          this.currentSignal.candle.timestamp
        ).toLocaleTimeString()}`
      );
      this.currentSignal = null;
    }
  }

  public checkVolumeSpike(
    completedCandle: Candle,
    previousCandle: Candle
  ): void {
    // Очищаем старые сигналы перед проверкой новых
    this.cleanupOldSignals(
      Math.min(completedCandle.timestamp, previousCandle.timestamp)
    );

    // Проверяем наличие активной позиции
    if (this.activePosition) {
      logger.info(
        `🔄 ПРОПУСК ПРОВЕРКИ ОБЪЕМА: Есть активная ${this.activePosition.side} позиция`
      );
      return;
    }

    // Проверяем, что обе свечи подтверждены
    if (!completedCandle.confirmed || !previousCandle.confirmed) {
      logger.info(`⏳ ПРОПУСК ПРОВЕРКИ ОБЪЕМА: Есть неподтвержденные свечи`);
      return;
    }

    // Проверяем, что свечи идут последовательно
    if (previousCandle.timestamp >= completedCandle.timestamp) {
      logger.info(`⚠️ ПРОПУСК ПРОВЕРКИ ОБЪЕМА: Свечи идут не по порядку`);
      return;
    }

    // Проверяем, что это действительно последние две закрытые свечи
    const now = Date.now();
    const fourHours = 4 * 60 * 60 * 1000;
    if (now - completedCandle.timestamp > fourHours * 2) {
      logger.info(`⚠️ ПРОПУСК ПРОВЕРКИ ОБЪЕМА: Свечи слишком старые`);
      return;
    }

    logger.info(`📊 АНАЛИЗ ОБЪЕМОВ ЗАКРЫТЫХ СВЕЧЕЙ:`);
    logger.info(
      `   📈 Последняя закрытая (${new Date(
        completedCandle.timestamp
      ).toLocaleTimeString()}): V=${completedCandle.volume.toFixed(2)}, ${
        completedCandle.isGreen ? "🟢" : "🔴"
      }`
    );
    logger.info(
      `   📈 Предпоследняя закрытая (${new Date(
        previousCandle.timestamp
      ).toLocaleTimeString()}): V=${previousCandle.volume.toFixed(2)}, ${
        previousCandle.isGreen ? "🟢" : "🔴"
      }`
    );
    logger.info(`   🎯 Порог объема: ${this.VOLUME_THRESHOLD}`);

    // Проверяем не был ли этот сигнал уже использован
    if (this.usedSignalTimestamps.has(previousCandle.timestamp)) {
      logger.info(
        `⚠️ ПРОПУСК: Сигнал от ${new Date(
          previousCandle.timestamp
        ).toLocaleTimeString()} уже был обработан`
      );
      return;
    }

    // Проверяем объем предпоследней закрытой свечи
    if (previousCandle.volume >= this.VOLUME_THRESHOLD) {
      logger.info(
        `🚨 ОБНАРУЖЕН СИГНАЛ: ВЫСОКИЙ ОБЪЕМ (${previousCandle.volume.toFixed(
          2
        )}) В СВЕЧЕ ${new Date(previousCandle.timestamp).toLocaleTimeString()}!`
      );
      logger.info(`💰 Цена закрытия: ${previousCandle.close}`);
      logger.info(
        `📊 Цвет свечи: ${previousCandle.isGreen ? "🟢 Зеленая" : "🔴 Красная"}`
      );

      this.currentSignal = {
        candle: previousCandle,
        isActive: true,
        waitingForLowerVolume: true
      };
      this.usedSignalTimestamps.add(previousCandle.timestamp);

      // Проверяем последнюю закрытую свечу как подтверждающую
      if (completedCandle.volume <= previousCandle.volume) {
        logger.info(
          `✅ ПОДТВЕРЖДЕНИЕ: Последняя закрытая свеча имеет меньший объем`
        );
        logger.info(
          `⚡️ ГОТОВЫ К ВХОДУ В ${previousCandle.isGreen ? "ЛОНГ" : "ШОРТ"}`
        );
      }
    }
  }

  public async processCompletedCandle(
    completedCandle: Candle,
    candleHistory: Candle[]
  ): Promise<void> {
    // Проверяем наличие активной позиции
    if (this.activePosition) {
      logger.info(
        `🔄 ПРОПУСК ОБРАБОТКИ СВЕЧИ: Есть активная ${this.activePosition.side} позиция`
      );
      return;
    }

    // Проверяем наличие открытых позиций через API
    try {
      const positionsResponse = await this.client.getPositionInfo({
        category: "linear",
        symbol: this.SYMBOL
      });

      if (positionsResponse.retCode === 0 && positionsResponse.result?.list) {
        const openPositions = positionsResponse.result.list.filter(
          pos => Number(pos.size) > 0
        );

        if (openPositions.length > 0) {
          logger.info(
            `🔄 ПРОПУСК ОБРАБОТКИ СВЕЧИ: Обнаружена открытая позиция через API`
          );
          return;
        }
      }
    } catch (error) {
      logger.error("❌ Ошибка при проверке открытых позиций:", error);
      return;
    }

    if (!this.currentSignal?.isActive) {
      logger.info(`⏳ ПРОПУСК ОБРАБОТКИ: Нет активного сигнала`);
      return;
    }

    // НОВОЕ ЛОГИРОВАНИЕ - Подробная диагностика
    logger.info(`\n🔍 ДИАГНОСТИКА ОБРАБОТКИ СВЕЧИ:`);
    logger.info(
      `   ⏰ Время обрабатываемой свечи: ${new Date(
        completedCandle.timestamp
      ).toLocaleTimeString()}`
    );
    logger.info(
      `   ⏰ Время сигнальной свечи: ${new Date(
        this.currentSignal.candle.timestamp
      ).toLocaleTimeString()}`
    );
    logger.info(`   📊 Сигнал активен: ${this.currentSignal.isActive}`);
    logger.info(
      `   📊 Ожидание меньшего объема: ${this.currentSignal.waitingForLowerVolume}`
    );
    logger.info(`   📊 Объем текущей свечи: ${completedCandle.volume}`);
    logger.info(
      `   📊 Объем сигнальной свечи: ${this.currentSignal.candle.volume}`
    );

    // Проверяем, что текущая свеча новее сигнальной
    if (completedCandle.timestamp <= this.currentSignal.candle.timestamp) {
      logger.info(
        `⚠️ ПРОПУСК ОБРАБОТКИ: Текущая свеча (${new Date(
          completedCandle.timestamp
        ).toLocaleTimeString()}) старше или равна сигнальной (${new Date(
          this.currentSignal.candle.timestamp
        ).toLocaleTimeString()})`
      );
      return;
    }

    // Проверяем что свеча подтверждена
    if (!completedCandle.confirmed) {
      logger.info(`⏳ Ждем подтверждения текущей свечи`);
      return;
    }

    logger.info(`📊 ПРОВЕРКА ПОДТВЕРЖДАЮЩЕЙ СВЕЧИ:`);
    logger.info(`   📈 Объем текущей: ${completedCandle.volume.toFixed(2)}`);
    logger.info(
      `   📊 Объем сигнальной: ${this.currentSignal.candle.volume.toFixed(2)}`
    );

    // Если объем текущей свечи больше сигнальной - обновляем сигнал
    if (completedCandle.volume > this.currentSignal.candle.volume) {
      // Проверяем, не был ли сигнал уже подтвержден
      if (this.currentSignal.waitingForLowerVolume) {
        logger.info(`🔄 ОБНОВЛЕНИЕ СИГНАЛА: Найдена свеча с большим объемом`);
        logger.info(
          `   📊 Старый объем: ${this.currentSignal.candle.volume.toFixed(2)}`
        );
        logger.info(`   📊 Новый объем: ${completedCandle.volume.toFixed(2)}`);

        this.currentSignal = {
          candle: completedCandle,
          isActive: true,
          waitingForLowerVolume: true
        };
        this.usedSignalTimestamps.add(completedCandle.timestamp);
      } else {
        logger.info(
          `⏳ ПРОПУСК ОБНОВЛЕНИЯ: Сигнал уже подтвержден и готов к входу`
        );
      }
    }
    // Если объем текущей свечи меньше сигнальной - входим в позицию
    else if (completedCandle.volume <= this.currentSignal.candle.volume) {
      logger.info(`✅ ПОДТВЕРЖДЕНИЕ: Найдена свеча с меньшим объемом`);
      logger.info(`🎯 ВХОДИМ В ПОЗИЦИЮ СРАЗУ ПОСЛЕ ПОДТВЕРЖДАЮЩЕЙ СВЕЧИ`);
      logger.info(
        `   📊 Сигнальная свеча: ${new Date(
          this.currentSignal.candle.timestamp
        ).toLocaleTimeString()}, ${
          this.currentSignal.candle.isGreen ? "🟢" : "🔴"
        }`
      );
      logger.info(
        `   📊 Текущая свеча: ${new Date(
          completedCandle.timestamp
        ).toLocaleTimeString()}`
      );

      // НОВОЕ ЛОГИРОВАНИЕ - Перед попыткой входа
      logger.info(`\n🚀 ПОПЫТКА ВХОДА В ПОЗИЦИЮ:`);
      logger.info(`   📊 Состояние сигнала перед входом:`);
      logger.info(`   - isActive: ${this.currentSignal.isActive}`);
      logger.info(
        `   - waitingForLowerVolume: ${this.currentSignal.waitingForLowerVolume}`
      );
      logger.info(
        `   - Направление: ${
          this.currentSignal.candle.isGreen ? "ШОРТ" : "ЛОНГ"
        }`
      );

      // Отмечаем, что сигнал подтвержден и больше не ждем свечу с меньшим объемом
      this.currentSignal.waitingForLowerVolume = false;

      // НОВОЕ ЛОГИРОВАНИЕ - Вызов openPosition
      logger.info(`   🎯 Вызываем openPosition...`);
      const positionOpened = await this.openPosition(
        this.currentSignal.candle,
        completedCandle
      );

      // НОВОЕ ЛОГИРОВАНИЕ - Результат открытия позиции
      logger.info(
        `   📊 Результат открытия позиции: ${
          positionOpened ? "✅ УСПЕШНО" : "❌ НЕУДАЧА"
        }`
      );

      // Деактивируем сигнал ТОЛЬКО если позиция успешно открыта
      if (positionOpened && this.currentSignal) {
        this.currentSignal.isActive = false;
        logger.info("✅ Сигнал деактивирован после успешного входа в позицию.");
      } else {
        logger.info(
          "⚠️ Сигнал остается активным, т.к. не удалось открыть позицию."
        );
      }
    }
  }

  private async openPosition(
    signalCandle: Candle,
    currentCandle: Candle
  ): Promise<boolean> {
    logger.info(`\n🔍 НАЧАЛО ПРОЦЕССА ОТКРЫТИЯ ПОЗИЦИИ:`);

    if (this.activePosition) {
      logger.warn(
        "⚠️ Уже есть активная позиция. Отмена открытия новой позиции."
      );
      return false;
    }

    if (this.isOpeningPosition) {
      logger.warn(
        "⏳ Уже выполняется открытие позиции. Пропускаем дублирующую попытку."
      );
      return false;
    }

    this.isOpeningPosition = true;
    logger.info("🔒 Блокируем множественные попытки открытия позиции");

    try {
      // Проверяем баланс перед открытием позиции
      logger.info("💰 Запрашиваем баланс USDT...");
      const balanceResponse = await this.client.getWalletBalance({
        accountType: "UNIFIED"
      });

      logger.info(`📊 Ответ баланса: ${JSON.stringify(balanceResponse)}`);

      if (balanceResponse.retCode !== 0) {
        logger.error(`❌ Ошибка получения баланса: ${balanceResponse.retMsg}`);
        this.isOpeningPosition = false;
        return false;
      }

      if (!balanceResponse.result?.list?.[0]?.coin) {
        logger.error("❌ Некорректный формат ответа баланса");
        logger.info(
          `📊 Полный ответ баланса: ${JSON.stringify(balanceResponse, null, 2)}`
        );
        this.isOpeningPosition = false;
        return false;
      }

      const usdtBalance = balanceResponse.result.list[0].coin.find(
        c => c.coin === "USDT"
      );

      if (!usdtBalance) {
        logger.error("❌ Баланс USDT не найден в ответе");
        logger.info(
          `📊 Доступные монеты: ${balanceResponse.result.list[0].coin
            .map(c => `${c.coin}: ${c.equity} (${c.walletBalance})`)
            .join(", ")}`
        );
        this.isOpeningPosition = false;
        return false;
      }

      const availableBalance = Number(usdtBalance.equity);
      logger.info(
        `💰 Баланс USDT: Доступно=${availableBalance.toFixed(
          2
        )}, Всего=${Number(usdtBalance.walletBalance).toFixed(2)}`
      );

      // Получаем информацию о плече для расчета необходимой маржи
      logger.info("🔧 Запрашиваем информацию о плече...");
      const instrumentResponse = await this.client.getInstrumentsInfo({
        category: "linear",
        symbol: this.SYMBOL
      });

      let requiredMargin = this.TRADE_SIZE_USD;
      if (
        instrumentResponse.retCode === 0 &&
        instrumentResponse.result?.list?.[0]
      ) {
        const leverage =
          Number(
            instrumentResponse.result.list[0].leverageFilter?.maxLeverage
          ) || 1;
        requiredMargin =
          this.TRADE_SIZE_USD / Math.min(leverage, this.LEVERAGE);
        logger.info(
          `🔧 Доступное плечо: ${leverage}x, Используем: ${Math.min(
            leverage,
            this.LEVERAGE
          )}x`
        );
      }

      logger.info(
        `💰 Доступный баланс USDT: ${availableBalance.toFixed(
          2
        )}, Требуется маржи: ${requiredMargin.toFixed(2)}`
      );

      if (availableBalance < requiredMargin) {
        logger.error(
          `❌ Недостаточно средств! Доступно: ${availableBalance.toFixed(
            2
          )} USDT, требуется: ${requiredMargin.toFixed(2)} USDT`
        );
        this.isOpeningPosition = false;
        return false;
      }

      // КРИТИЧЕСКИ ВАЖНАЯ ДИАГНОСТИКА НАПРАВЛЕНИЯ СДЕЛКИ ДЛЯ VSA
      logger.info(`\n🔍 АНАЛИЗ НАПРАВЛЕНИЯ СДЕЛКИ (VSA логика):`);
      logger.info(
        `   ⏰ Время сигнальной свечи: ${new Date(
          signalCandle.timestamp
        ).toLocaleTimeString()}`
      );
      logger.info(
        `   ⏰ Время подтверждающей свечи: ${new Date(
          currentCandle.timestamp
        ).toLocaleTimeString()}`
      );
      logger.info(
        `   📊 Сигнальная свеча: Open=${signalCandle.open} → Close=${
          signalCandle.close
        } (${signalCandle.isGreen ? "🟢" : "🔴"})`
      );
      logger.info(
        `   📊 Подтверждающая свеча: Open=${currentCandle.open} → Close=${
          currentCandle.close
        } (${currentCandle.isGreen ? "🟢" : "🔴"})`
      );

      // Определяем направление на основе цвета сигнальной свечи
      // Красная свеча = Buy (ЛОНГ), Зеленая свеча = Sell (ШОРТ)
      const side: OrderSideV5 = signalCandle.isGreen ? "Sell" : "Buy";
      logger.info(
        `   🎯 ВЫБРАННОЕ НАПРАВЛЕНИЕ: ${side} (${
          side === "Buy" ? "ЛОНГ" : "ШОРТ"
        })`
      );
      logger.info(
        `   📊 Причина: ${
          signalCandle.isGreen ? "Зеленая" : "Красная"
        } свеча = ${side === "Buy" ? "ЛОНГ" : "ШОРТ"}`
      );

      // Верификация VSA логики
      const vsaLogicCheck = this.verifyVSALogic(signalCandle, side);
      if (!vsaLogicCheck.isValid) {
        logger.error(`🚫 ОШИБКА VSA ЛОГИКИ: ${vsaLogicCheck.error}`);
        logger.error(`🚫 СДЕЛКА ОТМЕНЕНА ДЛЯ БЕЗОПАСНОСТИ!`);
        this.isOpeningPosition = false;
        return false;
      }

      // Получаем текущую рыночную цену
      logger.info("💹 Запрашиваем текущую рыночную цену...");
      const tickerResponse = await this.client.getTickers({
        category: "linear",
        symbol: this.SYMBOL
      });

      let orderPrice = currentCandle.close;
      let currentMarketPrice = currentCandle.close;

      if (tickerResponse.retCode === 0 && tickerResponse.result?.list?.[0]) {
        currentMarketPrice = Number(tickerResponse.result.list[0].lastPrice);
        // Делаем небольшой отступ для быстрого исполнения
        orderPrice =
          side === "Buy"
            ? currentMarketPrice + 0.01 // Buy выше рынка на 1 пункт
            : currentMarketPrice - 0.01; // Sell ниже рынка на 1 пункт

        logger.info(
          `📊 Рыночная цена: ${currentMarketPrice}, Цена ордера: ${orderPrice}`
        );
      }

      const stopLossLevel =
        side === "Buy"
          ? Math.min(signalCandle.low, currentCandle.low)
          : Math.max(signalCandle.high, currentCandle.high);

      const stopLoss =
        side === "Buy"
          ? stopLossLevel - this.STOP_LOSS_POINTS
          : stopLossLevel + this.STOP_LOSS_POINTS;

      // Рассчитываем тейк-профит от рыночной цены
      const takeProfit =
        currentMarketPrice +
        (side === "Buy" ? this.TAKE_PROFIT_POINTS : -this.TAKE_PROFIT_POINTS);

      logger.info(`\n📊 РАСЧЕТ УРОВНЕЙ:`);
      logger.info(`   💰 Рыночная цена: ${currentMarketPrice}`);
      logger.info(`   💰 Цена входа: ${orderPrice}`);
      logger.info(
        `   🎯 Take Profit: ${takeProfit.toFixed(2)} (${
          side === "Buy" ? "+" : "-"
        }${this.TAKE_PROFIT_POINTS} пунктов от рыночной цены)`
      );
      logger.info(
        `   🛡️ Stop Loss: ${stopLoss.toFixed(2)} (${
          this.STOP_LOSS_POINTS
        } пунктов от ${side === "Buy" ? "минимума" : "максимума"} свечей)`
      );

      // Рассчитываем размер позиции с учетом минимального шага
      const rawSize = this.TRADE_SIZE_USD / orderPrice;
      const qtyStep = 0.1; // Минимальный шаг для BTC
      const minQty = 0.1; // Минимальный размер для BTC
      const steps = Math.floor(rawSize / qtyStep);
      const contractSize = Math.max(steps * qtyStep, minQty).toFixed(1);

      logger.info(
        `💰 Расчет размера позиции: $${this.TRADE_SIZE_USD} / ${orderPrice} = ${rawSize} → ${contractSize}`
      );

      // Создаем лимитный ордер на вход
      logger.info("\n🚀 РАЗМЕЩАЕМ ВХОДНОЙ ОРДЕР:");
      const orderResponse = await this.client.submitOrder({
        category: "linear",
        symbol: this.SYMBOL,
        side: side,
        orderType: "Limit",
        qty: contractSize,
        price: orderPrice.toString(),
        timeInForce: "GTC",
        positionIdx: 0,
        orderLinkId: `entry_${Date.now()}`
      });

      logger.info(
        `📊 Ответ на размещение ордера: ${JSON.stringify(orderResponse)}`
      );

      if (orderResponse.retCode !== 0) {
        logger.error(
          `❌ Ошибка при установке входного ордера: ${orderResponse.retMsg}`
        );
        this.isOpeningPosition = false;
        return false;
      }

      const orderId = orderResponse.result?.orderId;
      if (!orderId) {
        logger.error("❌ Не получен ID ордера");
        this.isOpeningPosition = false;
        return false;
      }

      logger.info(
        `✅ Размещен лимитный ордер ${orderId} на ${side} по цене ${orderPrice}`
      );

      // Ждем исполнения ордера
      let orderFilled = false;
      let attempts = 0;
      const maxAttempts = 10;
      const checkInterval = 1000; // 1 секунда

      logger.info("\n⏳ ОЖИДАЕМ ИСПОЛНЕНИЯ ОРДЕРА:");
      while (!orderFilled && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        attempts++;

        const orderStatus = await this.client.getHistoricOrders({
          category: "linear",
          symbol: this.SYMBOL,
          orderId: orderId
        });

        logger.info(
          `   📊 Попытка ${attempts}/${maxAttempts}: ${JSON.stringify(
            orderStatus
          )}`
        );

        if (orderStatus.retCode === 0 && orderStatus.result?.list?.[0]) {
          const order = orderStatus.result.list[0];

          if (order.orderStatus === "Filled") {
            orderFilled = true;
            logger.info(
              `✅ Ордер ${orderId} исполнен по цене ${order.avgPrice}`
            );

            // Устанавливаем TP/SL только после исполнения входного ордера
            logger.info("\n🎯 УСТАНАВЛИВАЕМ TP/SL:");
            const tpResponse = await this.client.submitOrder({
              category: "linear",
              symbol: this.SYMBOL,
              side: side === "Buy" ? "Sell" : "Buy",
              orderType: "Limit",
              qty: order.cumExecQty,
              price: takeProfit.toString(),
              triggerPrice: takeProfit.toString(),
              triggerDirection: side === "Buy" ? 1 : 2,
              timeInForce: "GTC",
              triggerBy: "MarkPrice",
              reduceOnly: true,
              orderLinkId: `tp_${Date.now()}`
            });

            const slResponse = await this.client.submitOrder({
              category: "linear",
              symbol: this.SYMBOL,
              side: side === "Buy" ? "Sell" : "Buy",
              orderType: "Limit",
              qty: order.cumExecQty,
              price: stopLoss.toString(),
              triggerPrice: stopLoss.toString(),
              triggerDirection: side === "Buy" ? 2 : 1,
              timeInForce: "GTC",
              triggerBy: "MarkPrice",
              reduceOnly: true,
              orderLinkId: `sl_${Date.now()}`
            });

            logger.info(
              `   📊 Ответ на установку TP: ${JSON.stringify(tpResponse)}`
            );
            logger.info(
              `   📊 Ответ на установку SL: ${JSON.stringify(slResponse)}`
            );

            if (tpResponse.retCode === 0 && slResponse.retCode === 0) {
              // Создаем запись о позиции только после успешного исполнения
              this.activePosition = {
                side: side,
                entryPrice: Number(order.avgPrice),
                entryTime: Date.now(),
                isTrailingActive: false,
                lastTrailingStopPrice: stopLoss,
                orderId: orderId,
                plannedTakeProfit: takeProfit,
                plannedStopLoss: stopLoss,
                executionNotificationSent: false
              };

              // Отправляем уведомление об открытии позиции
              const openPositionMessage = this.notificationService.formatTradeOpenAlert(
                this.activePosition,
                takeProfit,
                stopLoss,
                signalCandle,
                currentCandle,
                false,
                side
              );
              await this.callbacks.onTradeOperation(openPositionMessage);

              // Обновляем время открытия позиции
              this.lastPositionOpenTime = Date.now();

              // Запускаем проверку трейлинг-стопа
              this.startTrailingStopCheck();

              this.isOpeningPosition = false;
              return true;
            } else {
              logger.error(
                `❌ Ошибка при установке TP/SL: TP=${tpResponse.retMsg}, SL=${slResponse.retMsg}`
              );
            }
          } else if (
            order.orderStatus === "Cancelled" ||
            order.orderStatus === "Rejected"
          ) {
            logger.error(
              `❌ Ордер ${orderId} отменен/отклонен: ${order.orderStatus}`
            );
            break;
          }
        }

        logger.info(
          `⏳ Ожидание исполнения ордера ${orderId}, попытка ${attempts}/${maxAttempts}`
        );
      }

      if (!orderFilled) {
        logger.error(
          `❌ Ордер ${orderId} не исполнен после ${maxAttempts} попыток, отменяем`
        );
        await this.client.cancelOrder({
          category: "linear",
          symbol: this.SYMBOL,
          orderId: orderId
        });
      }

      this.isOpeningPosition = false;
      return orderFilled;
    } catch (error) {
      logger.error("❌ Ошибка при открытии позиции:", error);
      this.isOpeningPosition = false;
      return false;
    }
  }

  private verifyVSALogic(
    signalCandle: Candle,
    side: OrderSideV5
  ): { isValid: boolean; error?: string } {
    // Реализация проверки VSA логики
    // Возвращаем объект с флагом isValid и, возможно, строкой с ошибкой
    return { isValid: true };
  }

  public finishInitialHistoryAnalysis(): void {
    // После завершения исторического анализа проверяем возраст сигнала
    if (this.currentSignal?.isActive) {
      const signalAge = Date.now() - this.currentSignal.candle.timestamp;
      const MAX_INITIAL_SIGNAL_AGE = 8 * 60 * 60 * 1000; // 8 часов

      if (signalAge > MAX_INITIAL_SIGNAL_AGE) {
        logger.info(
          `🧹 Сброс устаревшего исторического сигнала от ${new Date(
            this.currentSignal.candle.timestamp
          ).toLocaleTimeString()}`
        );
        this.currentSignal = null;
      } else {
        logger.info(
          `🎯 Начальный анализ завершен с активным сигналом от свечи ${new Date(
            this.currentSignal.candle.timestamp
          ).toLocaleTimeString()}`
        );
      }
    }
    logger.info(
      "✅ Начальный анализ истории завершен, система готова к торговле"
    );
  }

  private async startTrailingStopCheck(): Promise<void> {
    // Если трейлинг отключен в настройках, не запускаем проверку
    if (!this.USE_TRAILING_STOP) {
      return;
    }

    if (this.trailingStopCheckInterval) {
      clearInterval(this.trailingStopCheckInterval);
    }

    this.trailingStopCheckInterval = setInterval(async () => {
      await this.checkPositionState();
    }, this.TRAILING_STOP_INTERVAL_MS);
  }

  private async checkPositionState(): Promise<void> {
    try {
      // Проверяем текущее состояние позиции
      const positionsResponse = await this.client.getPositionInfo({
        category: "linear",
        symbol: this.SYMBOL
      });

      if (positionsResponse.retCode === 0 && positionsResponse.result?.list) {
        const openPositions = positionsResponse.result.list.filter(
          pos => Number(pos.size) > 0
        );

        // Если нет открытых позиций, но у нас есть активная позиция в состоянии
        if (openPositions.length === 0 && this.activePosition) {
          logger.info("🔄 Позиция закрыта, отменяем оставшиеся ордера");

          // Отменяем все оставшиеся ордера
          try {
            const activeOrders = await this.client.getActiveOrders({
              category: "linear",
              symbol: this.SYMBOL
            });

            if (activeOrders.retCode === 0 && activeOrders.result?.list) {
              for (const order of activeOrders.result.list) {
                if (order.reduceOnly) {
                  try {
                    await this.client.cancelOrder({
                      category: "linear",
                      symbol: this.SYMBOL,
                      orderId: order.orderId
                    });
                    logger.info(`✅ Отменен ордер ${order.orderId}`);
                  } catch (cancelError) {
                    logger.error(
                      `❌ Ошибка при отмене ордера ${order.orderId}:`,
                      cancelError
                    );
                  }
                }
              }
            }
          } catch (error) {
            logger.error("❌ Ошибка при отмене оставшихся ордеров:", error);
          }

          // Получаем цену закрытия из последней сделки
          const tradesResponse = await this.client.getClosedPnL({
            category: "linear",
            symbol: this.SYMBOL,
            limit: 1
          });

          let closePrice = 0;
          let closeReason = "Неизвестно";

          if (
            tradesResponse.retCode === 0 &&
            tradesResponse.result?.list?.[0]
          ) {
            closePrice = Number(tradesResponse.result.list[0].avgExitPrice);
            closeReason = "Позиция закрыта";
          }

          // Отправляем уведомление о закрытии позиции
          const closePositionMessage = this.notificationService.formatTradeCloseAlert(
            this.activePosition,
            closePrice,
            closeReason
          );
          await this.callbacks.onTradeOperation(closePositionMessage);

          // Сбрасываем состояние
          this.activePosition = null;
          this.stopTrailingStopCheck();
          logger.info(
            "✅ Состояние позиции сброшено, бот готов к новым сигналам"
          );
          return;
        }

        // Проверяем активацию трейлинга для существующей позиции
        if (openPositions.length > 0 && this.activePosition) {
          const position = openPositions[0];
          const currentPrice = Number(position.markPrice);
          const entryPrice = Number(position.avgPrice);

          // Рассчитываем текущий профит в пунктах
          const profitPoints =
            this.activePosition.side === "Buy"
              ? currentPrice - entryPrice
              : entryPrice - currentPrice;

          // Если трейлинг еще не активирован
          if (!this.activePosition.isTrailingActive) {
            // Проверяем, включен ли трейлинг в настройках
            if (!this.USE_TRAILING_STOP) {
              return;
            }

            logger.info(
              `📊 Проверка трейлинга: Профит=${profitPoints.toFixed(
                2
              )} пунктов (активация при ${this.TRAILING_ACTIVATION_POINTS})`
            );

            if (profitPoints >= this.TRAILING_ACTIVATION_POINTS) {
              // Рассчитываем новый стоп-лосс
              const newStopLoss =
                this.activePosition.side === "Buy"
                  ? currentPrice - this.TRAILING_DISTANCE
                  : currentPrice + this.TRAILING_DISTANCE;

              try {
                // Сначала отменяем существующий стоп-лосс ордер
                const activeOrders = await this.client.getActiveOrders({
                  category: "linear",
                  symbol: this.SYMBOL
                });

                if (activeOrders.retCode === 0 && activeOrders.result?.list) {
                  for (const order of activeOrders.result.list) {
                    if (order.reduceOnly) {
                      const orderPrice = Number(order.price);
                      const isSL =
                        this.activePosition.side === "Buy"
                          ? orderPrice < currentPrice
                          : orderPrice > currentPrice;

                      if (isSL) {
                        await this.client.cancelOrder({
                          category: "linear",
                          symbol: this.SYMBOL,
                          orderId: order.orderId
                        });
                        logger.info(
                          `✅ Отменен старый стоп-лосс для обновления: ${order.orderId} @ ${orderPrice}`
                        );
                      }
                    }
                  }
                }

                // Устанавливаем новый стоп-лосс
                const slResponse = await this.client.submitOrder({
                  category: "linear",
                  symbol: this.SYMBOL,
                  side: this.activePosition.side === "Buy" ? "Sell" : "Buy",
                  orderType: "Limit",
                  qty: position.size.toString(),
                  price: newStopLoss.toString(),
                  triggerPrice: newStopLoss.toString(),
                  triggerDirection: this.activePosition.side === "Buy" ? 2 : 1,
                  timeInForce: "GTC",
                  triggerBy: "MarkPrice",
                  reduceOnly: true,
                  orderLinkId: `sl_trailing_${Date.now()}`
                });

                if (slResponse.retCode === 0) {
                  this.activePosition.isTrailingActive = true;
                  this.activePosition.lastTrailingStopPrice = newStopLoss;
                  logger.info(
                    `🚀 АКТИВИРОВАН ТРЕЙЛИНГ-СТОП ЛИМИТНЫМ ОРДЕРОМ: SL=${newStopLoss.toFixed(
                      2
                    )}`
                  );

                  // Отправляем уведомление об активации трейлинг-стопа
                  const trailingActivationMessage = this.notificationService.formatTrailingStopActivation();
                  await this.callbacks.onTradeOperation(
                    trailingActivationMessage
                  );

                  // Отправляем уведомление об обновлении стоп-лосса
                  const trailingUpdateMessage = this.notificationService.formatTrailingStopUpdate(
                    newStopLoss,
                    this.TRAILING_DISTANCE,
                    currentPrice
                  );
                  await this.callbacks.onTradeOperation(trailingUpdateMessage);
                } else {
                  logger.error(
                    `❌ Ошибка при установке лимитного трейлинг-стопа: ${slResponse.retMsg}`
                  );
                }
              } catch (error) {
                logger.error("❌ Ошибка при установке трейлинг-стопа:", error);
              }
            }
          }
          // Если трейлинг уже активирован, проверяем необходимость обновления
          else if (this.activePosition.lastTrailingStopPrice !== null) {
            const optimalStopPrice =
              this.activePosition.side === "Buy"
                ? currentPrice - this.TRAILING_DISTANCE
                : currentPrice + this.TRAILING_DISTANCE;

            // Проверяем, нужно ли обновить стоп
            const shouldUpdateStop =
              this.activePosition.side === "Buy"
                ? optimalStopPrice > this.activePosition.lastTrailingStopPrice
                : optimalStopPrice < this.activePosition.lastTrailingStopPrice;

            if (shouldUpdateStop) {
              try {
                // Отменяем текущий стоп-лосс
                const activeOrders = await this.client.getActiveOrders({
                  category: "linear",
                  symbol: this.SYMBOL
                });

                if (activeOrders.retCode === 0 && activeOrders.result?.list) {
                  for (const order of activeOrders.result.list) {
                    if (order.reduceOnly) {
                      const orderPrice = Number(order.price);
                      const isSL =
                        this.activePosition.side === "Buy"
                          ? orderPrice < currentPrice
                          : orderPrice > currentPrice;

                      if (isSL) {
                        await this.client.cancelOrder({
                          category: "linear",
                          symbol: this.SYMBOL,
                          orderId: order.orderId
                        });
                        logger.info(
                          `✅ Отменен старый стоп-лосс для обновления: ${order.orderId} @ ${orderPrice}`
                        );
                      }
                    }
                  }
                }

                // Устанавливаем новый стоп-лосс
                const slResponse = await this.client.submitOrder({
                  category: "linear",
                  symbol: this.SYMBOL,
                  side: this.activePosition.side === "Buy" ? "Sell" : "Buy",
                  orderType: "Limit",
                  qty: position.size.toString(),
                  price: optimalStopPrice.toString(),
                  triggerPrice: optimalStopPrice.toString(),
                  triggerDirection: this.activePosition.side === "Buy" ? 2 : 1,
                  timeInForce: "GTC",
                  triggerBy: "MarkPrice",
                  reduceOnly: true,
                  orderLinkId: `sl_trailing_${Date.now()}`
                });

                if (slResponse.retCode === 0) {
                  this.activePosition.lastTrailingStopPrice = optimalStopPrice;
                  logger.info(
                    `🔄 ОБНОВЛЕН ТРЕЙЛИНГ-СТОП: ${optimalStopPrice.toFixed(
                      2
                    )} (движение цены: ${currentPrice.toFixed(2)})`
                  );

                  // Отправляем уведомление об обновлении трейлинг-стопа
                  const trailingUpdateMessage = this.notificationService.formatTrailingStopUpdate(
                    optimalStopPrice,
                    this.TRAILING_DISTANCE,
                    currentPrice
                  );
                  await this.callbacks.onTradeOperation(trailingUpdateMessage);
                } else {
                  logger.error(
                    `❌ Ошибка при обновлении трейлинг-стопа: ${slResponse.retMsg}`
                  );
                }
              } catch (error) {
                logger.error("❌ Ошибка при обновлении трейлинг-стопа:", error);
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error("❌ Ошибка при проверке состояния позиции:", error);
    }
  }

  private stopTrailingStopCheck(): void {
    if (this.trailingStopCheckInterval) {
      clearInterval(this.trailingStopCheckInterval);
    }
  }

  public async performRestCheck(): Promise<void> {
    const currentTime = Date.now();

    // Проверяем не слишком ли рано для следующей проверки
    if (currentTime - this.lastRestCheckTime < this.REST_CHECK_INTERVAL) {
      return;
    }

    try {
      logger.info("🔄 Выполняем дополнительную проверку через REST API...");

      // Получаем последние свечи через REST API
      const klineResponse = await this.client.getKline({
        category: "linear",
        symbol: this.SYMBOL,
        interval: "240", // 4h
        limit: 5 // Получаем последние 5 свечей
      });

      if (klineResponse.retCode === 0 && klineResponse.result?.list) {
        const candles: Candle[] = klineResponse.result.list
          .map(item => ({
            timestamp: Number(item[0]),
            open: Number(item[1]),
            high: Number(item[2]),
            low: Number(item[3]),
            close: Number(item[4]),
            volume: Number(item[5]),
            turnover: Number(item[6]),
            confirmed: true,
            isGreen: Number(item[4]) >= Number(item[1])
          }))
          .reverse(); // Разворачиваем массив, чтобы свечи шли от старых к новым

        logger.info(`📊 Получено ${candles.length} свечей через REST API`);

        // Проверяем каждую свечу на наличие сигнала
        for (let i = 1; i < candles.length; i++) {
          const currentCandle = candles[i];
          const previousCandle = candles[i - 1];

          // Проверяем объем
          this.checkVolumeSpike(currentCandle, previousCandle);

          // Если найден сигнал, проверяем следующую свечу как подтверждающую
          if (this.currentSignal?.isActive) {
            await this.processCompletedCandle(currentCandle, candles);
          }
        }

        this.lastRestCheckTime = currentTime;
        logger.info("✅ Дополнительная проверка через REST API завершена");
      }
    } catch (error) {
      logger.error("❌ Ошибка при выполнении REST проверки:", error);
    }
  }

  private async performRetrospectiveAnalysis(
    allCandles: Candle[]
  ): Promise<void> {
    logger.info(
      "🔍 Начинаем ретроспективный анализ для поиска активных сигналов..."
    );

    // Диагностика входных данных
    logger.info(`📊 Всего получено свечей: ${allCandles.length}`);
    logger.info("📊 СПИСОК ВСЕХ ПОЛУЧЕННЫХ СВЕЧЕЙ:");
    allCandles.forEach(candle => {
      logger.info(
        `   ${new Date(candle.timestamp).toLocaleTimeString()}: ${
          candle.confirmed ? "✅ Закрыта" : "⏳ Формируется"
        }, V=${candle.volume.toFixed(2)}, ${candle.isGreen ? "🟢" : "🔴"}`
      );
    });

    // Фильтруем ТОЛЬКО закрытые свечи и сортируем по времени
    const completedCandles = allCandles
      .filter(candle => candle.confirmed === true)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (completedCandles.length < 3) {
      logger.info(
        "❌ Недостаточно закрытых свечей для ретроспективного анализа (нужно минимум 3)"
      );
      return;
    }

    // Берем три последние ЗАКРЫТЫЕ свечи
    const lastClosedCandle = completedCandles[completedCandles.length - 1];
    const middleClosedCandle = completedCandles[completedCandles.length - 2];
    const potentialSignalCandle = completedCandles[completedCandles.length - 3];

    logger.info(`\n📊 АНАЛИЗ ПОСЛЕДНИХ ТРЕХ ЗАКРЫТЫХ СВЕЧЕЙ:`);
    logger.info(
      `   1️⃣ Потенциально сигнальная (${new Date(
        potentialSignalCandle.timestamp
      ).toLocaleTimeString()}): V=${potentialSignalCandle.volume.toFixed(2)}, ${
        potentialSignalCandle.isGreen ? "🟢" : "🔴"
      }, Open=${potentialSignalCandle.open}, Close=${
        potentialSignalCandle.close
      }`
    );
    logger.info(
      `   2️⃣ Средняя (${new Date(
        middleClosedCandle.timestamp
      ).toLocaleTimeString()}): V=${middleClosedCandle.volume.toFixed(2)}, ${
        middleClosedCandle.isGreen ? "🟢" : "🔴"
      }, Open=${middleClosedCandle.open}, Close=${middleClosedCandle.close}`
    );
    logger.info(
      `   3️⃣ Последняя (${new Date(
        lastClosedCandle.timestamp
      ).toLocaleTimeString()}): V=${lastClosedCandle.volume.toFixed(2)}, ${
        lastClosedCandle.isGreen ? "🟢" : "🔴"
      }, Open=${lastClosedCandle.open}, Close=${lastClosedCandle.close}`
    );
    logger.info(`   🎯 Порог объема: ${this.VOLUME_THRESHOLD}`);

    // Проверяем объем потенциально сигнальной свечи
    if (potentialSignalCandle.volume >= this.VOLUME_THRESHOLD) {
      logger.info(
        `🚨 ОБНАРУЖЕН СИГНАЛ: ВЫСОКИЙ ОБЪЕМ (${potentialSignalCandle.volume.toFixed(
          2
        )}) В СВЕЧЕ ${new Date(
          potentialSignalCandle.timestamp
        ).toLocaleTimeString()}!`
      );
      logger.info(
        `💰 Цена закрытия сигнальной: ${potentialSignalCandle.close}`
      );
      logger.info(
        `📊 Цвет сигнальной свечи: ${
          potentialSignalCandle.isGreen ? "🟢 Зеленая" : "🔴 Красная"
        }`
      );

      // Проверяем, что следующие две свечи имеют меньший объем
      if (
        middleClosedCandle.volume <= potentialSignalCandle.volume &&
        lastClosedCandle.volume <= potentialSignalCandle.volume
      ) {
        // Создаем сигнал на основе потенциально сигнальной свечи
        this.currentSignal = {
          candle: potentialSignalCandle,
          isActive: true,
          waitingForLowerVolume: true
        };
        this.usedSignalTimestamps.add(potentialSignalCandle.timestamp);

        logger.info(
          `✅ ПОДТВЕРЖДЕНИЕ: Обе следующие свечи имеют меньший объем`
        );
        logger.info(
          `⚡️ ГОТОВЫ К ВХОДУ В ${
            potentialSignalCandle.isGreen ? "ШОРТ" : "ЛОНГ"
          }`
        );

        // Явно вызываем обработку последней закрытой свечи
        logger.info(
          "🎯 Начинаем обработку последней закрытой свечи для входа..."
        );
        await this.processCompletedCandle(lastClosedCandle, completedCandles);
      } else {
        logger.info(
          `⚠️ ПРОПУСК: Не все последующие свечи имеют меньший объем (${middleClosedCandle.volume.toFixed(
            2
          )}, ${lastClosedCandle.volume.toFixed(2)})`
        );
      }
    } else {
      logger.info(
        `ℹ️ Объем потенциально сигнальной свечи (${potentialSignalCandle.volume.toFixed(
          2
        )}) меньше порога ${this.VOLUME_THRESHOLD}`
      );
    }
  }

  private async analyzeLastCandle(): Promise<void> {
    // Сначала сортируем все свечи по времени и фильтруем только подтвержденные
    const completedCandles = this.candleHistory
      .filter(candle => candle.confirmed)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (completedCandles.length < 2) {
      logger.info("Недостаточно закрытых свечей для анализа");
      return;
    }

    logger.info(`🔍 Проверка последних закрытых свечей на готовые сигналы...`);

    // Находим свечу с максимальным объемом среди подтвержденных свечей
    const maxVolumeCandle = completedCandles.reduce(
      (max, current) => (current.volume > max.volume ? current : max),
      completedCandles[0]
    );

    // Находим следующую подтвержденную свечу после максимальной по объему
    const maxVolumeCandleIndex = completedCandles.findIndex(
      c => c.timestamp === maxVolumeCandle.timestamp
    );
    const confirmingCandle = completedCandles[maxVolumeCandleIndex + 1];

    if (!confirmingCandle) {
      logger.info("Нет подтверждающей свечи после сигнальной");
      return;
    }

    logger.info(`📊 АНАЛИЗ ПОСЛЕДНИХ ДВУХ ЗАКРЫТЫХ СВЕЧЕЙ:`);
    logger.info(
      `   📈 Сигнальная (${new Date(
        maxVolumeCandle.timestamp
      ).toLocaleTimeString()}): V=${maxVolumeCandle.volume.toFixed(2)}, ${
        maxVolumeCandle.isGreen ? "🟢" : "🔴"
      }, Open=${maxVolumeCandle.open}, Close=${maxVolumeCandle.close}`
    );
    logger.info(
      `   📈 Подтверждающая (${new Date(
        confirmingCandle.timestamp
      ).toLocaleTimeString()}): V=${confirmingCandle.volume.toFixed(2)}, ${
        confirmingCandle.isGreen ? "🟢" : "🔴"
      }, Open=${confirmingCandle.open}, Close=${confirmingCandle.close}`
    );

    // Проверяем объем сигнальной свечи
    if (maxVolumeCandle.volume >= this.VOLUME_THRESHOLD) {
      logger.info(
        `🚨 ОБНАРУЖЕН СИГНАЛ: ВЫСОКИЙ ОБЪЕМ (${maxVolumeCandle.volume.toFixed(
          2
        )}) В СВЕЧЕ ${new Date(
          maxVolumeCandle.timestamp
        ).toLocaleTimeString()}!`
      );
      logger.info(`💰 Цена закрытия: ${maxVolumeCandle.close}`);
      logger.info(
        `📊 Цвет свечи: ${
          maxVolumeCandle.isGreen ? "🟢 Зеленая" : "🔴 Красная"
        }`
      );

      // Создаем сигнал
      this.currentSignal = {
        candle: maxVolumeCandle,
        isActive: true,
        waitingForLowerVolume: true
      };
      this.usedSignalTimestamps.add(maxVolumeCandle.timestamp);

      // Проверяем подтверждающую свечу
      if (confirmingCandle.volume <= maxVolumeCandle.volume) {
        logger.info(
          `✅ ПОДТВЕРЖДЕНИЕ: Подтверждающая свеча имеет меньший объем`
        );
        logger.info(
          `⚡️ ГОТОВЫ К ВХОДУ В ${maxVolumeCandle.isGreen ? "ШОРТ" : "ЛОНГ"}`
        );
        await this.processCompletedCandle(confirmingCandle, completedCandles);
      }
    }
  }
}
