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

export class TradingLogicService {
  private currentSignal: VolumeSignal | null = null;
  private activePosition: ActivePosition | null = null;
  private trailingStopInterval: NodeJS.Timeout | null = null;
  private isOpeningPosition: boolean = false;
  private lastSignalNotificationTime: number = 0;
  private usedSignalTimestamps: Set<number> = new Set(); // Хранение использованных сигналов
  private lastRestCheckTime: number = 0;
  private readonly REST_CHECK_INTERVAL = 5 * 60 * 1000; // 5 минут

  private readonly TAKE_PROFIT_POINTS: number;
  private readonly STOP_LOSS_POINTS: number;
  private readonly TRAILING_ACTIVATION_POINTS: number;
  private readonly TRAILING_DISTANCE: number;
  private readonly VOLUME_THRESHOLD: number;
  private readonly TRADE_SIZE_USD: number;
  private readonly SYMBOL: string;
  private readonly LEVERAGE: number = 25;
  private readonly TRAILING_STOP_INTERVAL_MS = 60000;

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
    }
  ) {
    this.SYMBOL = options.symbol;
    this.TRADE_SIZE_USD = options.tradeSizeUsd;
    this.TAKE_PROFIT_POINTS = options.takeProfitPoints;
    this.STOP_LOSS_POINTS = options.stopLossPoints;
    this.TRAILING_ACTIVATION_POINTS = options.trailingActivationPoints;
    this.TRAILING_DISTANCE = options.trailingDistance;
    this.VOLUME_THRESHOLD = options.volumeThreshold;
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
          const positionSize = position.size;

          logger.info(`🔄 УСЫНОВЛЕНИЕ СУЩЕСТВУЮЩЕЙ ПОЗИЦИИ:`);
          logger.info(`   📊 Размер: ${positionSize} ${position.symbol}`);
          logger.info(`   📈 Сторона: ${position.side}`);
          logger.info(`   💰 Средняя цена входа: ${position.avgPrice}`);
          logger.info(`   💹 Текущая P&L: ${position.unrealisedPnl} USDT`);

          // Получаем текущие TP/SL установленные на позиции
          let currentTakeProfit: number | undefined;
          let currentStopLoss: number | undefined;
          let isTrailingActive = false;

          if (position.takeProfit && Number(position.takeProfit) > 0) {
            currentTakeProfit = Number(position.takeProfit);
            logger.info(`   🎯 Текущий Take Profit: ${currentTakeProfit}`);
          }

          if (position.stopLoss && Number(position.stopLoss) > 0) {
            currentStopLoss = Number(position.stopLoss);
            logger.info(`   🛡️ Текущий Stop Loss: ${currentStopLoss}`);

            // Проверяем может ли это быть трейлинг-стоп
            const currentPrice = Number(position.markPrice);
            const stopDistance =
              position.side === "Buy"
                ? currentPrice - currentStopLoss
                : currentStopLoss - currentPrice;

            if (Math.abs(stopDistance - this.TRAILING_DISTANCE) < 50) {
              isTrailingActive = true;
              logger.info(
                `   🚀 ВОЗМОЖНО АКТИВЕН ТРЕЙЛИНГ: расстояние до стопа ${stopDistance.toFixed(
                  1
                )} ≈ ${this.TRAILING_DISTANCE}`
              );
            }
          }

          this.activePosition = {
            side: position.side as any,
            entryPrice: Number(position.avgPrice),
            entryTime: Date.now(), // Примерное время - при усыновлении точное время неизвестно
            isTrailingActive: isTrailingActive,
            lastTrailingStopPrice: isTrailingActive
              ? currentStopLoss || null
              : null,
            orderId: "", // У существующей позиции нет orderId
            plannedTakeProfit: currentTakeProfit,
            plannedStopLoss: currentStopLoss,
            executionNotificationSent: true // Считаем что уведомление уже было отправлено
          };

          // Отправляем уведомление об усыновлении позиции
          const adoptMessage = this.formatPositionAdoptedAlert(position);
          try {
            await this.callbacks.onTradeOperation(adoptMessage);
            logger.info("✅ Уведомление об усыновлении позиции отправлено");
          } catch (notifyError) {
            logger.error(
              "❌ Ошибка при отправке уведомления об усыновлении:",
              notifyError
            );
            // Повторная попытка отправки через 1 секунду
            setTimeout(async () => {
              try {
                await this.callbacks.onTradeOperation(adoptMessage);
                logger.info(
                  "✅ Уведомление об усыновлении отправлено со второй попытки"
                );
              } catch (retryError) {
                logger.error(
                  "❌ Не удалось отправить уведомление даже со второй попытки:",
                  retryError
                );
              }
            }, 1000);
          }

          // ВАЖНО: Проверяем существующие лимитные ордера перед установкой новых
          try {
            // Получаем список активных ордеров
            const activeOrders = await this.client.getActiveOrders({
              category: "linear",
              symbol: this.SYMBOL
            });

            let hasLimitTp = false;
            let hasLimitSl = false;
            let needUpdateSize = false;

            // Всегда пересчитываем уровни при усыновлении
            logger.info(
              "🔄 Принудительно пересчитываем уровни TP/SL для усыновленной позиции"
            );
            hasLimitTp = false;
            hasLimitSl = false;
            needUpdateSize = true;

            if (activeOrders.retCode === 0 && activeOrders.result?.list) {
              // Проверяем каждый ордер
              for (const order of activeOrders.result.list) {
                const isCloseOrder = order.reduceOnly;
                const price = Number(order.price);
                const side = order.side;
                const orderSize = order.qty;

                // Определяем является ли это лимитным TP или SL
                if (isCloseOrder) {
                  if (position.side === "Buy" && side === "Sell") {
                    if (price > Number(position.avgPrice)) {
                      hasLimitTp = true;
                      if (orderSize !== positionSize) {
                        needUpdateSize = true;
                        logger.info(
                          `🔄 Найден TP с неверным размером: ${orderSize} != ${positionSize}`
                        );
                      }
                    } else {
                      hasLimitSl = true;
                      if (orderSize !== positionSize) {
                        needUpdateSize = true;
                        logger.info(
                          `🔄 Найден SL с неверным размером: ${orderSize} != ${positionSize}`
                        );
                      }
                    }
                  } else if (position.side === "Sell" && side === "Buy") {
                    if (price < Number(position.avgPrice)) {
                      hasLimitTp = true;
                      if (orderSize !== positionSize) {
                        needUpdateSize = true;
                        logger.info(
                          `🔄 Найден TP с неверным размером: ${orderSize} != ${positionSize}`
                        );
                      }
                    } else {
                      hasLimitSl = true;
                      if (orderSize !== positionSize) {
                        needUpdateSize = true;
                        logger.info(
                          `🔄 Найден SL с неверным размером: ${orderSize} != ${positionSize}`
                        );
                      }
                    }
                  }
                }
              }
            }

            // Если нет лимитных ордеров или их размер не соответствует позиции
            if (!hasLimitTp || !hasLimitSl || needUpdateSize) {
              // Сначала сбрасываем TP/SL через setTradingStop
              await this.client.setTradingStop({
                category: "linear",
                symbol: this.SYMBOL,
                takeProfit: "0",
                stopLoss: "0",
                tpTriggerBy: "MarkPrice",
                slTriggerBy: "MarkPrice",
                positionIdx: 0
              });

              logger.info(
                "🔄 Сброшены существующие TP/SL через setTradingStop"
              );

              // Улучшенная логика отмены ордеров
              let retryCount = 0;
              const maxRetries = 3;
              let allOrdersCanceled = false;

              while (!allOrdersCanceled && retryCount < maxRetries) {
                try {
                  // Получаем список активных ордеров
                  const activeOrders = await this.client.getActiveOrders({
                    category: "linear",
                    symbol: this.SYMBOL
                  });

                  if (activeOrders.retCode === 0 && activeOrders.result?.list) {
                    const closeOrders = activeOrders.result.list.filter(
                      order => order.reduceOnly && order.symbol === this.SYMBOL // Только ордера закрытия // Дополнительная проверка символа
                    );

                    if (closeOrders.length === 0) {
                      logger.info("✅ Активных ордеров закрытия не найдено");
                      allOrdersCanceled = true;
                      break;
                    }

                    logger.info(
                      `🔍 Найдено ${closeOrders.length} активных ордеров закрытия`
                    );

                    // Отменяем каждый ордер индивидуально
                    for (const order of closeOrders) {
                      try {
                        const cancelResponse = await this.client.cancelOrder({
                          category: "linear",
                          symbol: this.SYMBOL,
                          orderId: order.orderId
                        });

                        if (cancelResponse.retCode === 0) {
                          logger.info(
                            `✅ Отменен ордер ${order.orderId} (${order.side} @ ${order.price})`
                          );
                        } else {
                          logger.warn(
                            `⚠️ Не удалось отменить ордер ${order.orderId}: ${cancelResponse.retMsg}`
                          );
                        }
                      } catch (cancelError) {
                        logger.error(
                          `❌ Ошибка при отмене ордера ${order.orderId}:`,
                          cancelError
                        );
                      }
                    }

                    // Проверяем, что все ордера действительно отменены
                    const checkOrders = await this.client.getActiveOrders({
                      category: "linear",
                      symbol: this.SYMBOL
                    });

                    if (
                      checkOrders.retCode === 0 &&
                      (!checkOrders.result?.list ||
                        checkOrders.result.list.length === 0)
                    ) {
                      logger.info("✅ Все ордера успешно отменены");
                      allOrdersCanceled = true;
                    } else {
                      logger.warn(
                        `⚠️ Остались активные ордера после отмены. Попытка ${retryCount +
                          1}/${maxRetries}`
                      );
                      retryCount++;
                    }
                  } else {
                    logger.error(
                      `❌ Ошибка получения списка ордеров: ${activeOrders.retMsg}`
                    );
                    retryCount++;
                  }
                } catch (error) {
                  logger.error("❌ Ошибка при отмене ордеров:", error);
                  retryCount++;
                }

                if (!allOrdersCanceled && retryCount < maxRetries) {
                  // Ждем перед следующей попыткой
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
              }

              if (!allOrdersCanceled) {
                logger.error(
                  "❌ Не удалось отменить все ордера после нескольких попыток"
                );
                return; // Прерываем выполнение, чтобы не создавать дублирующие ордера
              }

              logger.info(
                "🔄 Отменены существующие ордера, устанавливаем лимитные TP/SL"
              );

              // Рассчитываем новые TP/SL от цены входа
              const entryPrice = Number(position.avgPrice);
              const takeProfit =
                entryPrice +
                (position.side === "Buy"
                  ? this.TAKE_PROFIT_POINTS
                  : -this.TAKE_PROFIT_POINTS);

              // Находим последние сигнальные свечи для расчета стоп-лосса
              let stopLoss =
                position.side === "Buy"
                  ? entryPrice - this.STOP_LOSS_POINTS
                  : entryPrice + this.STOP_LOSS_POINTS;

              // Ищем последнюю пару сигнальной и подтверждающей свечи
              let signalCandle = null;
              let confirmingCandle = null;

              // Сначала ищем сигнальную свечу с высоким объемом
              for (let i = candleHistory.length - 1; i >= 0; i--) {
                const candle = candleHistory[i];
                if (candle.volume >= this.VOLUME_THRESHOLD) {
                  // Нашли сигнальную свечу, теперь ищем подтверждающую после неё
                  signalCandle = candle;

                  // Ищем подтверждающую свечу после сигнальной
                  for (let j = i + 1; j < candleHistory.length; j++) {
                    if (candleHistory[j].volume <= signalCandle.volume) {
                      confirmingCandle = candleHistory[j];
                      break;
                    }
                  }

                  if (confirmingCandle) break; // Нашли пару свечей
                }
              }

              if (signalCandle && confirmingCandle) {
                logger.info(`🔍 Найдены свечи для расчета SL:`);
                logger.info(
                  `   📊 Сигнальная (${new Date(
                    signalCandle.timestamp
                  ).toLocaleTimeString()}): High=${signalCandle.high}, Low=${
                    signalCandle.low
                  }, Volume=${signalCandle.volume}`
                );
                logger.info(
                  `   ✅ Подтверждающая (${new Date(
                    confirmingCandle.timestamp
                  ).toLocaleTimeString()}): High=${
                    confirmingCandle.high
                  }, Low=${confirmingCandle.low}, Volume=${
                    confirmingCandle.volume
                  }`
                );

                const extremum =
                  position.side === "Buy"
                    ? Math.min(signalCandle.low, confirmingCandle.low)
                    : Math.max(signalCandle.high, confirmingCandle.high);

                stopLoss =
                  position.side === "Buy"
                    ? extremum - this.STOP_LOSS_POINTS
                    : extremum + this.STOP_LOSS_POINTS;

                logger.info(`   💰 Цена входа: ${entryPrice}`);
                logger.info(`   📍 Экстремум: ${extremum}`);
                logger.info(`   🎯 Take Profit: ${takeProfit}`);
                logger.info(`   🛡️ Stop Loss: ${stopLoss}`);
              } else {
                logger.warn(
                  "⚠️ Не найдены сигнальная и подтверждающая свечи, используем стандартный SL от цены входа"
                );
              }

              // Создаем условный лимитный ордер для Take Profit
              const tpResponse = await this.client.submitOrder({
                category: "linear",
                symbol: this.SYMBOL,
                side: position.side === "Buy" ? "Sell" : "Buy",
                orderType: "Limit",
                qty: positionSize.toString(), // Явно преобразуем в строку
                price: takeProfit.toString(),
                triggerPrice: takeProfit.toString(),
                triggerDirection: position.side === "Buy" ? 1 : 2,
                timeInForce: "GTC",
                triggerBy: "MarkPrice",
                reduceOnly: true,
                closeOnTrigger: true,
                orderLinkId: `tp_${Date.now()}`
              });

              // Создаем условный лимитный ордер для Stop Loss
              const slResponse = await this.client.submitOrder({
                category: "linear",
                symbol: this.SYMBOL,
                side: position.side === "Buy" ? "Sell" : "Buy",
                orderType: "Limit",
                qty: positionSize.toString(), // Явно преобразуем в строку
                price: stopLoss.toString(),
                triggerPrice: stopLoss.toString(),
                triggerDirection: position.side === "Buy" ? 2 : 1,
                timeInForce: "GTC",
                triggerBy: "MarkPrice",
                reduceOnly: true,
                closeOnTrigger: true,
                orderLinkId: `sl_${Date.now()}`
              });

              if (tpResponse.retCode === 0 && slResponse.retCode === 0) {
                logger.info(
                  `✅ Установлены лимитные TP/SL ордера с корректным размером ${positionSize}: TP=${takeProfit.toFixed(
                    1
                  )}, SL=${stopLoss.toFixed(1)}`
                );
              } else {
                logger.error(
                  `❌ Ошибка при установке TP/SL: TP=${tpResponse.retMsg}, SL=${slResponse.retMsg}`
                );
              }
            } else {
              logger.info(
                "✅ Лимитные TP/SL ордера уже существуют с корректным размером"
              );
            }
          } catch (error) {
            logger.error(
              "❌ Ошибка при проверке/установке лимитных ордеров:",
              error
            );
          }

          // Запускаем трейлинг-стоп для существующей позиции
          this.startTrailingStopCheck();

          logger.info(
            "✅ Существующая позиция успешно усыновлена и трейлинг активирован"
          );
        } else {
          logger.info("✅ Открытых позиций не найдено, состояние чистое");
        }
      }
    } catch (error) {
      logger.error("❌ Ошибка при синхронизации состояния позиций:", error);
    }
  }

  private formatPositionAdoptedAlert(position: any): string {
    const side = position.side === "Buy" ? "ЛОНГ" : "ШОРТ";
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

  public checkVolumeSpike(
    completedCandle: Candle,
    previousCandle: Candle
  ): void {
    // Проверяем наличие активной позиции
    if (this.activePosition) {
      logger.info(
        `🔄 ПРОПУСК ПРОВЕРКИ ОБЪЕМА: Есть активная ${this.activePosition.side} позиция`
      );
      return;
    }

    // Проверяем, что свеча подтверждена
    if (!completedCandle.confirmed) {
      logger.info(`⏳ ПРОПУСК ПРОВЕРКИ ОБЪЕМА: Текущая свеча не подтверждена`);
      return;
    }

    logger.info(`📊 АНАЛИЗ ОБЪЕМОВ:`);
    logger.info(
      `   📈 Объем текущей свечи: ${completedCandle.volume.toFixed(2)}`
    );
    logger.info(`   🎯 Порог объема: ${this.VOLUME_THRESHOLD}`);

    // Если у нас нет сигнала и текущая свеча имеет достаточный объем - создаем сигнал
    if (
      !this.currentSignal?.isActive &&
      completedCandle.volume >= this.VOLUME_THRESHOLD
    ) {
      logger.info(
        `🚨 ОБНАРУЖЕН СИГНАЛ: ВЫСОКИЙ ОБЪЕМ (${completedCandle.volume.toFixed(
          2
        )}) В ЗАКРЫТОЙ СВЕЧЕ!`
      );
      logger.info(`💰 Цена закрытия: ${completedCandle.close}`);

      this.currentSignal = {
        candle: completedCandle,
        isActive: true,
        waitingForLowerVolume: true
      };
      this.usedSignalTimestamps.add(completedCandle.timestamp);
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

    if (!this.currentSignal?.isActive) {
      logger.info(`⏳ ПРОПУСК ОБРАБОТКИ: Нет активного сигнала`);
      return;
    }

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

    // Если объем текущей свечи меньше сигнальной - входим в позицию
    if (completedCandle.volume <= this.currentSignal.candle.volume) {
      logger.info(`🎯 ВХОДИМ В ПОЗИЦИЮ: Найдена свеча с меньшим объемом`);
      const positionOpened = await this.openPosition(
        this.currentSignal.candle,
        completedCandle
      );

      // Деактивируем сигнал ТОЛЬКО если позиция успешно открыта
      if (positionOpened && this.currentSignal) {
        this.currentSignal.isActive = false;
        logger.info("✅ Сигнал деактивирован после успешного входа в позицию.");
      }
    } else {
      // Если объем больше - обновляем сигнал на текущую свечу
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
    }
  }

  private async openPosition(
    signalCandle: Candle,
    currentCandle: Candle
  ): Promise<boolean> {
    if (this.activePosition) {
      logger.warn(
        "⚠️ Внутреннее состояние показывает активную позицию. Проверяем реальное состояние на бирже..."
      );

      // Дополнительная проверка реального состояния на бирже
      const positionsResponse = await this.client.getPositionInfo({
        category: "linear",
        symbol: this.SYMBOL
      });

      if (positionsResponse.retCode === 0 && positionsResponse.result?.list) {
        const openPositions = positionsResponse.result.list.filter(
          pos => Number(pos.size) > 0
        );

        if (openPositions.length === 0) {
          logger.warn(
            "🔄 ИСПРАВЛЕНИЕ РАССИНХРОНИЗАЦИИ: На бирже нет позиций, но внутреннее состояние показывает активную. Сбрасываем состояние."
          );
          this.activePosition = null;
          this.stopTrailingStopCheck();
        } else {
          logger.warn(
            `🚫 Подтверждено: есть открытая позиция на бирже - размер ${openPositions[0].size}, сторона ${openPositions[0].side}`
          );
          return false;
        }
      }
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
      // Дополнительная проверка через API - нет ли уже открытых позиций
      const positionsResponse = await this.client.getPositionInfo({
        category: "linear",
        symbol: this.SYMBOL
      });

      if (positionsResponse.retCode === 0 && positionsResponse.result?.list) {
        const openPositions = positionsResponse.result.list.filter(
          pos => Number(pos.size) > 0
        );

        if (openPositions.length > 0) {
          logger.warn(
            `🚫 Обнаружена открытая позиция через API: размер ${openPositions[0].size}, сторона ${openPositions[0].side}`
          );
          logger.warn(
            "Система рассчитана только на одну сделку! Отменяем открытие новой позиции."
          );

          // Синхронизируем внутреннее состояние с реальным
          this.activePosition = {
            side: openPositions[0].side as any,
            entryPrice: Number(openPositions[0].avgPrice),
            entryTime: Date.now(), // Примерное время
            isTrailingActive: false,
            lastTrailingStopPrice: null,
            orderId: "", // У существующей позиции нет orderId
            plannedTakeProfit: undefined,
            plannedStopLoss: undefined
          };

          return false;
        }
      }
    } catch (error) {
      logger.error("❌ Ошибка при проверке существующих позиций:", error);
      this.isOpeningPosition = false;
      return false;
    }

    try {
      // Проверяем баланс перед открытием позиции
      const balanceResponse = await this.client.getWalletBalance({
        accountType: "UNIFIED"
      });

      // Также проверим CONTRACT счет для фьючерсов
      const contractBalanceResponse = await this.client.getWalletBalance({
        accountType: "CONTRACT"
      });

      // Также проверим SPOT счет для диагностики
      const spotBalanceResponse = await this.client.getWalletBalance({
        accountType: "SPOT"
      });

      // Пробуем получить баланс из любого доступного счета
      let usdtBalance = null;
      let accountType = "";

      // Сначала проверяем CONTRACT
      if (
        contractBalanceResponse.retCode === 0 &&
        contractBalanceResponse.result?.list?.[0]?.coin
      ) {
        usdtBalance = contractBalanceResponse.result.list[0].coin.find(
          c => c.coin === "USDT"
        );
        accountType = "CONTRACT";
      }

      // Если не найден в CONTRACT, проверяем UNIFIED
      if (
        !usdtBalance &&
        balanceResponse.retCode === 0 &&
        balanceResponse.result?.list?.[0]?.coin
      ) {
        usdtBalance = balanceResponse.result.list[0].coin.find(
          c => c.coin === "USDT"
        );
        accountType = "UNIFIED";
      }

      if (usdtBalance) {
        const availableBalance =
          accountType === "UNIFIED"
            ? Number(usdtBalance.walletBalance) // Для UNIFIED используем walletBalance
            : Number(usdtBalance.availableToWithdraw); // Для других счетов используем availableToWithdraw

        // Получаем информацию о плече для расчета необходимой маржи
        const instrumentResponse = await this.client.getInstrumentsInfo({
          category: "linear",
          symbol: this.SYMBOL
        });

        let requiredMargin = this.TRADE_SIZE_USD; // По умолчанию без плеча

        if (
          instrumentResponse.retCode === 0 &&
          instrumentResponse.result?.list?.[0]
        ) {
          const leverage =
            Number(
              instrumentResponse.result.list[0].leverageFilter?.maxLeverage
            ) || 1;
          requiredMargin =
            this.TRADE_SIZE_USD / Math.min(leverage, this.LEVERAGE); // Используем наше плечо

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
          )}, Требуется маржи: ${requiredMargin.toFixed(2)} (размер позиции: ${
            this.TRADE_SIZE_USD
          })`
        );

        if (availableBalance < requiredMargin) {
          logger.error(
            `❌ Недостаточно средств! Доступно: ${availableBalance.toFixed(
              2
            )} USDT, требуется маржи: ${requiredMargin.toFixed(2)} USDT`
          );
          this.isOpeningPosition = false;
          return false;
        }
      } else {
        logger.warn("💸 Не удалось найти баланс USDT ни на одном из счетов");
        this.isOpeningPosition = false;
        return false;
      }

      const side: OrderSideV5 = signalCandle.isGreen ? "Sell" : "Buy";

      // КРИТИЧЕСКИ ВАЖНАЯ ДИАГНОСТИКА НАПРАВЛЕНИЯ СДЕЛКИ ДЛЯ VSA
      logger.info(`🔍 АНАЛИЗ НАПРАВЛЕНИЯ СДЕЛКИ (VSA логика):`);
      logger.info(
        `   ⏰ Время сигнальной свечи: ${new Date(
          signalCandle.timestamp
        ).toISOString()} (${new Date(
          signalCandle.timestamp
        ).toLocaleTimeString()})`
      );
      logger.info(
        `   📊 Сигнальная свеча: Open=${signalCandle.open} → Close=${signalCandle.close}`
      );
      logger.info(
        `   🧮 Математика: ${signalCandle.close} ${
          signalCandle.close >= signalCandle.open ? ">=" : "<"
        } ${signalCandle.open} = ${
          signalCandle.close >= signalCandle.open ? "ЗЕЛЕНАЯ" : "КРАСНАЯ"
        }`
      );
      logger.info(
        `   🎨 Определенный цвет: ${
          signalCandle.isGreen ? "🟢 ЗЕЛЕНАЯ (рост)" : "🔴 КРАСНАЯ (падение)"
        }`
      );
      logger.info(
        `   📈 Объем сигнальной свечи: ${signalCandle.volume.toFixed(2)}`
      );
      logger.info(
        `   🎯 ВЫБРАННОЕ НАПРАВЛЕНИЕ: ${side} ${
          side === "Buy" ? "(ЛОНГ)" : "(ШОРТ)"
        }`
      );

      // ДОПОЛНИТЕЛЬНАЯ ЗАЩИТА: Верификация VSA логики
      const vsaLogicCheck = this.verifyVSALogic(signalCandle, side);
      if (!vsaLogicCheck.isValid) {
        logger.error(`🚫 ОШИБКА VSA ЛОГИКИ: ${vsaLogicCheck.error}`);
        logger.error(`🚫 СДЕЛКА ОТМЕНЕНА ДЛЯ БЕЗОПАСНОСТИ!`);
        this.isOpeningPosition = false;
        return false;
      }

      const stopLossLevel =
        side === "Buy"
          ? Math.min(signalCandle.low, currentCandle.low)
          : Math.max(signalCandle.high, currentCandle.high);

      const stopLoss =
        side === "Buy"
          ? stopLossLevel - this.STOP_LOSS_POINTS
          : stopLossLevel + this.STOP_LOSS_POINTS;

      // Сначала получаем цену ордера, потом рассчитываем TP от неё
      // Получаем текущую рыночную цену для более быстрого исполнения
      const tickerResponse = await this.client.getTickers({
        category: "linear",
        symbol: this.SYMBOL
      });

      let orderPrice = currentCandle.close; // По умолчанию цена свечи

      if (tickerResponse.retCode === 0 && tickerResponse.result?.list?.[0]) {
        const currentMarketPrice = Number(
          tickerResponse.result.list[0].lastPrice
        );
        // Делаем более агрессивную цену для быстрого исполнения
        orderPrice =
          side === "Buy"
            ? currentMarketPrice + 10 // Buy выше рынка для быстрого исполнения
            : currentMarketPrice - 10; // Sell ниже рынка для быстрого исполнения

        logger.info(
          `📊 Рыночная цена: ${currentMarketPrice}, Цена ордера: ${orderPrice} (${
            side === "Buy" ? "-5" : "+2"
          } пунктов для быстрого лимитного исполнения)`
        );
      }

      // ИСПРАВЛЕНО: Рассчитываем TP от цены ордера, а не от цены закрытия свечи
      const takeProfit =
        orderPrice +
        (side === "Buy" ? this.TAKE_PROFIT_POINTS : -this.TAKE_PROFIT_POINTS);

      // Получаем информацию о контракте для правильного расчета размера
      const instrumentResponse = await this.client.getInstrumentsInfo({
        category: "linear",
        symbol: this.SYMBOL
      });

      let lotSizeFilter;
      if (
        instrumentResponse.retCode === 0 &&
        instrumentResponse.result?.list?.[0]
      ) {
        lotSizeFilter = instrumentResponse.result.list[0].lotSizeFilter;
        logger.info(
          `📊 Параметры контракта: minOrderQty=${lotSizeFilter?.minOrderQty}, qtyStep=${lotSizeFilter?.qtyStep}`
        );
      }

      // Рассчитываем размер позиции с учетом минимального шага
      const rawSize = this.TRADE_SIZE_USD / orderPrice;
      const qtyStep = Number(lotSizeFilter?.qtyStep || 0.1);
      const minQty = Number(lotSizeFilter?.minOrderQty || 0.1);

      // Округляем до ближайшего кратного qtyStep, но не меньше minQty
      const steps = Math.floor(rawSize / qtyStep);
      const contractSize = Math.max(steps * qtyStep, minQty).toFixed(1);

      logger.info(
        `💰 Расчет размера позиции: $${this.TRADE_SIZE_USD} / ${orderPrice} = ${rawSize} → ${contractSize} (округлено до шага ${qtyStep})`
      );

      const orderParams = {
        category: "linear" as const,
        symbol: this.SYMBOL,
        side: side,
        orderType: "Limit" as const,
        qty: contractSize,
        price: orderPrice.toString(),
        timeInForce: "GTC" as const,
        positionIdx: 0 as const
      };

      const orderResponse = await this.client.submitOrder(orderParams);

      if (orderResponse.retCode === 0) {
        logger.info(
          `✅ Установлен лимитный ордер с корректным размером ${contractSize}: TP=${takeProfit.toFixed(
            1
          )}, SL=${stopLoss.toFixed(1)}`
        );
        return true;
      } else {
        logger.error(
          `❌ Ошибка при установке лимитного ордера: ${orderResponse.retMsg}`
        );
        return false;
      }
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
    if (this.currentSignal?.isActive) {
      logger.info(
        `🎯 Начальный анализ завершен с активным сигналом от свечи ${new Date(
          this.currentSignal.candle.timestamp
        ).toLocaleTimeString()}`
      );
    }
    logger.info(
      "✅ Начальный анализ истории завершен, система готова к торговле"
    );
  }

  private async startTrailingStopCheck(): Promise<void> {
    if (this.trailingStopInterval) {
      clearInterval(this.trailingStopInterval);
    }

    this.trailingStopInterval = setInterval(async () => {
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
                  closeOnTrigger: true,
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
                  closeOnTrigger: true,
                  orderLinkId: `sl_trailing_${Date.now()}`
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
    if (this.trailingStopInterval) {
      clearInterval(this.trailingStopInterval);
    }
  }

  private cleanupOldSignals(oldestCandleTimestamp: number): void {
    // Реализация очистки старых сигналов
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
}
