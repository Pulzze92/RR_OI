import dotenv from "dotenv";
import { BinanceService } from "./services/binance";
import { TelegramService } from "./services/telegram";
import { logger } from "./utils/logger";
import {
  TradingLogicService,
  TradingLogicCallbacks,
  TradingLogicOptions
} from "./services/tradingLogicService";
import { CandleChartInterval } from "binance-api-node";
import { Candle } from "./services/binance.types";

dotenv.config();

const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  BINANCE_TESTNET,
  RISK_PERCENTAGE
} = process.env;

if (
  !BINANCE_API_KEY ||
  !BINANCE_API_SECRET ||
  !TELEGRAM_BOT_TOKEN ||
  !TELEGRAM_CHAT_ID
) {
  throw new Error("Missing required environment variables");
}

const riskPercentage = RISK_PERCENTAGE ? parseFloat(RISK_PERCENTAGE) : 95; // По умолчанию 95%

async function main() {
  try {
    const telegramService = new TelegramService(
      TELEGRAM_BOT_TOKEN as string,
      TELEGRAM_CHAT_ID as string
    );

    const handleTradeUpdate = async (message: string) => {
      try {
        await telegramService.sendMessage(message);
        logger.info("Message sent to Telegram");
      } catch (error) {
        logger.error("Failed to send message to Telegram:", {
          code: error.code,
          response: error.response?.body,
          stack: error.stack
        });
      }
      logger.info("Trade update notification sent via Telegram.");
    };

    const handleSignalUpdate = async (message: string) => {
      try {
        await telegramService.sendMessage(message);
        logger.info("Signal message sent to Telegram");
      } catch (error) {
        logger.error("Failed to send signal message to Telegram:", {
          code: error.code,
          response: error.response?.body,
          stack: error.stack
        });
      }
      logger.info("Signal update notification sent via Telegram.");
    };

    const binanceService = new BinanceService(
      BINANCE_API_KEY as string,
      BINANCE_API_SECRET as string,
      BINANCE_TESTNET === "true"
    );

    // Получаем реальный баланс
    const availableBalance = await binanceService.getUSDTBalance();
    if (availableBalance <= 0) {
      logger.error("❌ Недостаточно средств для торговли.");
      return;
    }

    // Рассчитываем размер позиции на основе % от баланса
    const leverageValue = 6; // Плечо
    const tradeSizeUsd =
      availableBalance * (riskPercentage / 100) * leverageValue;

    logger.info(
      `📊 Расчет размера позиции: ${availableBalance.toFixed(
        2
      )} USDT * ${riskPercentage}% * ${leverageValue}x плечо = ${tradeSizeUsd.toFixed(
        2
      )} USDT`
    );

    const tradingLogicCallbacks: TradingLogicCallbacks = {
      onTradeOperation: handleTradeUpdate,
      onSignalDetected: handleSignalUpdate
    };

    // Здесь вы можете настроить параметры вашей стратегии
    const tradingOptions: TradingLogicOptions = {
      symbol: "SOLUSDT",
      tradeSizeUsd: tradeSizeUsd, // Используем рассчитанный размер
      takeProfitPoints: 1.5,
      stopLossPoints: 1.5,
      trailingActivationPoints: 1,
      trailingDistance: 1.5,
      volumeThreshold: 100000, // Новый порог для Binance
      useTrailingStop: true,
      leverage: leverageValue // Устанавливаем кредитное плечо
    };

    const tradingLogicService = new TradingLogicService(
      binanceService.getClient(),
      new (require("./services/notificationService").NotificationService)(
        tradingOptions.symbol,
        tradingOptions.tradeSizeUsd,
        tradingOptions.stopLossPoints
      ),
      tradingLogicCallbacks,
      tradingOptions
    );

    // Инициализируем сервис для загрузки правил торговли
    await tradingLogicService.initialize();

    // Настраиваем callback для команды /restart
    telegramService.setRestartCallback(async () => {
      logger.info("🔄 Выполняется перезапуск бота по команде /restart");

      try {
        // Останавливаем текущие WebSocket соединения
        await binanceService.disconnect();

        // Ждем немного для корректного закрытия соединений
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Перезапускаем анализ истории
        logger.info("🔍 Перезапуск: Анализируем исторические данные...");
        const initialCandles = await binanceService.getHistoricalCandles(
          tradingOptions.symbol,
          "1h" as CandleChartInterval,
          5
        );

        await tradingLogicService.syncPositionState(initialCandles);

        // Запускаем исторический анализ
        await tradingLogicService.finishInitialHistoryAnalysis();

        // Перезапускаем WebSocket
        binanceService.startWebSocket(
          tradingOptions.symbol,
          async (candle: Candle) => {
            // Обработка новых свечей
            if (candle.confirmed) {
              logger.info(
                `📊 WebSocket: ${new Date(
                  candle.timestamp
                ).toLocaleString()} - V=${candle.volume.toFixed(2)} ✅`
              );

              // Добавляем свечу в историю
              const candleHistory = tradingLogicService.getCandleHistory();
              candleHistory.push(candle);

              // Ограничиваем историю последними 10 свечами
              if (candleHistory.length > 10) {
                candleHistory.shift();
              }

              // Ищем предыдущую свечу для сравнения
              let previousCandle = null;
              for (let i = candleHistory.length - 1; i >= 0; i--) {
                if (
                  candleHistory[i].timestamp < candle.timestamp &&
                  candleHistory[i].confirmed
                ) {
                  previousCandle = candleHistory[i];
                  break;
                }
              }

              if (previousCandle) {
                logger.info(
                  `🔍 Вызываем checkVolumeSpike: текущая=${new Date(
                    candle.timestamp
                  ).toLocaleString()}, предыдущая=${new Date(
                    previousCandle.timestamp
                  ).toLocaleString()}`
                );
                await tradingLogicService.checkVolumeSpike(
                  candle,
                  previousCandle,
                  candleHistory
                );
              } else {
                logger.info(
                  `⚠️ Нет подтвержденных предыдущих свечей, пропускаем checkVolumeSpike`
                );
              }
            } else {
              // НЕ логируем неподтвержденные свечи (избегаем спама)
              // logger.info(
              //   `📊 WebSocket: ${new Date(
              //     candle.timestamp
              //   ).toLocaleString()} - V=${candle.volume.toFixed(2)} ⏳`
              // );
            }
          }
        );

        logger.info("✅ Перезапуск бота завершен успешно");
      } catch (error) {
        logger.error("❌ Ошибка при перезапуске бота:", error);
        throw error;
      }
    });

    logger.info("Bot starting...");

    // Начальная синхронизация и запуск логики
    const initialCandles = await binanceService.getHistoricalCandles(
      tradingOptions.symbol,
      "1h" as CandleChartInterval,
      5 // Нам достаточно 5 последних свечей
    );
    await tradingLogicService.syncPositionState(initialCandles);

    // Анализируем исторические данные на наличие сигналов
    logger.info("🔍 Анализируем исторические данные на наличие сигналов...");
    if (initialCandles.length >= 5) {
      // Проверяем последние 5 свечей для более точного анализа
      const lastCandles = initialCandles.slice(-5);

      logger.info(`📊 Анализ последних 5 свечей:`);
      lastCandles.forEach((candle, index) => {
        logger.info(
          `   ${index + 1}. ${new Date(
            candle.timestamp
          ).toLocaleString()} - V=${candle.volume.toFixed(2)} ${
            candle.isGreen ? "🟢" : "🔴"
          }`
        );
      });
      logger.info(`   Порог объема: ${tradingOptions.volumeThreshold}`);

      // Ищем сигнальные свечи в последних 4 свечах (исключая самую последнюю)
      let foundSignal = false;
      const allSignals = []; // Массив всех найденных сигналов

      for (let i = 0; i < lastCandles.length - 1; i++) {
        const currentCandle = lastCandles[i];
        const previousCandle = i > 0 ? lastCandles[i - 1] : null;

        // Проверяем условия сигнала: объем > порога И > предыдущей свечи
        if (
          currentCandle.volume > tradingOptions.volumeThreshold &&
          (!previousCandle || currentCandle.volume > previousCandle.volume)
        ) {
          logger.info(
            `🎯 НАЙДЕН ИСТОРИЧЕСКИЙ СИГНАЛ: Свеча ${new Date(
              currentCandle.timestamp
            ).toLocaleString()} - V=${currentCandle.volume.toFixed(2)}`
          );
          // КЛАСТЕРНЫЙ АНАЛИЗ для исторического сигнала (только для недавних свечей)
          if (previousCandle) {
            // Всегда анализируем кластеры для исторических сигналов
            const clusterAnalysis = await tradingLogicService.analyzeVolumeClusters(
              currentCandle,
              previousCandle
            );

            // КЛАСТЕРНЫЙ АНАЛИЗ: распределение объема по третям
            const upperPercent = (
              (clusterAnalysis.upperClusterVolume / currentCandle.volume) *
              100
            ).toFixed(1);
            const middlePercent = (
              (clusterAnalysis.middleClusterVolume / currentCandle.volume) *
              100
            ).toFixed(1);
            const lowerPercent = (
              (clusterAnalysis.lowerClusterVolume / currentCandle.volume) *
              100
            ).toFixed(1);

            logger.info(
              `\n📊 КЛАСТЕРЫ: Верх=${upperPercent}% | Сред=${middlePercent}% | Низ=${lowerPercent}% | Зона=${clusterAnalysis.dominantZone}`
            );

            // ИСТОРИЧЕСКИЙ АНАЛИЗ OI 5м за час сигнала и вывод направления по OI
            try {
              const oiZones = await tradingLogicService.analyzeOpenInterestZones(
                currentCandle
              );
              if (oiZones) {
                const topVolZone =
                  clusterAnalysis.upperClusterVolume >=
                  clusterAnalysis.lowerClusterVolume
                    ? "upper"
                    : "lower";
                const zoneDelta =
                  topVolZone === "upper"
                    ? oiZones.upperDelta
                    : oiZones.lowerDelta;
                const oiTrend = zoneDelta >= 0 ? "рост" : "падение";
                const sideByOi =
                  topVolZone === "lower"
                    ? zoneDelta < 0
                      ? "ЛОНГ"
                      : "ШОРТ"
                    : zoneDelta < 0
                    ? "ШОРТ"
                    : "ЛОНГ";

                logger.info(
                  `📈 OI(5м/час): low=${oiZones.lowerDelta.toFixed(
                    2
                  )} | mid=${oiZones.middleDelta.toFixed(
                    2
                  )} | up=${oiZones.upperDelta.toFixed(
                    2
                  )} → зона=${topVolZone}, в зоне ${oiTrend} → ${sideByOi}`
                );
              }
            } catch (e) {
              // игнорируем ошибки OI в историческом анализе
            }

            // Проверяем подтверждение и актуальность сигнала
            const nextCandles = lastCandles.slice(i + 1);
            logger.info(
              `🔍 Ищем подтверждающую свечу для сигнала ${new Date(
                currentCandle.timestamp
              ).toLocaleString()} (V=${currentCandle.volume.toFixed(2)})`
            );
            logger.info(
              `   📊 Следующие свечи: ${nextCandles
                .map(
                  c =>
                    `${new Date(
                      c.timestamp
                    ).toLocaleTimeString()} (V=${c.volume.toFixed(2)})`
                )
                .join(", ")}`
            );

            const confirmingCandle = nextCandles.find(
              c => c.volume < currentCandle.volume
            );

            if (confirmingCandle) {
              logger.info(
                `✅ НАЙДЕНО ПОДТВЕРЖДЕНИЕ: Подтверждающая свеча ${new Date(
                  confirmingCandle.timestamp
                ).toLocaleString()}, V=${confirmingCandle.volume.toFixed(
                  2
                )} < ${currentCandle.volume.toFixed(2)}`
              );

              // Проверяем возможность входа для этого сигнала
              const confirmingIndex = lastCandles.findIndex(
                c => c.timestamp === confirmingCandle.timestamp
              );
              const entryIndex = confirmingIndex + 1; // Свеча для входа - следующая после подтверждающей
              let canEnter = false;

              // Проверяем свечу после подтверждающей по флагу confirmed
              if (entryIndex < lastCandles.length) {
                // Свеча после подтверждающей ЕСТЬ в истории - проверяем её флаг
                const entryCandle = lastCandles[entryIndex];
                if (!entryCandle.confirmed) {
                  // Свеча НЕ закрылась (confirmed = false) - проверяем 20-минутное окно
                  const currentTime = Date.now();
                  const entryCandleStart = entryCandle.timestamp;
                  const timeInCandle = currentTime - entryCandleStart;
                  const ENTRY_WINDOW_MS = 20 * 60 * 1000; // 20 минут

                  if (timeInCandle <= ENTRY_WINDOW_MS) {
                    logger.info(
                      `🎯 МОЖНО ВХОДИТЬ: Свеча ${new Date(
                        entryCandleStart
                      ).toLocaleTimeString()} еще активна, прошло ${Math.round(
                        timeInCandle / (60 * 1000)
                      )} мин (лимит: 20 мин)`
                    );
                    canEnter = true;
                  } else {
                    logger.info(
                      `⏰ ОКНО ВХОДА ЗАКРЫТО: Прошло ${Math.round(
                        timeInCandle / (60 * 1000)
                      )} мин от начала свечи ${new Date(
                        entryCandleStart
                      ).toLocaleTimeString()} (лимит: 20 мин)`
                    );
                    canEnter = false;
                  }
                } else {
                  logger.info(
                    "⚠️ МОМЕНТ ВХОДА ПРОПУЩЕН: Свеча после подтверждающей уже закрылась (confirmed=true)"
                  );
                }
              } else {
                // Свечи после подтверждающей НЕТ в истории
                // Проверяем, закрылась ли подтверждающая свеча и 20-минутное окно
                // Считаем свечу закрытой, если прошло больше часа с её начала
                const timeSinceConfirmingStart =
                  Date.now() - confirmingCandle.timestamp;
                const isConfirmingClosed =
                  confirmingCandle.confirmed ||
                  timeSinceConfirmingStart > 60 * 60 * 1000; // 1 час с начала свечи

                // ДИАГНОСТИКА: Логируем состояние подтверждающей свечи
                logger.info(`🔍 ДИАГНОСТИКА ПОДТВЕРЖДАЮЩЕЙ СВЕЧИ:`);
                logger.info(`   📊 confirmed: ${confirmingCandle.confirmed}`);
                logger.info(
                  `   ⏰ timeSinceConfirmingStart: ${Math.round(
                    timeSinceConfirmingStart / (60 * 1000)
                  )} мин`
                );
                logger.info(`   ✅ isConfirmingClosed: ${isConfirmingClosed}`);

                if (isConfirmingClosed) {
                  // Рассчитываем время начала следующей свечи
                  const nextCandleStart =
                    confirmingCandle.timestamp + 60 * 60 * 1000; // +1 час
                  const currentTime = Date.now();
                  const timeInNextCandle = currentTime - nextCandleStart;
                  const ENTRY_WINDOW_MS = 20 * 60 * 1000; // 20 минут

                  if (
                    timeInNextCandle >= 0 &&
                    timeInNextCandle <= ENTRY_WINDOW_MS
                  ) {
                    logger.info(
                      `🎯 МОЖНО ВХОДИТЬ: Подтверждающая закрылась, в следующей свече прошло ${Math.round(
                        timeInNextCandle / (60 * 1000)
                      )} мин (лимит: 20 мин)`
                    );
                    canEnter = true;
                  } else if (timeInNextCandle < 0) {
                    logger.info(
                      "⏳ ПОДТВЕРЖДАЮЩАЯ ЗАКРЫЛАСЬ, НО СЛЕДУЮЩАЯ СВЕЧА ЕЩЕ НЕ НАЧАЛАСЬ - ЖДЕМ!"
                    );
                    canEnter = false;
                  } else {
                    logger.info(
                      `⏰ ОКНО ВХОДА ЗАКРЫТО: В следующей свече прошло ${Math.round(
                        timeInNextCandle / (60 * 1000)
                      )} мин (лимит: 20 мин)`
                    );
                    canEnter = false;
                  }
                } else {
                  logger.info(
                    "⏳ ПОДТВЕРЖДАЮЩАЯ СВЕЧА ЕЩЕ НЕ ЗАКРЫЛАСЬ - ЖДЕМ В РЕАЛЬНОМ ВРЕМЕНИ!"
                  );
                  canEnter = false;
                }
              }

              // Добавляем сигнал в массив
              allSignals.push({
                candle: currentCandle,
                confirmingCandle: confirmingCandle,
                canEnter: canEnter,
                isActive: true // Изначально все сигналы активны
              });

              logger.info(
                `💾 Добавлен сигнал: ${new Date(
                  currentCandle.timestamp
                ).toLocaleString()}, V=${currentCandle.volume.toFixed(2)} (${
                  currentCandle.isGreen ? "🔴 ШОРТ" : "🟢 ЛОНГ"
                }), можно входить: ${canEnter ? "✅" : "❌"}`
              );
            } else {
              logger.info(
                "⚠️ Подтверждения в исторических данных нет, ждем новые свечи..."
              );
            }

            foundSignal = true;
            // Продолжаем поиск, чтобы найти последний самый мощный сигнал
          } else {
            // Если нет предыдущей свечи, используем старую логику
            logger.info(
              `   📊 Направление: ${
                currentCandle.isGreen ? "🔴 ШОРТ" : "🟢 ЛОНГ"
              } (${currentCandle.isGreen ? "зеленая свеча" : "красная свеча"})`
            );
          }
        }
      }

      // Обрабатываем все найденные сигналы
      if (allSignals.length > 0) {
        logger.info(`📊 Найдено сигналов: ${allSignals.length}`);

        // Деактивируем старые сигналы - оставляем активным только ПОСЛЕДНИЙ
        for (let i = 0; i < allSignals.length - 1; i++) {
          allSignals[i].isActive = false;
          logger.info(
            `❌ Деактивирован старый сигнал: ${new Date(
              allSignals[i].candle.timestamp
            ).toLocaleString()}`
          );
        }

        // Берем последний (самый свежий) сигнал
        const lastSignal = allSignals[allSignals.length - 1];
        logger.info(
          `✅ АКТИВНЫЙ СИГНАЛ: ${new Date(
            lastSignal.candle.timestamp
          ).toLocaleString()}, V=${lastSignal.candle.volume.toFixed(2)}`
        );
        // Направление уже определено выше через кластерный анализ

        // Устанавливаем последний сигнал
        tradingLogicService.setSignal({
          candle: lastSignal.candle,
          isActive: true,
          waitingForLowerVolume: true
        });

        // Проверяем возможность входа только для последнего сигнала
        if (lastSignal.canEnter) {
          logger.info("🚀 ВХОДИМ В ПОЗИЦИЮ ПО ПОСЛЕДНЕМУ СИГНАЛУ!");
          await tradingLogicService.processCompletedCandle(
            lastSignal.confirmingCandle,
            initialCandles
          );
        } else {
          logger.info(
            "⏳ Последний сигнал не подходит для входа, ждем новую возможность в реальном времени..."
          );
        }
      }

      if (!foundSignal) {
        logger.info("ℹ️ Активных сигналов в исторических данных не найдено");
      } else {
        // Проверяем, есть ли активный сигнал после анализа
        const currentSignal = tradingLogicService.getCurrentSignal();
        if (currentSignal) {
          logger.info(
            `✅ Активный сигнал установлен: ${new Date(
              currentSignal.candle.timestamp
            ).toLocaleString()}, V=${currentSignal.candle.volume.toFixed(2)}`
          );
        } else {
          logger.info("⚠️ Все найденные сигналы были устаревшими");
        }
      }
    }

    logger.info("Bot started successfully.");

    // Сохраняем последнюю свечу для сравнения и историю свечей
    let lastProcessedCandle = initialCandles[initialCandles.length - 1];
    let candleHistory = [...initialCandles]; // Копируем историю свечей

    // Проактивный сбор данных больше не нужен - используем минутные свечи

    // Подключаемся к WebSocket для получения свечей в реальном времени
    await binanceService.startWebSocket(
      tradingOptions.symbol,
      async (candle: Candle) => {
        try {
          // При переподключении WebSocket проверяем пропущенные свечи
          const timeSinceLastCandle =
            candle.timestamp - lastProcessedCandle.timestamp;
          const hourInMs = 60 * 60 * 1000;

          if (timeSinceLastCandle > hourInMs && candle.confirmed) {
            logger.warn(
              `⚠️ Обнаружен пропуск свечей после переподключения. Пропущено: ${Math.floor(
                timeSinceLastCandle / hourInMs
              )} часов`
            );

            // Загружаем пропущенные свечи
            const missedCandles = await binanceService.getHistoricalCandles(
              tradingOptions.symbol,
              "1h" as CandleChartInterval,
              Math.min(50, Math.floor(timeSinceLastCandle / hourInMs) + 5)
            );

            if (missedCandles.length > 0) {
              // Обрабатываем каждую пропущенную свечу
              for (const missedCandle of missedCandles) {
                if (
                  missedCandle.timestamp > lastProcessedCandle.timestamp &&
                  missedCandle.timestamp <= candle.timestamp &&
                  missedCandle.confirmed
                ) {
                  logger.info(
                    `🔄 Обрабатываем пропущенную свечу: ${new Date(
                      missedCandle.timestamp
                    ).toLocaleString()}`
                  );

                  // Добавляем в историю
                  candleHistory.push(missedCandle);
                  // Ограничиваем историю только нужными свечами
                  if (candleHistory.length > 5) {
                    candleHistory = candleHistory.slice(-5);
                  }

                  // Анализируем пропущенную свечу
                  const expectedPreviousTimestamp =
                    missedCandle.timestamp - 60 * 60 * 1000;
                  let previousCandle = null;

                  for (let i = candleHistory.length - 2; i >= 0; i--) {
                    if (
                      candleHistory[i].timestamp ===
                        expectedPreviousTimestamp &&
                      candleHistory[i].confirmed
                    ) {
                      previousCandle = candleHistory[i];
                      break;
                    }
                  }

                  if (previousCandle) {
                    await tradingLogicService.checkVolumeSpike(
                      missedCandle,
                      previousCandle,
                      candleHistory
                    );
                  }

                  lastProcessedCandle = missedCandle;
                }
              }

              logger.info(
                `✅ Восстановлено ${missedCandles.length} пропущенных свечей`
              );
            }
          }
          // Логируем все подтвержденные свечи для диагностики
          if (candle.confirmed) {
            logger.debug(
              `🔍 Подтвержденная свеча: ${new Date(
                candle.timestamp
              ).toLocaleString()}, lastProcessed: ${new Date(
                lastProcessedCandle.timestamp
              ).toLocaleString()}`
            );
          }

          // Обрабатываем только подтвержденные (закрытые) свечи
          if (
            candle.confirmed &&
            candle.timestamp >= lastProcessedCandle.timestamp
          ) {
            logger.info(
              `🕐 Свеча закрыта: ${new Date(
                candle.timestamp
              ).toLocaleString()}, V=${candle.volume.toFixed(2)}`
            );

            // Проверяем сигналы только для закрытых свечей
            logger.info(
              `🔍 ПРОВЕРЯЕМ СИГНАЛЫ: candleHistory.length = ${candleHistory.length}`
            );
            if (candleHistory.length > 0) {
              // Строго ищем свечу t-1h; если нет в локальной истории — подтянем через REST
              const expectedPreviousTimestamp =
                candle.timestamp - 60 * 60 * 1000; // -1 час
              let previousCandle = candleHistory.find(
                c => c.timestamp === expectedPreviousTimestamp && c.confirmed
              );

              if (!previousCandle) {
                try {
                  const recent = await binanceService.getHistoricalCandles(
                    tradingOptions.symbol,
                    "1h" as CandleChartInterval,
                    10
                  );
                  previousCandle = recent.find(
                    c =>
                      c.timestamp === expectedPreviousTimestamp && c.confirmed
                  ) as any;
                  if (previousCandle) {
                    logger.info(
                      `🔁 Подгрузили предыдущую свечу t-1h: ${new Date(
                        previousCandle.timestamp
                      ).toLocaleString()} (V=${previousCandle.volume.toFixed(
                        2
                      )})`
                    );
                  } else {
                    logger.warn(
                      `⚠️ Не удалось найти свечу t-1h=${new Date(
                        expectedPreviousTimestamp
                      ).toLocaleString()} ни в истории, ни через REST`
                    );
                  }
                } catch (e) {
                  logger.error(
                    "❌ Ошибка подгрузки предыдущей свечи через REST:",
                    e
                  );
                }
              }

              if (previousCandle) {
                logger.info(
                  `🔍 Вызываем checkVolumeSpike: текущая=${new Date(
                    candle.timestamp
                  ).toLocaleString()}, предыдущая=${new Date(
                    previousCandle.timestamp
                  ).toLocaleString()}`
                );
                await tradingLogicService.checkVolumeSpike(
                  candle,
                  previousCandle,
                  candleHistory
                );
              } else {
                logger.info(
                  `⚠️ Нет предыдущей свечи t-1h, пропускаем checkVolumeSpike`
                );
                // ДИАГНОСТИКА: Логируем состояние candleHistory
                logger.info(`🔍 ДИАГНОСТИКА candleHistory:`);
                for (let i = 0; i < candleHistory.length; i++) {
                  const c = candleHistory[i];
                  logger.info(
                    `   ${i}: ${new Date(
                      c.timestamp
                    ).toLocaleString()}, V=${c.volume.toFixed(2)}, confirmed=${
                      c.confirmed
                    }`
                  );
                }
              }
            } else {
              logger.info(
                `⚠️ candleHistory пустой, пропускаем checkVolumeSpike`
              );
            }

            // Проверяем, является ли эта свеча подтверждающей для активного сигнала
            const currentSignal = tradingLogicService.getCurrentSignal();
            const activePosition = tradingLogicService.getActivePosition();

            // ДИАГНОСТИКА: Логируем состояние активного сигнала
            if (currentSignal) {
              logger.info(`🔍 ДИАГНОСТИКА АКТИВНОГО СИГНАЛА:`);
              logger.info(
                `   📊 waitingForLowerVolume: ${currentSignal.waitingForLowerVolume}`
              );
              logger.info(`   📊 candle.volume: ${candle.volume.toFixed(2)}`);
              logger.info(
                `   📊 currentSignal.candle.volume: ${currentSignal.candle.volume.toFixed(
                  2
                )}`
              );
              logger.info(
                `   📊 candle.timestamp > currentSignal.candle.timestamp: ${candle.timestamp >
                  currentSignal.candle.timestamp}`
              );
              logger.info(`   📊 !activePosition: ${!activePosition}`);
            }

            if (
              currentSignal &&
              currentSignal.waitingForLowerVolume &&
              candle.volume < currentSignal.candle.volume &&
              candle.timestamp > currentSignal.candle.timestamp &&
              !activePosition // Убеждаемся, что нет активной позиции
            ) {
              // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: Проверяем, что это действительно первая подтверждающая свеча
              const signalCandleIndex = candleHistory.findIndex(
                c => c.timestamp === currentSignal.candle.timestamp
              );
              const currentCandleIndex = candleHistory.findIndex(
                c => c.timestamp === candle.timestamp
              );

              // Проверяем, что между сигнальной и текущей свечой нет других подтверждающих
              let hasEarlierConfirmation = false;
              if (signalCandleIndex !== -1 && currentCandleIndex !== -1) {
                for (
                  let i = signalCandleIndex + 1;
                  i < currentCandleIndex;
                  i++
                ) {
                  const betweenCandle = candleHistory[i];
                  if (betweenCandle.volume < currentSignal.candle.volume) {
                    hasEarlierConfirmation = true;
                    logger.info(
                      `⚠️ ПРОПУСК ВХОДА: Уже была подтверждающая свеча ${new Date(
                        betweenCandle.timestamp
                      ).toLocaleString()}, V=${betweenCandle.volume.toFixed(2)}`
                    );
                    break;
                  }
                }
              }

              if (!hasEarlierConfirmation) {
                logger.info(
                  `✅ ПОДТВЕРЖДАЮЩАЯ СВЕЧА ЗАКРЫЛАСЬ: V=${candle.volume.toFixed(
                    2
                  )} < ${currentSignal.candle.volume.toFixed(2)}`
                );
                // Направление определяется в openPosition через кластерный анализ
                logger.info(
                  "🚀 ВХОДИМ В ПОЗИЦИЮ СРАЗУ ПОСЛЕ ЗАКРЫТИЯ ПОДТВЕРЖДАЮЩЕЙ!"
                );

                // Открываем позицию немедленно
                await tradingLogicService.processCompletedCandle(
                  candle,
                  [...candleHistory, candle] // Передаем историю ВКЛЮЧАЯ текущую свечу
                );
                return; // Выходим, чтобы не дублировать processCompletedCandle
              } else {
                // Сбрасываем устаревший сигнал
                logger.info("🔄 Сбрасываем устаревший сигнал");
                tradingLogicService.clearSignal();
              }
            }

            // Убираем таймаут - он не нужен

            // Обрабатываем закрытую свечу
            await tradingLogicService.processCompletedCandle(
              candle,
              [...candleHistory, candle] // Передаем историю ВКЛЮЧАЯ текущую свечу
            );

            // Обновляем историю только для подтвержденных свечей
            lastProcessedCandle = candle;
            candleHistory.push(candle);

            // Ограничиваем историю только последними 3 свечами
            if (candleHistory.length > 3) {
              candleHistory = candleHistory.slice(-3);
            }

            // Проактивный сбор данных больше не нужен
          }
        } catch (error) {
          logger.error("❌ Ошибка при обработке WebSocket свечи:", error);
        }
      }
    );

    // Тут можно добавить логику подписки на обновления свечей через WebSocket,
    // если библиотека binance-api-node это поддерживает в удобном виде,
    // или периодически опрашивать новые свечи через REST.

    process.on("SIGINT", async () => {
      logger.info("Shutting down...");
      binanceService.stopWebSocket();
      // Здесь можно добавить логику graceful shutdown, если она необходима
      process.exit(0);
    });

    process.on("uncaughtException", error => {
      logger.error("Uncaught Exception:", error);
      process.exit(1);
    });

    process.on("unhandledRejection", (reason, promise) => {
      logger.error("Unhandled Rejection at:", promise, "reason:", reason);
      process.exit(1);
    });
  } catch (error) {
    logger.error("Failed to start bot:", error);
    process.exit(1);
  }
}

main();
