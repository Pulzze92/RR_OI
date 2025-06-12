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
  private readonly REST_CHECK_INTERVAL = 15 * 60 * 1000; // 15 минут для часового таймфрейма
  private readonly POSITION_CHECK_INTERVAL = 60 * 1000; // 1 минута
  private hasInitialSync = false;
  private lastPositionOpenTime: number = 0;
  private positionCheckInterval: NodeJS.Timeout | null = null;

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
    this.TAKE_PROFIT_POINTS = options.takeProfitPoints; // 2 пункта для часового таймфрейма
    this.STOP_LOSS_POINTS = options.stopLossPoints; // 1.5 пункта для часового таймфрейма
    this.TRAILING_ACTIVATION_POINTS = options.trailingActivationPoints; // Активация трейлинга при 1.5 пункте
    this.TRAILING_DISTANCE = options.trailingDistance; // Дистанция трейлинга 1.0 пункт
    this.VOLUME_THRESHOLD = options.volumeThreshold; // Порог объема для часового таймфрейма
    this.USE_TRAILING_STOP = options.useTrailingStop;

    // Запускаем периодическую проверку позиции
    this.startPositionCheck();
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

      // Проверяем состояние позиции при каждом вызове
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
          logger.info("🔄 Позиция закрыта, сбрасываем состояние");
          this.activePosition = null;
          this.stopTrailingStopCheck();
          this.stopPositionCheck();
          return;
        }

        // Если есть открытая позиция
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
          let stopLossLevel = 0;
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

          // Устанавливаем TP/SL
          logger.info("\n🎯 УСТАНАВЛИВАЕМ TP/SL:");
          const tpResponse = await this.client.setTradingStop({
            category: "linear",
            symbol: this.SYMBOL,
            takeProfit: takeProfit.toString(),
            stopLoss: stopLoss.toString(),
            positionIdx: 0
          });

          if (tpResponse.retCode === 0) {
            logger.info(
              `✅ Установлены уровни TP=${takeProfit.toFixed(
                2
              )}, SL=${stopLoss.toFixed(2)}`
            );
          } else {
            logger.error(`❌ Ошибка при установке TP/SL: ${tpResponse.retMsg}`);
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

          // Сохраняем время открытия позиции
          this.lastPositionOpenTime = Date.now();

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

          // Проверяем, есть ли уже TP/SL
          const positionInfo = await this.client.getPositionInfo({
            category: "linear",
            symbol: this.SYMBOL
          });

          if (
            positionInfo.retCode === 0 &&
            positionInfo.result.list.length > 0
          ) {
            const pos = positionInfo.result.list[0];
            if (!pos.takeProfit && !pos.stopLoss) {
              // Рассчитываем уровни TP/SL для усыновленной позиции
              const entryPrice = parseFloat(pos.avgPrice);
              const side = pos.side;

              const takeProfit =
                entryPrice +
                (side === "Buy"
                  ? this.TAKE_PROFIT_POINTS
                  : -this.TAKE_PROFIT_POINTS);

              // Для усыновленной позиции используем текущую цену как экстремум
              const currentPrice = parseFloat(pos.markPrice);
              const stopLoss =
                side === "Buy"
                  ? currentPrice - this.STOP_LOSS_POINTS
                  : currentPrice + this.STOP_LOSS_POINTS;

              // Устанавливаем TP/SL
              await this.client.setTradingStop({
                category: "linear",
                symbol: this.SYMBOL,
                takeProfit: takeProfit.toString(),
                stopLoss: stopLoss.toString(),
                positionIdx: 0
              });

              logger.info(
                `✅ Установлены уровни для усыновленной позиции: TP=${takeProfit.toFixed(
                  2
                )}, SL=${stopLoss.toFixed(2)}`
              );
            }
          }
        } else {
          logger.info("✅ Открытых позиций не найдено, состояние чистое");
        }
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
    // Проверяем, что свеча действительно закрыта
    if (!completedCandle.confirmed) {
      logger.info(
        `⏳ Пропуск обработки незакрытой свечи: ${new Date(
          completedCandle.timestamp
        ).toLocaleTimeString()}`
      );
      return;
    }

    // Проверяем, есть ли активный сигнал
    const currentSignal = this.getCurrentSignal();
    if (!currentSignal?.isActive) {
      return;
    }

    logger.info(`\n🔍 ДИАГНОСТИКА ОБРАБОТКИ СВЕЧИ:`);
    logger.info(
      `    ⏰ Время обрабатываемой свечи: ${new Date(
        completedCandle.timestamp
      ).toLocaleTimeString()}`
    );
    logger.info(
      `    ⏰ Время сигнальной свечи: ${new Date(
        currentSignal.candle.timestamp
      ).toLocaleTimeString()}`
    );
    logger.info(`    📊 Сигнал активен: ${currentSignal.isActive}`);
    logger.info(
      `    📊 Ожидание меньшего объема: ${currentSignal.waitingForLowerVolume}`
    );
    logger.info(`    📊 Объем текущей свечи: ${completedCandle.volume}`);
    logger.info(
      `    📊 Объем сигнальной свечи: ${currentSignal.candle.volume}`
    );

    // Проверяем, что текущая свеча действительно закрыта
    const now = Date.now();
    const candleEndTime = completedCandle.timestamp + 60 * 60 * 1000; // Добавляем 1 час
    if (now < candleEndTime) {
      logger.info(
        `⏳ Пропуск обработки незакрытой свечи: ${new Date(
          completedCandle.timestamp
        ).toLocaleTimeString()} (еще не закрыта)`
      );
      return;
    }

    // Если мы ждем свечу с меньшим объемом
    if (currentSignal.waitingForLowerVolume) {
      logger.info(`\n📊 ПРОВЕРКА ПОДТВЕРЖДАЮЩЕЙ СВЕЧИ:`);
      logger.info(`    📈 Объем текущей: ${completedCandle.volume.toFixed(2)}`);
      logger.info(`    📊 Объем сигнальной: ${currentSignal.candle.volume}`);

      // Проверяем, что объем текущей свечи меньше объема сигнальной
      if (completedCandle.volume < currentSignal.candle.volume) {
        logger.info(`✅ ПОДТВЕРЖДЕНИЕ: Найдена свеча с меньшим объемом`);
        logger.info(`🎯 ВХОДИМ В ПОЗИЦИЮ СРАЗУ ПОСЛЕ ПОДТВЕРЖДАЮЩЕЙ СВЕЧИ`);
        logger.info(
          `    📊 Сигнальная свеча: ${currentSignal.candle.volume}, ${
            currentSignal.candle.close > currentSignal.candle.open ? "🟢" : "🔴"
          }`
        );
        logger.info(
          `    📊 Текущая свеча: ${new Date(
            completedCandle.timestamp
          ).toLocaleTimeString()}`
        );

        // Входим в позицию
        await this.openPosition(currentSignal.candle, completedCandle);
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
      // Получаем текущую рыночную цену через API
      const tickerResponse = await this.client.getTickers({
        category: "linear",
        symbol: this.SYMBOL
      });

      if (tickerResponse.retCode !== 0) {
        logger.error(`❌ Ошибка получения цены: ${tickerResponse.retMsg}`);
        this.isOpeningPosition = false;
        return false;
      }

      const currentMarketPrice = Number(
        tickerResponse.result?.list?.[0]?.lastPrice
      );
      if (!currentMarketPrice) {
        logger.error("❌ Не удалось получить текущую цену");
        this.isOpeningPosition = false;
        return false;
      }

      logger.info(`   💰 Текущая цена: ${currentMarketPrice}`);

      // Устанавливаем лимитный ордер
      const side: OrderSideV5 = signalCandle.isGreen ? "Sell" : "Buy";
      const limitPrice =
        side === "Buy"
          ? currentMarketPrice - 0.02 // Для покупки ставим ниже рынка
          : currentMarketPrice + 0.02; // Для продажи ставим выше рынка

      logger.info(
        `   📊 Лимитный ордер будет установлен по цене: ${limitPrice}`
      );

      // Рассчитываем размер позиции
      const rawSize = this.TRADE_SIZE_USD / limitPrice;
      const qtyStep = 0.1; // Минимальный шаг для BTC
      const minQty = 0.1; // Минимальный размер для BTC
      const steps = Math.floor(rawSize / qtyStep);
      const contractSize = Math.max(steps * qtyStep, minQty).toFixed(1);

      // Проверяем, что размер позиции корректный
      if (Number(contractSize) < minQty) {
        logger.error(
          `❌ Размер позиции ${contractSize} меньше минимального ${minQty}`
        );
        this.isOpeningPosition = false;
        return false;
      }

      logger.info(
        `💰 Расчет размера позиции: $${this.TRADE_SIZE_USD} / ${limitPrice} = ${rawSize} → ${contractSize}`
      );

      // Создаем лимитный ордер на вход
      logger.info("\n🚀 РАЗМЕЩАЕМ ЛИМИТНЫЙ ОРДЕР НА ВХОД:");
      logger.info(`   📊 Параметры ордера:`);
      logger.info(`   - Сторона: ${side}`);
      logger.info(`   - Цена: ${limitPrice}`);
      logger.info(`   - Размер: ${contractSize}`);
      logger.info(`   - Плечо: ${this.LEVERAGE}x`);
      logger.info(`   - Размер в USDT: $${this.TRADE_SIZE_USD}`);

      const orderResponse = await this.client.submitOrder({
        category: "linear",
        symbol: this.SYMBOL,
        side: side,
        orderType: "Limit",
        qty: contractSize,
        price: limitPrice.toString(),
        timeInForce: "GTC",
        positionIdx: 0,
        orderLinkId: `entry_${Date.now()}`
      });

      logger.info(
        `📊 Ответ на размещение ордера: ${JSON.stringify(orderResponse)}`
      );

      if (orderResponse.retCode !== 0) {
        logger.error(
          `❌ Ошибка при установке лимитного ордера: ${orderResponse.retMsg}`
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
        `✅ Размещен лимитный ордер ${orderId} на ${side} по цене ${limitPrice}`
      );

      // Ждем исполнения ордера
      let orderFilled = false;
      let retryCount = 0;
      const maxRetries = 10;

      while (!orderFilled && retryCount < maxRetries) {
        try {
          const orderStatus = await this.client.getOrderbook({
            category: "linear",
            symbol: this.SYMBOL
          });

          // Проверяем позицию
          const positionInfo = await this.client.getPositionInfo({
            category: "linear",
            symbol: this.SYMBOL
          });

          if (
            positionInfo.retCode === 0 &&
            positionInfo.result.list.length > 0 &&
            positionInfo.result.list[0].size !== "0"
          ) {
            orderFilled = true;
            console.log("✅ Позиция открыта, устанавливаем TP/SL");
            break;
          }
        } catch (error) {
          console.error("Ошибка при проверке статуса ордера:", error);
        }

        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!orderFilled) {
        throw new Error("Ордер не был исполнен в течение ожидаемого времени");
      }

      // Рассчитываем уровни TP/SL
      const takeProfit =
        limitPrice +
        (side === "Buy" ? this.TAKE_PROFIT_POINTS : -this.TAKE_PROFIT_POINTS);

      // Находим экстремум из сигнальной и подтверждающей свечей
      const extremeLevel =
        side === "Buy"
          ? Math.min(signalCandle.low, currentCandle.low) // Для покупки берем минимум
          : Math.max(signalCandle.high, currentCandle.high); // Для продажи берем максимум

      // Устанавливаем стоп-лосс от экстремума
      const stopLoss =
        side === "Buy"
          ? extremeLevel - this.STOP_LOSS_POINTS // Для покупки стоп ниже экстремума
          : extremeLevel + this.STOP_LOSS_POINTS; // Для продажи стоп выше экстремума

      logger.info(`\n📊 РАСЧЕТ УРОВНЕЙ:`);
      logger.info(`   💰 Цена входа: ${limitPrice}`);
      logger.info(`   📈 Экстремум свечей: ${extremeLevel}`);
      logger.info(`   🎯 Take Profit: ${takeProfit}`);
      logger.info(`   🛡️ Stop Loss: ${stopLoss}`);

      // Устанавливаем TP/SL только после исполнения ордера
      console.log("🎯 УСТАНАВЛИВАЕМ TP/SL:");
      const tpResponse = await this.client.setTradingStop({
        category: "linear",
        symbol: this.SYMBOL,
        takeProfit: takeProfit.toString(),
        stopLoss: stopLoss.toString(),
        positionIdx: 0
      });

      if (tpResponse.retCode === 0) {
        logger.info(
          `✅ Установлены уровни TP=${takeProfit.toFixed(
            2
          )}, SL=${stopLoss.toFixed(2)}`
        );
      } else {
        logger.error(`❌ Ошибка при установке TP/SL: ${tpResponse.retMsg}`);
      }

      // Создаем запись о позиции
      this.activePosition = {
        side: side,
        entryPrice: limitPrice,
        entryTime: Date.now(),
        isTrailingActive: false,
        lastTrailingStopPrice: stopLoss,
        orderId: orderId,
        plannedTakeProfit: takeProfit,
        plannedStopLoss: stopLoss,
        executionNotificationSent: false
      };

      // Отправляем уведомление о размещении лимитного ордера
      const openPositionMessage = this.notificationService.formatTradeOpenAlert(
        this.activePosition,
        takeProfit,
        stopLoss,
        signalCandle,
        currentCandle,
        true,
        side
      );
      await this.callbacks.onTradeOperation(openPositionMessage);

      // Сохраняем время открытия позиции
      this.lastPositionOpenTime = Date.now();

      // Запускаем проверку трейлинг-стопа
      this.startTrailingStopCheck();

      this.isOpeningPosition = false;
      return true;
    } catch (error) {
      logger.error("❌ Ошибка при открытии позиции:", error);
      this.isOpeningPosition = false;
      return false;
    }
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
                const slResponse = await this.client.setTradingStop({
                  category: "linear",
                  symbol: this.SYMBOL,
                  stopLoss: newStopLoss.toString(),
                  positionIdx: 0
                });

                if (slResponse.retCode === 0) {
                  this.activePosition.isTrailingActive = true;
                  this.activePosition.lastTrailingStopPrice = newStopLoss;
                  logger.info(
                    `🚀 АКТИВИРОВАН ТРЕЙЛИНГ-СТОП: SL=${newStopLoss.toFixed(2)}`
                  );

                  // Отправляем уведомление только при активации трейлинг-стопа
                  const trailingActivationMessage = this.notificationService.formatTrailingStopActivation();
                  await this.callbacks.onTradeOperation(
                    trailingActivationMessage
                  );
                } else {
                  logger.error(
                    `❌ Ошибка при установке трейлинг-стопа: ${slResponse.retMsg}`
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
                const slResponse = await this.client.setTradingStop({
                  category: "linear",
                  symbol: this.SYMBOL,
                  stopLoss: optimalStopPrice.toString(),
                  positionIdx: 0
                });

                if (slResponse.retCode === 0) {
                  this.activePosition.lastTrailingStopPrice = optimalStopPrice;
                  logger.info(
                    `🔄 ОБНОВЛЕН ТРЕЙЛИНГ-СТОП: ${optimalStopPrice.toFixed(
                      2
                    )} (движение цены: ${currentPrice.toFixed(2)})`
                  );
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
        interval: "60", // 1h
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

  private startPositionCheck(): void {
    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
    }

    this.positionCheckInterval = setInterval(async () => {
      await this.checkPositionState();
    }, this.POSITION_CHECK_INTERVAL);
  }

  private stopPositionCheck(): void {
    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
      this.positionCheckInterval = null;
    }
  }
}
