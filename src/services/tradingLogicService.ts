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
  private lastTrailingNotificationTime: number = 0;
  private lastTrailingStopPrice: number = 0;

  private readonly TAKE_PROFIT_POINTS: number;
  private readonly STOP_LOSS_POINTS: number;
  private readonly TRAILING_ACTIVATION_POINTS: number;
  private readonly TRAILING_DISTANCE: number;
  private readonly VOLUME_THRESHOLD: number;
  private readonly TRADE_SIZE_USD: number;
  private readonly SYMBOL: string;
  private readonly TRAILING_STOP_INTERVAL_MS = 3000;
  private lastTrailingLogTime: number | null = null;

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

  public async syncPositionState(): Promise<void> {
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

          logger.info(`🔄 УСЫНОВЛЕНИЕ СУЩЕСТВУЮЩЕЙ ПОЗИЦИИ:`);
          logger.info(`   📊 Размер: ${position.size} ${position.symbol}`);
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
            // Если разница между стоп-лоссом и текущей ценой близка к TRAILING_DISTANCE,
            // возможно трейлинг уже активен
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
          this.callbacks.onTradeOperation(adoptMessage);

          // ВАЖНО: Если TP/SL не установлены, устанавливаем их по правилам системы
          if (!currentTakeProfit || !currentStopLoss) {
            logger.info(
              "🔧 TP/SL не найдены на позиции, устанавливаем по правилам системы..."
            );

            try {
              const entryPrice = Number(position.avgPrice);

              // Рассчитываем TP от цены входа (не от текущей!)
              const takeProfit =
                entryPrice +
                (position.side === "Buy"
                  ? this.TAKE_PROFIT_POINTS
                  : -this.TAKE_PROFIT_POINTS);

              // Для SL при усыновлении используем цену входа как базу (нет данных о сигнальной свече)
              const stopLoss =
                position.side === "Buy"
                  ? entryPrice - this.STOP_LOSS_POINTS // Лонг: SL ниже цены входа
                  : entryPrice + this.STOP_LOSS_POINTS; // Шорт: SL выше цены входа

              logger.info(
                `🎯 Рассчитанные уровни: Вход=${entryPrice.toFixed(
                  1
                )}, TP=${takeProfit.toFixed(1)}, SL=${stopLoss.toFixed(1)}`
              );

              const tpSlResponse = await this.client.setTradingStop({
                category: "linear",
                symbol: this.SYMBOL,
                takeProfit: takeProfit.toString(),
                stopLoss: stopLoss.toString(),
                positionIdx: 0,
                tpTriggerBy: "MarkPrice",
                slTriggerBy: "MarkPrice"
              });

              if (tpSlResponse.retCode === 0) {
                logger.info(
                  `🛡️ TP/SL успешно установлены при усыновлении: ТП=${takeProfit.toFixed(
                    1
                  )}, СЛ=${stopLoss.toFixed(1)}`
                );

                // Обновляем внутреннее состояние
                this.activePosition.plannedTakeProfit = takeProfit;
                this.activePosition.plannedStopLoss = stopLoss;

                // Отправляем уведомление об установке TP/SL
                const tpSlMessage = `🛡️ TP/SL УСТАНОВЛЕНЫ\n\n🎯 Take Profit: ${takeProfit.toFixed(
                  1
                )}\n🚫 Stop Loss: ${stopLoss.toFixed(1)}`;
                this.callbacks.onTradeOperation(tpSlMessage);
              } else {
                logger.error(
                  `❌ Не удалось установить TP/SL при усыновлении: ${tpSlResponse.retMsg}`
                );
              }
            } catch (tpSlError) {
              logger.error(
                "❌ Ошибка при установке TP/SL для усыновленной позиции:",
                tpSlError
              );
            }
          } else {
            // TP/SL уже установлены, но проверяем корректность их расчета
            const entryPrice = Number(position.avgPrice);
            const expectedTakeProfit =
              entryPrice +
              (position.side === "Buy"
                ? this.TAKE_PROFIT_POINTS
                : -this.TAKE_PROFIT_POINTS);
            const expectedStopLoss =
              position.side === "Buy"
                ? entryPrice - this.STOP_LOSS_POINTS
                : entryPrice + this.STOP_LOSS_POINTS;

            const tpDifference = Math.abs(
              currentTakeProfit - expectedTakeProfit
            );
            const slDifference = Math.abs(currentStopLoss - expectedStopLoss);

            logger.info(
              `🔍 ПРОВЕРКА TP/SL: Текущие TP=${currentTakeProfit.toFixed(
                1
              )} SL=${currentStopLoss.toFixed(1)}`
            );
            logger.info(
              `🔍 ОЖИДАЕМЫЕ: TP=${expectedTakeProfit.toFixed(
                1
              )} SL=${expectedStopLoss.toFixed(1)}`
            );
            logger.info(
              `🔍 ОТКЛОНЕНИЯ: TP=${tpDifference.toFixed(
                1
              )} SL=${slDifference.toFixed(1)} пунктов`
            );

            // Если отклонение больше 50 пунктов, корректируем
            if (tpDifference > 50 || slDifference > 50) {
              logger.info(
                "🔧 TP/SL требуют коррекции, пересчитываем от цены входа..."
              );

              try {
                const tpSlResponse = await this.client.setTradingStop({
                  category: "linear",
                  symbol: this.SYMBOL,
                  takeProfit: expectedTakeProfit.toString(),
                  stopLoss: expectedStopLoss.toString(),
                  positionIdx: 0,
                  tpTriggerBy: "MarkPrice",
                  slTriggerBy: "MarkPrice"
                });

                if (tpSlResponse.retCode === 0) {
                  logger.info(
                    `🛡️ TP/SL скорректированы: ТП=${expectedTakeProfit.toFixed(
                      1
                    )}, СЛ=${expectedStopLoss.toFixed(1)}`
                  );

                  // Обновляем внутреннее состояние
                  this.activePosition.plannedTakeProfit = expectedTakeProfit;
                  this.activePosition.plannedStopLoss = expectedStopLoss;

                  // Отправляем уведомление о коррекции
                  const correctionMessage = `🔧 TP/SL СКОРРЕКТИРОВАНЫ\n\n🎯 Take Profit: ${expectedTakeProfit.toFixed(
                    1
                  )}\n🚫 Stop Loss: ${expectedStopLoss.toFixed(
                    1
                  )}\n\n(пересчитано от цены входа ${entryPrice.toFixed(1)})`;
                  this.callbacks.onTradeOperation(correctionMessage);
                } else {
                  logger.error(
                    `❌ Не удалось скорректировать TP/SL: ${tpSlResponse.retMsg}`
                  );
                }
              } catch (correctionError) {
                logger.error("❌ Ошибка при коррекции TP/SL:", correctionError);
              }
            } else {
              logger.info("✅ TP/SL корректны, коррекция не требуется");
            }
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

    if (position.takeProfit && Number(position.takeProfit) > 0) {
      message += `🎯 Take Profit: ${position.takeProfit}\n`;
    }

    if (position.stopLoss && Number(position.stopLoss) > 0) {
      message += `🛡️ Stop Loss: ${position.stopLoss}\n`;
    }

    message += `\n⏱️ Трейлинг-стоп активирован`;

    return message;
  }

  public checkVolumeSpike(
    completedCandle: Candle,
    previousCandle: Candle
  ): void {
    // Проверяем, что свеча не является текущей формирующейся
    const now = new Date();
    const candleTime = new Date(completedCandle.timestamp);
    const isCurrentHourCandle =
      candleTime.getUTCFullYear() === now.getUTCFullYear() &&
      candleTime.getUTCMonth() === now.getUTCMonth() &&
      candleTime.getUTCDate() === now.getUTCDate() &&
      candleTime.getUTCHours() === now.getUTCHours();

    if (isCurrentHourCandle) {
      logger.info(
        `⏳ ПРОПУСК ПРОВЕРКИ ОБЪЕМА: Свеча текущего часа (${new Date(
          completedCandle.timestamp
        ).toLocaleTimeString()})`
      );
      return;
    }

    // Проверяем, что обе свечи подтверждены
    if (!completedCandle.confirmed || !previousCandle.confirmed) {
      logger.info(
        `⏳ ПРОПУСК ПРОВЕРКИ ОБЪЕМА: Свечи не подтверждены (текущая: ${completedCandle.confirmed}, предыдущая: ${previousCandle.confirmed})`
      );
      return;
    }

    const volumeRatio = completedCandle.volume / previousCandle.volume;

    if (this.activePosition) {
      const timeSinceEntry =
        completedCandle.timestamp - this.activePosition.entryTime;
      const isAnomalousVolume = completedCandle.volume > 8000;

      if (timeSinceEntry > 0 && isAnomalousVolume) {
        logger.info(
          `🚨 ОБНАРУЖЕН АНОМАЛЬНЫЙ ОБЪЕМ ПОСЛЕ ВХОДА! Объем=${completedCandle.volume.toFixed(
            2
          )} > 7000 И рост в ${volumeRatio.toFixed(2)}x раз`
        );
        this.closePosition(completedCandle, "Аномальный объем после входа");
        return;
      } else if (timeSinceEntry > 0) {
        logger.info(
          `📊 Проверка объема после входа: Объем=${completedCandle.volume.toFixed(
            2
          )} (порог 7000), Изменение=${volumeRatio.toFixed(2)}x (порог 2x)`
        );
      }
    }

    const isHighVolume = completedCandle.volume >= this.VOLUME_THRESHOLD;

    // Сначала проверяем возможность использовать свечу как подтверждающую
    if (
      this.currentSignal?.isActive &&
      this.currentSignal.waitingForLowerVolume
    ) {
      logger.info(
        `[TradingLogic] Текущая свеча будет проверена как подтверждающая в processCompletedCandle`
      );
      return; // Выходим, чтобы processCompletedCandle мог обработать свечу
    }

    // Проверяем нужно ли создать новый сигнал
    if (!this.currentSignal?.isActive && isHighVolume) {
      // Проверяем "свежесть" сигнала (не старше 2 часов)
      const signalAge = Date.now() - completedCandle.timestamp;
      const TWO_HOURS = 2 * 60 * 60 * 1000;

      if (signalAge > TWO_HOURS) {
        logger.info(
          `🕒 ПРОПУСК СИГНАЛА: Свеча слишком старая - от ${new Date(
            completedCandle.timestamp
          ).toLocaleTimeString()} (${Math.round(
            signalAge / (60 * 60 * 1000)
          )} часов назад)`
        );
        return;
      }

      let signalReason = "";
      if (isHighVolume) {
        signalReason = `ВЫСОКИЙ ОБЪЕМ (${completedCandle.volume.toFixed(
          2
        )}) И ВСПЛЕСК ОБЪЕМА (${volumeRatio.toFixed(2)}x)`;
      } else {
        signalReason = `ВЫСОКИЙ ОБЪЕМ (${completedCandle.volume.toFixed(2)})`;
      }
      logger.info(`🚨 ОБНАРУЖЕН СИГНАЛ: ${signalReason} В ЗАКРЫТОЙ СВЕЧЕ!`);
      logger.info(`💰 Цена закрытия: ${completedCandle.close}`);
      logger.info(`✅ Свеча подтверждена, можно использовать для сигнала`);

      // Отправляем уведомление только если прошло достаточно времени с последнего
      const now = Date.now();
      if (now - this.lastSignalNotificationTime > 60000) {
        const message = this.notificationService.formatVolumeAlert(
          completedCandle,
          previousCandle
        );
        this.callbacks.onSignalDetected(message);
        this.lastSignalNotificationTime = now;
      } else {
        logger.info("⏭️ Уведомление о сигнале пропущено (защита от спама)");
      }

      this.currentSignal = {
        candle: completedCandle,
        isActive: true,
        waitingForLowerVolume: true
      };
      logger.info(
        `✅ Сигнал активирован, ожидаем следующую свечу с меньшим объемом`
      );
    } else if (
      this.currentSignal?.isActive &&
      completedCandle.volume > previousCandle.volume
    ) {
      logger.info(
        `🔄 ОБНОВЛЕНИЕ СИГНАЛА: Новая свеча с еще большим всплеском объема (${volumeRatio.toFixed(
          2
        )}x) и объемом выше порога (${completedCandle.volume.toFixed(2)} > ${
          this.VOLUME_THRESHOLD
        }).`
      );
      this.currentSignal = {
        candle: completedCandle,
        isActive: true,
        waitingForLowerVolume: true
      };
      logger.info(
        `✅ Сигнал обновлен, ожидаем следующую свечу с меньшим объемом`
      );
    } else if (completedCandle.volume >= this.VOLUME_THRESHOLD * 0.8) {
      logger.info(
        `🔍 ПРОВЕРКА ОБЪЕМОВ ЗАКРЫТОЙ СВЕЧИ (близко к сигналу): Объем ${completedCandle.volume.toFixed(
          2
        )}, Ратио ${volumeRatio.toFixed(2)}x`
      );
    }
  }

  public async processCompletedCandle(
    completedCandle: Candle,
    candleHistory: Candle[]
  ): Promise<void> {
    logger.info(
      `[TradingLogic] processCompletedCandle вызван для свечи: ${new Date(
        completedCandle.timestamp
      ).toLocaleTimeString()}, V=${completedCandle.volume.toFixed(
        2
      )}, Confirmed: ${completedCandle.confirmed}`
    );

    if (
      !this.currentSignal?.isActive ||
      !this.currentSignal.waitingForLowerVolume
    ) {
      logger.info(
        "[TradingLogic] Сигнал неактивен или не ожидаем свечу с меньшим объемом. Выход."
      );
      return;
    }

    if (completedCandle.timestamp === this.currentSignal.candle.timestamp) {
      logger.info(
        "[TradingLogic] Завершенная свеча является сигнальной. Пропускаем."
      );
      return;
    }

    logger.info(
      `[TradingLogic] Ищем сигнальную свечу (${new Date(
        this.currentSignal.candle.timestamp
      ).toLocaleTimeString()}) и завершенную (${new Date(
        completedCandle.timestamp
      ).toLocaleTimeString()}) в истории (размер: ${candleHistory.length})`
    );

    // Находим все сигнальные свечи с таким же таймстампом
    const signalCandlesFromHistory = candleHistory.filter(
      c => c.timestamp === this.currentSignal!.candle.timestamp
    );

    // Берем последнюю из них (с самым высоким индексом)
    const signalCandleFromHistory =
      signalCandlesFromHistory[signalCandlesFromHistory.length - 1];

    if (signalCandlesFromHistory.length > 1) {
      logger.info(
        `📊 Найдено ${signalCandlesFromHistory.length} сигнальных свечей с одинаковым таймстампом. Используем последнюю.`
      );
    }

    const completedCandleFromHistory = candleHistory.find(
      c => c.timestamp === completedCandle.timestamp
    );

    if (!signalCandleFromHistory || !completedCandleFromHistory) {
      logger.warn(
        "[TradingLogic] Не удалось найти сигнальную или завершенную свечу в переданной истории."
      );
      // Логируем содержимое истории для отладки, если она не слишком большая
      if (candleHistory.length < 10) {
        logger.debug(
          "[TradingLogic] Содержимое candleHistory:",
          JSON.stringify(
            candleHistory.map(c => ({
              t: new Date(c.timestamp).toLocaleTimeString(),
              v: c.volume,
              conf: c.confirmed
            }))
          )
        );
      }
      this.resetSignal(); // Возможно, стоит пересмотреть, нужно ли сбрасывать сигнал в этом случае или ждать дальше
      return;
    }
    logger.info(
      `[TradingLogic] Сигнальная свеча найдена в истории: V=${signalCandleFromHistory.volume.toFixed(
        2
      )}. Завершенная свеча найдена: V=${completedCandleFromHistory.volume.toFixed(
        2
      )}`
    );

    if (completedCandle.volume <= this.currentSignal.candle.volume) {
      logger.info(
        `✅ [TradingLogic] Условие объема выполнено: объем текущей свечи (${completedCandle.volume.toFixed(
          2
        )}) <= объема сигнальной (${this.currentSignal.candle.volume.toFixed(
          2
        )})`
      );

      // Проверяем, что свеча не является текущей формирующейся
      const now = new Date();
      const candleTime = new Date(completedCandle.timestamp);
      const isCurrentHourCandle =
        candleTime.getUTCFullYear() === now.getUTCFullYear() &&
        candleTime.getUTCMonth() === now.getUTCMonth() &&
        candleTime.getUTCDate() === now.getUTCDate() &&
        candleTime.getUTCHours() === now.getUTCHours();

      if (isCurrentHourCandle) {
        logger.info(
          `⏳ [TradingLogic] Найдена свеча с подходящим объемом, но это свеча текущего часа (${new Date(
            completedCandle.timestamp
          ).toLocaleTimeString()}). Ожидаем завершение часа.`
        );
        return;
      }

      // Дополнительная проверка подтверждения
      if (!completedCandle.confirmed) {
        logger.info(
          `⏳ [TradingLogic] Найдена подходящая свеча с меньшим объемом, но она еще формируется (${new Date(
            completedCandle.timestamp
          ).toLocaleTimeString()}). Ожидаем подтверждение.`
        );
        return;
      }

      // Проверяем "свежесть" сигнала перед входом
      const signalAge = Date.now() - this.currentSignal.candle.timestamp;
      const TWO_HOURS = 2 * 60 * 60 * 1000;

      if (signalAge > TWO_HOURS) {
        logger.info(
          `🕒 ПРОПУСК ВХОДА: Сигнальная свеча слишком старая - от ${new Date(
            this.currentSignal.candle.timestamp
          ).toLocaleTimeString()} (${Math.round(
            signalAge / (60 * 60 * 1000)
          )} часов назад)`
        );
        this.resetSignal();
        return;
      }

      logger.info(
        `✅ [TradingLogic] Найдена подтвержденная свеча с меньшим объемом (${new Date(
          completedCandle.timestamp
        ).toLocaleTimeString()}). Входим в позицию.`
      );

      await this.openPosition(this.currentSignal.candle, completedCandle);

      // Проверяем, не был ли сигнал сброшен во время openPosition
      if (this.currentSignal) {
        this.currentSignal.isActive = false;
        this.currentSignal.waitingForLowerVolume = false;
        logger.info("[TradingLogic] Сигнал деактивирован после попытки входа.");
      }
    } else {
      logger.info(
        `❌ [TradingLogic] Условие для входа НЕ выполнено: объем текущей свечи (${completedCandle.volume.toFixed(
          2
        )}) > объема сигнальной (${this.currentSignal.candle.volume.toFixed(
          2
        )})`
      );
      logger.info(
        `🕯️ [TradingLogic] Ожидаем следующую свечу... Сигнал остается активным.`
      );
    }
  }

  private async openPosition(
    signalCandle: Candle,
    currentCandle: Candle
  ): Promise<void> {
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
          return;
        }
      }
    }

    if (this.isOpeningPosition) {
      logger.warn(
        "⏳ Уже выполняется открытие позиции. Пропускаем дублирующую попытку."
      );
      return;
    }

    this.isOpeningPosition = true;
    logger.info("🔒 Блокируем множественные попытки открытия позиции");

    try {
      // Проверяем "свежесть" сигнала (не старше 2 часов)
      const now = Date.now();
      const signalAge = now - signalCandle.timestamp;
      const TWO_HOURS = 2 * 60 * 60 * 1000;

      if (signalAge > TWO_HOURS) {
        logger.info(
          `🕒 СИГНАЛ УСТАРЕЛ: Сигнальная свеча от ${new Date(
            signalCandle.timestamp
          ).toLocaleTimeString()} (${Math.round(
            signalAge / (60 * 60 * 1000)
          )} часов назад)`
        );
        this.resetSignal();
        this.isOpeningPosition = false;
        return;
      }

      // Дополнительная проверка через API - нет ли уже открытых позиций
      const positionsResponse = await this.client.getPositionInfo({
        category: "linear",
        symbol: this.SYMBOL
      });

      if (positionsResponse.retCode === 0 && positionsResponse.result?.list) {
        const openPositions = positionsResponse.result.list.filter(
          pos => Number(pos.size) > 0 // Позиция с размером больше 0 означает что она открыта
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

          return;
        }
      }
    } catch (error) {
      logger.error("❌ Ошибка при проверке существующих позиций:", error);
      this.isOpeningPosition = false;
      return; // В случае ошибки не открываем позицию для безопасности
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

      logger.info(
        `🔍 Проверка баланса UNIFIED: ${JSON.stringify(balanceResponse.result)}`
      );
      logger.info(
        `🔍 Проверка баланса CONTRACT: ${JSON.stringify(
          contractBalanceResponse.result
        )}`
      );
      logger.info(
        `🔍 Проверка баланса SPOT: ${JSON.stringify(
          spotBalanceResponse.result
        )}`
      );

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
        logger.info(`💰 Используем счет: ${accountType}`);
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
          requiredMargin = this.TRADE_SIZE_USD / Math.min(leverage, 10); // Используем максимум 10x плечо

          logger.info(
            `🔧 Доступное плечо: ${leverage}x, Исползуем: ${Math.min(
              leverage,
              10
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
          return;
        }
      } else {
        logger.warn("💸 Не удалось найти баланс USDT ни на одном из счетов");
        this.isOpeningPosition = false;
        return;
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
        `   💡 VSA интерпретация: ${
          signalCandle.isGreen
            ? "Зеленая свеча с высоким объемом = институционалы ПРОДАЮТ на росте → мы ПРОДАЕМ на откате"
            : "Красная свеча с высоким объемом = институционалы ПОКУПАЮТ на падении → мы ПОКУПАЕМ на откате"
        }`
      );
      logger.info(
        `   🎯 ВЫБРАННОЕ НАПРАВЛЕНИЕ: ${side} ${
          side === "Buy" ? "(ЛОНГ)" : "(ШОРТ)"
        }`
      );
      logger.info(
        `   ⚠️  ПРОВЕРЬТЕ: Соответствует ли направление ${side} вашим ожиданиям по VSA?`
      );

      // ДОПОЛНИТЕЛЬНАЯ ЗАЩИТА: Верификация VSA логики
      const vsaLogicCheck = this.verifyVSALogic(signalCandle, side);
      if (!vsaLogicCheck.isValid) {
        logger.error(`🚫 ОШИБКА VSA ЛОГИКИ: ${vsaLogicCheck.error}`);
        logger.error(`🚫 СДЕЛКА ОТМЕНЕНА ДЛЯ БЕЗОПАСНОСТИ!`);
        this.isOpeningPosition = false;
        return;
      }
      logger.info(`✅ VSA логика верифицирована: ${vsaLogicCheck.explanation}`);

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
        // Логика для корректных лимитных ордеров:
        // Buy ниже рынка - ждет снижения цены для покупки по лучшей цене
        // Sell выше рынка - ждет повышения цены для продажи по лучшей цене
        orderPrice =
          side === "Buy"
            ? currentMarketPrice - 5 // Buy ниже рынка - уменьшаем отступ для быстрого исполнения
            : currentMarketPrice + 2; // Sell выше рынка - уменьшаем отступ для быстрого исполнения

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

      const contractSize = (this.TRADE_SIZE_USD / currentCandle.close).toFixed(
        3
      );

      const orderPriceString = orderPrice.toString();

      // Устанавливаем плечо перед размещением ордера
      try {
        const leverageResponse = await this.client.setLeverage({
          category: "linear",
          symbol: this.SYMBOL,
          buyLeverage: "10",
          sellLeverage: "10"
        });

        if (leverageResponse.retCode === 0) {
          logger.info(`🔧 Плечо успешно установлено: 10x`);
        } else {
          logger.warn(
            `⚠️ Не удалось установить плечо: ${leverageResponse.retMsg} (возможно, уже установлено)`
          );
        }
      } catch (leverageError) {
        logger.warn(`⚠️ Ошибка при установке плеча:`, leverageError);
      }

      logger.info(`🎯 Попытка открытия позиции (Лимитный ордер):`);
      logger.info(
        `📈 Направление: ${side}, Цена ордера: ${orderPriceString}, ТП: ${takeProfit}, СЛ: ${stopLoss}`
      );
      logger.info(
        `📊 Размер контракта: ${contractSize} BTC (${this.TRADE_SIZE_USD} USD)`
      );

      // ДИАГНОСТИКА ОРДЕРА ДЛЯ ВЫЯВЛЕНИЯ ПРОБЛЕМ
      const orderParams = {
        category: "linear" as const,
        symbol: this.SYMBOL,
        side: side,
        orderType: "Limit" as const,
        qty: contractSize,
        price: orderPriceString,
        timeInForce: "GTC" as const // Good Till Cancel - ордер остается активным
      };

      logger.info(`🔍 ДИАГНОСТИКА ОРДЕРА:`);
      logger.info(
        `   📋 Все параметры: ${JSON.stringify(orderParams, null, 2)}`
      );
      logger.info(
        `   🏦 Категория: ${orderParams.category} (Linear/Perpetual фьючерсы)`
      );
      logger.info(`   🪙 Символ: ${orderParams.symbol}`);
      logger.info(
        `   ↗️ Направление: ${orderParams.side} ${
          side === "Buy" ? "(ПОКУПКА/ЛОНГ)" : "(ПРОДАЖА/ШОРТ)"
        }`
      );
      logger.info(`   📊 Тип: ${orderParams.orderType} (Лимитный ордер)`);
      logger.info(`   💰 Количество: ${orderParams.qty} BTC`);
      logger.info(`   💵 Цена: ${orderParams.price} USD`);
      logger.info(
        `   ⏰ Time In Force: ${orderParams.timeInForce} (остается до отмены)`
      );

      // Проверяем тип аккаунта перед размещением ордера
      try {
        const accountInfo = await this.client.getAccountInfo();
        logger.info(`🏦 ТИП АККАУНТА: ${JSON.stringify(accountInfo.result)}`);

        // Проверяем настройки торгового режима
        const marginMode = await this.client.getSpotMarginState();
        logger.info(
          `⚙️ МАРЖИНАЛЬНЫЙ РЕЖИМ: ${JSON.stringify(marginMode.result)}`
        );
      } catch (accountError) {
        logger.warn(
          "⚠️ Не удалось получить информацию об аккаунте:",
          accountError
        );
      }

      const response = await this.client.submitOrder(orderParams);

      logger.info(
        `📡 Ответ от API при открытии лимитного ордера: RetCode=${response.retCode}, RetMsg=${response.retMsg}, OrderId=${response.result?.orderId}`
      );

      if (
        response.retCode === 0 &&
        response.result &&
        response.result.orderId
      ) {
        logger.info(
          `✅ Лимитный ордер успешно размещен (orderId: ${response.result.orderId}).`
        );

        // АЛЬТЕРНАТИВНАЯ ПОПЫТКА: Если ордер не появляется в интерфейсе, пробуем другой способ
        if (side === "Buy" && orderPrice < currentCandle.close) {
          logger.info(
            "🔄 АЛЬТЕРНАТИВНАЯ ПОПЫТКА: Размещаем ордер с улучшенными параметрами для видимости..."
          );

          try {
            const alternativeParams = {
              category: "linear" as const,
              symbol: this.SYMBOL,
              side: side,
              orderType: "Limit" as const,
              qty: contractSize,
              price: (currentCandle.close + 1).toString(), // Чуть выше рынка для Buy
              timeInForce: "GTC" as const,
              orderLinkId: `ALT_${Date.now()}`, // Уникальный ID
              positionIdx: 0 as const
            };

            const altResponse = await this.client.submitOrder(
              alternativeParams
            );
            logger.info(
              `🔄 Альтернативный ордер: RetCode=${altResponse.retCode}, OrderId=${altResponse.result?.orderId}`
            );
          } catch (altError) {
            logger.warn("⚠️ Альтернативная попытка не удалась:", altError);
          }
        }

        // ДИАГНОСТИКА: Проверяем где именно размещен ордер
        setTimeout(async () => {
          logger.info(
            "🔍 ДИАГНОСТИКА РАЗМЕЩЕНИЯ ОРДЕРА: Ищем ордер на всех типах счетов..."
          );

          try {
            // Проверяем Linear счет
            const linearOrders = await this.client.getActiveOrders({
              category: "linear",
              symbol: this.SYMBOL
            });
            logger.info(
              `📋 LINEAR активные ордера: ${linearOrders.result?.list?.length ||
                0}`
            );

            // Проверяем Spot счет
            const spotOrders = await this.client.getActiveOrders({
              category: "spot",
              symbol: this.SYMBOL
            });
            logger.info(
              `📋 SPOT активные ордера: ${spotOrders.result?.list?.length || 0}`
            );

            // Проверяем Option счет
            try {
              const optionOrders = await this.client.getActiveOrders({
                category: "option",
                symbol: this.SYMBOL
              });
              logger.info(
                `📋 OPTION активные ордера: ${optionOrders.result?.list
                  ?.length || 0}`
              );
            } catch (optionError) {
              logger.info(`📋 OPTION счет недоступен: ${optionError}`);
            }

            // Проверяем конкретный ордер по ID
            const specificOrder = await this.client.getActiveOrders({
              category: "linear",
              symbol: this.SYMBOL,
              orderId: response.result.orderId
            });

            if (specificOrder.result?.list?.[0]) {
              const order = specificOrder.result.list[0];
              logger.info(
                `🎯 НАЙДЕН ОРДЕР: Статус=${order.orderStatus}, Цена=${order.price}, Размер=${order.qty}`
              );
              logger.info(
                `🎯 Детали: timeInForce=${order.timeInForce}, triggerBy=${order.triggerBy}, orderLinkId=${order.orderLinkId}`
              );
            } else {
              logger.warn(
                `❌ ОРДЕР НЕ НАЙДЕН по ID ${response.result.orderId} в активных ордерах!`
              );
            }
          } catch (diagError) {
            logger.error("❌ Ошибка диагностики размещения ордера:", diagError);
          }
        }, 2000); // Проверяем через 2 секунды

        this.activePosition = {
          side: side,
          entryPrice: currentCandle.close,
          entryTime: currentCandle.timestamp,
          isTrailingActive: false,
          lastTrailingStopPrice: null,
          orderId: response.result.orderId,
          // Сохраняем TP/SL для установки после исполнения ордера
          plannedTakeProfit: takeProfit,
          plannedStopLoss: stopLoss,
          executionNotificationSent: false // Инициализируем флаг уведомлений
        };

        // TP/SL будут установлены ПОСЛЕ исполнения ордера
        logger.info(
          `📝 TP/SL запланированы: ТП=${takeProfit.toFixed(
            1
          )}, СЛ=${stopLoss.toFixed(1)} (установятся после исполнения)`
        );

        const message = this.notificationService.formatOrderPlacedAlert(
          this.activePosition,
          takeProfit,
          stopLoss,
          signalCandle,
          currentCandle,
          orderPrice
        );
        this.callbacks.onTradeOperation(message);
        logger.info(
          `✅ Лимитный ордер размещен и уведомление отправлено. Ожидаем исполнения...`
        );

        // Запускаем немедленную проверку исполнения
        setTimeout(async () => {
          await this.checkOrderExecution();
        }, 1000); // Проверяем через 1 сек

        // Дополнительные проверки для выявления задержек API
        setTimeout(async () => {
          logger.info("🔍 Дополнительная проверка статуса ордера (30 сек)");
          await this.checkOrderExecution();
        }, 30000); // Проверяем через 30 сек

        setTimeout(async () => {
          logger.info("🔍 Дополнительная проверка статуса ордера (2 мин)");
          await this.checkOrderExecution();
        }, 120000); // Проверяем через 2 мин

        // Запускаем регулярную проверку исполнения
        this.startTrailingStopCheck();
      } else {
        logger.error(
          `❌ Лимитный ордер не был размещен. Код: ${response.retCode}, сообщение: ${response.retMsg}`
        );
        if (response.retCode === 110007) {
          logger.error(
            `💡 Рекомендация: Пополните счет или уменьшите размер позиции TRADE_SIZE_USD в настройках`
          );
        }
      }
    } catch (error) {
      logger.error("❌ Ошибка при открытии лимитного ордера:", error);
    } finally {
      this.isOpeningPosition = false;
      logger.info("🔓 Разблокировка флага открытия позиции");
    }
  }

  public async closePosition(
    triggeringCandle: Candle,
    reason: string
  ): Promise<void> {
    if (!this.activePosition) return;

    const positionToClose = { ...this.activePosition };
    this.activePosition = null;
    this.stopTrailingStopCheck();

    // Сбрасываем текущий сигнал чтобы можно было искать новые
    this.resetSignal();
    logger.info(
      "🔄 Сигнал сброшен при закрытии позиции - теперь можно искать новые сигналы"
    );

    try {
      const closeSide: OrderSideV5 =
        positionToClose.side === "Buy" ? "Sell" : "Buy";
      const contractSize = (
        this.TRADE_SIZE_USD / positionToClose.entryPrice
      ).toFixed(3);

      logger.info(`🎯 Попытка закрытия позиции (Лимитный ордер): ${reason}`);
      logger.info(
        `📈 Направление закрытия: ${closeSide}, Размер: ${contractSize}`
      );

      // Получаем текущую рыночную цену для лимитного ордера закрытия
      const tickerResponse = await this.client.getTickers({
        category: "linear",
        symbol: this.SYMBOL
      });

      let closePrice = triggeringCandle.close; // По умолчанию цена триггера

      if (tickerResponse.retCode === 0 && tickerResponse.result?.list?.[0]) {
        const currentMarketPrice = Number(
          tickerResponse.result.list[0].lastPrice
        );

        // Для быстрого закрытия используем небольшое проскальзывание в нашу пользу
        // Если закрываем лонг (продаем) - ставим цену немного ниже рынка для быстрого исполнения
        // Если закрываем шорт (покупаем) - ставим цену немного выше рынка для быстрого исполнения
        const slippagePoints = 25; // Проскальзывание для быстрого исполнения
        closePrice =
          closeSide === "Sell"
            ? currentMarketPrice - slippagePoints // Продаем ниже рынка
            : currentMarketPrice + slippagePoints; // Покупаем выше рынка

        logger.info(
          `📊 Рыночная цена: ${currentMarketPrice}, Цена закрытия: ${closePrice} (${
            closeSide === "Sell" ? "-" : "+"
          }${slippagePoints} пунктов для быстрого исполнения)`
        );
      }

      const response = await this.client.submitOrder({
        category: "linear",
        symbol: this.SYMBOL,
        side: closeSide,
        orderType: "Limit",
        qty: contractSize,
        price: closePrice.toString(),
        timeInForce: "IOC", // Immediate or Cancel для быстрого исполнения
        reduceOnly: true
      });

      logger.info(
        `📡 Ответ от API при закрытии позиции: RetCode=${response.retCode}, RetMsg=${response.retMsg}`
      );

      if (response.retCode === 0) {
        logger.info(`✅ Позиция успешно закрыта лимитным ордером.`);
        const message = this.notificationService.formatTradeCloseAlert(
          positionToClose,
          triggeringCandle.close,
          reason
        );
        this.callbacks.onTradeOperation(message);
      } else {
        logger.error(
          `❌ Ошибка при закрытии позиции лимитным ордером. Код: ${response.retCode}, сообщение: ${response.retMsg}. Возможно, позиция уже была закрыта.`
        );
      }
    } catch (error) {
      logger.error("❌ Критическая ошибка при закрытии позиции:", error);
    }
  }

  private startTrailingStopCheck(): void {
    this.stopTrailingStopCheck();

    this.trailingStopInterval = setInterval(async () => {
      await this.updateTrailingStop();
    }, this.TRAILING_STOP_INTERVAL_MS);
    logger.info(
      `⏱️ Трейлинг-стоп активирован с интервалом ${this
        .TRAILING_STOP_INTERVAL_MS / 1000} сек.`
    );
  }

  private stopTrailingStopCheck(): void {
    if (this.trailingStopInterval) {
      clearInterval(this.trailingStopInterval);
      this.trailingStopInterval = null;
      logger.info("⏱️ Трейлинг-стоп деактивирован.");
    }
  }

  private async updateTrailingStop(): Promise<void> {
    // Проверяем синхронизацию позиций
    const isSynced = await this.checkPositionSync();
    if (!isSynced || !this.activePosition) {
      return;
    }

    // ВАЖНО: Если есть orderId, сначала проверяем не исполнился ли лимитный ордер
    if (
      this.activePosition &&
      this.activePosition.orderId &&
      !this.activePosition.isTrailingActive
    ) {
      const orderFilled = await this.checkOrderExecution();
      if (!orderFilled) {
        // Ордер еще не исполнился - трейлинг не работает
        // НЕ логируем каждые 3 секунды, только если нужно
        return;
      }
    }

    if (!this.activePosition) {
      this.stopTrailingStopCheck();
      return;
    }

    try {
      const response = await this.client.getTickers({
        category: "linear",
        symbol: this.SYMBOL
      });

      if (
        response.retCode === 0 &&
        response.result.list &&
        response.result.list[0]
      ) {
        const currentPrice = Number(response.result.list[0].lastPrice);
        const entryPrice = this.activePosition.entryPrice;
        const side = this.activePosition.side;

        const profitPoints =
          side === "Buy"
            ? currentPrice - entryPrice
            : entryPrice - currentPrice;

        // Логируем только каждые 30 секунд чтобы не спамить
        const shouldLog =
          !this.lastTrailingLogTime ||
          Date.now() - this.lastTrailingLogTime > 30000;

        if (shouldLog) {
          logger.info(
            `📊 ТРЕЙЛИНГ АНАЛИЗ: Текущая цена=${currentPrice}, Вход=${entryPrice}, Прибыль=${profitPoints.toFixed(
              1
            )} пунктов, Активация=${this.TRAILING_ACTIVATION_POINTS}`
          );
          this.lastTrailingLogTime = Date.now();
        }

        if (profitPoints >= this.TRAILING_ACTIVATION_POINTS) {
          const newStopPrice =
            side === "Buy"
              ? currentPrice - this.TRAILING_DISTANCE
              : currentPrice + this.TRAILING_DISTANCE;

          const shouldUpdate =
            !this.activePosition.isTrailingActive ||
            (side === "Buy" &&
              newStopPrice >
                (this.activePosition.lastTrailingStopPrice || 0)) ||
            (side === "Sell" &&
              newStopPrice <
                (this.activePosition.lastTrailingStopPrice || Infinity));

          if (shouldLog || shouldUpdate) {
            logger.info(
              `🎯 ТРЕЙЛИНГ УСЛОВИЕ: Новый стоп=${newStopPrice.toFixed(
                1
              )}, Текущий=${
                this.activePosition.lastTrailingStopPrice
              }, Нужно обновить=${shouldUpdate}`
            );
          }

          if (shouldUpdate) {
            let tpSlParams: any = {
              category: "linear",
              symbol: this.SYMBOL,
              stopLoss: newStopPrice.toString(),
              slTriggerBy: "MarkPrice",
              positionIdx: 0
            };

            if (!this.activePosition.isTrailingActive) {
              logger.info("🚀 АКТИВАЦИЯ ТРЕЙЛИНГ-СТОПА!");
              this.callbacks.onTradeOperation(
                this.notificationService.formatTrailingStopActivation()
              );
              // Убираем takeProfit при активации трейлинга
              tpSlParams.takeProfit = "0";
              tpSlParams.tpTriggerBy = "MarkPrice";
              this.activePosition.isTrailingActive = true;
            }

            const tpSlResponse = await this.client.setTradingStop(tpSlParams);

            if (tpSlResponse.retCode === 0) {
              this.activePosition.lastTrailingStopPrice = newStopPrice;

              const updateMessage = this.notificationService.formatTrailingStopUpdate(
                newStopPrice,
                this.TRAILING_DISTANCE,
                currentPrice
              );
              logger.info(updateMessage);

              // ЛОГИКА ОГРАНИЧЕНИЯ УВЕДОМЛЕНИЙ О ТРЕЙЛИНГЕ
              const now = Date.now();
              const timeSinceLastNotification =
                now - this.lastTrailingNotificationTime;
              const stopPriceChange = Math.abs(
                newStopPrice - this.lastTrailingStopPrice
              );

              const shouldNotify =
                !this.activePosition.isTrailingActive || // Первая активация трейлинга
                timeSinceLastNotification > 300000 || // Прошло больше 5 минут
                stopPriceChange > 100; // Стоп передвинулся больше чем на 100 пунктов

              if (shouldNotify) {
                this.callbacks.onTradeOperation(updateMessage);
                this.lastTrailingNotificationTime = now;
                this.lastTrailingStopPrice = newStopPrice;
                logger.info("📢 Уведомление о трейлинге отправлено");
              } else {
                logger.info(
                  `📢 Уведомление о трейлинге пропущено (${Math.round(
                    timeSinceLastNotification / 1000
                  )} сек назад, изменение ${stopPriceChange.toFixed(
                    1
                  )} пунктов)`
                );
              }
            } else {
              logger.error(
                `❌ Ошибка обновления трейлинг-стопа: ${tpSlResponse.retMsg}`
              );
            }
          }
        } else {
          if (shouldLog) {
            logger.info(
              `⏳ ТРЕЙЛИНГ ОЖИДАНИЕ: Прибыль ${profitPoints.toFixed(1)} < ${
                this.TRAILING_ACTIVATION_POINTS
              } пунктов активации`
            );
          }
        }
      }
    } catch (error) {
      logger.error("❌ Ошибка при обновлении трейлинг-стопа:", error);
    }
  }

  private async checkOrderExecution(): Promise<boolean> {
    if (!this.activePosition?.orderId) {
      return false;
    }

    try {
      const orderPlacedTime = this.activePosition.entryTime;
      const timeSinceOrder = Math.round((Date.now() - orderPlacedTime) / 1000);

      logger.info(
        `⏰ Проверка статуса ордера ${this.activePosition.orderId} (${timeSinceOrder} сек назад)`
      );

      // Проверяем статус ордера
      const orderResponse = await this.client.getActiveOrders({
        category: "linear",
        symbol: this.SYMBOL,
        orderId: this.activePosition.orderId
      });

      logger.info(
        `📡 Ответ API проверки ордера: RetCode=${
          orderResponse.retCode
        }, Found=${orderResponse.result?.list?.length || 0} ордеров`
      );

      if (orderResponse.retCode === 0 && orderResponse.result?.list?.[0]) {
        const order = orderResponse.result.list[0];

        logger.info(
          `📊 Статус ордера: ${order.orderStatus}, Размер: ${
            order.qty
          }, Исполнено: ${order.cumExecQty || 0}`
        );

        if (order.orderStatus === "Filled") {
          logger.info(
            `✅ Лимитный ордер исполнен! Средняя цена: ${order.avgPrice}`
          );

          // Обновляем информацию о позиции
          this.activePosition.entryPrice = Number(order.avgPrice);
          this.activePosition.entryTime = Number(order.updatedTime);

          // Устанавливаем запланированные TP/SL теперь, когда позиция реально открыта
          if (
            this.activePosition.plannedTakeProfit &&
            this.activePosition.plannedStopLoss
          ) {
            try {
              const tpSlResponse = await this.client.setTradingStop({
                category: "linear",
                symbol: this.SYMBOL,
                takeProfit: this.activePosition.plannedTakeProfit.toString(),
                stopLoss: this.activePosition.plannedStopLoss.toString(),
                positionIdx: 0,
                tpTriggerBy: "MarkPrice",
                slTriggerBy: "MarkPrice"
              });

              if (tpSlResponse.retCode === 0) {
                logger.info(
                  `🛡️ TP/SL успешно установлены: ТП=${this.activePosition.plannedTakeProfit.toFixed(
                    1
                  )}, СЛ=${this.activePosition.plannedStopLoss.toFixed(1)}`
                );
              } else {
                logger.warn(
                  `⚠️ Не удалось установить TP/SL: ${tpSlResponse.retMsg}`
                );
              }
            } catch (tpSlError) {
              logger.warn("⚠️ Ошибка при установке TP/SL:", tpSlError);
            }
          }

          // Отправляем уведомление о реальном исполнении ордера ТОЛЬКО ОДИН РАЗ
          if (!this.activePosition.executionNotificationSent) {
            const message = this.notificationService.formatOrderExecutedAlert(
              this.activePosition,
              Number(order.avgPrice)
            );
            this.callbacks.onTradeOperation(message);
            this.activePosition.executionNotificationSent = true; // Помечаем что уведомление отправлено
            logger.info("📢 Уведомление об исполнении ордера отправлено");
          } else {
            logger.info(
              "📢 Уведомление об исполнении уже было отправлено ранее"
            );
          }

          // Запускаем трейлинг-стоп теперь, когда позиция реально открыта
          this.startTrailingStopCheck();

          return true;
        } else {
          logger.info(
            `⏳ Ордер еще не исполнен. Статус: ${order.orderStatus} (${timeSinceOrder} сек ожидания)`
          );
          return false;
        }
      } else if (
        orderResponse.retCode === 0 &&
        (!orderResponse.result?.list || orderResponse.result.list.length === 0)
      ) {
        // Ордер не найден в активных - возможно уже исполнен или отменен
        logger.warn(
          `⚠️ Ордер ${this.activePosition.orderId} не найден в активных ордерах через ${timeSinceOrder} сек. Проверяем историю...`
        );

        // Проверяем историю ордеров
        const historyResponse = await this.client.getHistoricOrders({
          category: "linear",
          symbol: this.SYMBOL,
          orderId: this.activePosition.orderId
        });

        if (
          historyResponse.retCode === 0 &&
          historyResponse.result?.list?.[0]
        ) {
          const historicOrder = historyResponse.result.list[0];
          logger.info(
            `📚 Найден в истории: Статус=${historicOrder.orderStatus}, Исполнено=${historicOrder.cumExecQty}`
          );

          if (historicOrder.orderStatus === "Filled") {
            logger.info("✅ Ордер был исполнен (найден в истории)");
            // Обрабатываем как исполненный ордер
            this.activePosition.entryPrice = Number(
              historicOrder.avgPrice || historicOrder.price
            );
            this.activePosition.entryTime = Number(historicOrder.updatedTime);
            return true;
          }
        }

        return false;
      }

      return false;
    } catch (error) {
      logger.error("❌ Ошибка при проверке статуса ордера:", error);
      return false;
    }
  }

  private verifyVSALogic(
    signalCandle: Candle,
    side: OrderSideV5
  ): { isValid: boolean; explanation: string; error?: string } {
    // VSA логика:
    // 1. Зеленая свеча (рост) с высоким объемом = институционалы продают → мы продаем (Sell/Short)
    // 2. Красная свеча (падение) с высоким объемом = институционалы покупают → мы покупаем (Buy/Long)

    const candleDirection = signalCandle.isGreen
      ? "зеленая (рост)"
      : "красная (падение)";
    const expectedSide = signalCandle.isGreen ? "Sell" : "Buy";
    const expectedAction = signalCandle.isGreen
      ? "ШОРТ (продажа)"
      : "ЛОНГ (покупка)";

    if (side !== expectedSide) {
      return {
        isValid: false,
        explanation: `Ошибка направления: ${candleDirection} свеча требует ${expectedAction}`,
        error: `Сигнальная свеча ${candleDirection}, ожидается ${expectedAction}, но выбрано ${side}`
      };
    }

    return {
      isValid: true,
      explanation: `Корректно: ${candleDirection} свеча → ${expectedAction} (${side})`
    };
  }

  private async checkPositionSync(): Promise<boolean> {
    if (!this.activePosition) {
      return true; // Нет внутренней позиции - ОК
    }

    // ВАЖНО: Если есть orderId, значит ордер размещен но возможно еще не исполнен
    // В этом случае реальной позиции на бирже может еще не быть
    if (this.activePosition.orderId) {
      try {
        // Проверяем статус ордера
        const orderResponse = await this.client.getActiveOrders({
          category: "linear",
          symbol: this.SYMBOL,
          orderId: this.activePosition.orderId
        });

        if (orderResponse.retCode === 0 && orderResponse.result?.list?.[0]) {
          const order = orderResponse.result.list[0];
          if (
            order.orderStatus === "New" ||
            order.orderStatus === "PartiallyFilled"
          ) {
            // Ордер еще активен - это нормально что позиции нет на бирже
            return true;
          }
        }
      } catch (orderError) {
        logger.warn(
          "⚠️ Ошибка при проверке статуса ордера в checkPositionSync:",
          orderError
        );
      }
    }

    try {
      const positionsResponse = await this.client.getPositionInfo({
        category: "linear",
        symbol: this.SYMBOL
      });

      if (positionsResponse.retCode === 0 && positionsResponse.result?.list) {
        const openPositions = positionsResponse.result.list.filter(
          pos => Number(pos.size) > 0
        );

        if (openPositions.length === 0) {
          // Позиция действительно отсутствует на бирже
          // Но проверим - может это потому что ордер еще не исполнен?
          if (this.activePosition.orderId) {
            logger.info(
              "🔍 ПРОВЕРКА СИНХРОНИЗАЦИИ: Позиции нет на бирже, но есть активный ордер. Возможно ордер еще не исполнен."
            );
            return true; // Не сбрасываем позицию - ждем исполнения ордера
          }

          logger.info(
            "🔄 РУЧНОЕ/АВТОМАТИЧЕСКОЕ ЗАКРЫТИЕ ОБНАРУЖЕНО: Позиция закрыта (TP/SL или вручную), обновляем внутреннее состояние"
          );

          // Сохраняем информацию о позиции для уведомления
          const closedPosition = { ...this.activePosition };
          this.activePosition = null;
          this.stopTrailingStopCheck();

          // Сбрасываем текущий сигнал чтобы можно было искать новые
          this.resetSignal();
          logger.info("🔄 Сигнал сброшен - теперь можно искать новые сигналы");

          // Получаем текущую рыночную цену для расчета P&L
          try {
            const tickerResponse = await this.client.getTickers({
              category: "linear",
              symbol: this.SYMBOL
            });

            let closePrice = closedPosition.entryPrice; // Fallback
            if (
              tickerResponse.retCode === 0 &&
              tickerResponse.result?.list?.[0]
            ) {
              closePrice = Number(tickerResponse.result.list[0].lastPrice);
            }

            // Отправляем детальное уведомление о закрытии
            const closeMessage = this.notificationService.formatTradeCloseAlert(
              closedPosition,
              closePrice,
              "Take Profit, Stop Loss или ручное закрытие"
            );
            this.callbacks.onTradeOperation(closeMessage);
          } catch (priceError) {
            logger.warn(
              "⚠️ Ошибка при получении цены для уведомления о закрытии:",
              priceError
            );
            // Fallback к простому уведомлению
            const closeMessage =
              "🔔 ПОЗИЦИЯ ЗАКРЫТА\n\nПозиция была закрыта (Take Profit, Stop Loss или вручную)";
            this.callbacks.onTradeOperation(closeMessage);
          }

          return false; // Позиция была рассинхронизирована
        }
      }
    } catch (syncError) {
      logger.warn("⚠️ Ошибка при проверке синхронизации позиций:", syncError);
    }

    return true; // Позиция синхронизирована
  }
}
