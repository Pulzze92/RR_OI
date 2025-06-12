import { RestClientV5, WebsocketClient, WsKey, WS_KEY_MAP } from "bybit-api";
import { logger } from "../utils/logger";
import { Candle } from "./bybit.types";
import { NotificationService } from "./notificationService";
import {
  TradingLogicService,
  TradingLogicCallbacks
} from "./tradingLogicService";

export class BybitService {
  private wsClient!: WebsocketClient;
  private readonly client: RestClientV5;
  private candleHistory: Candle[] = [];
  private lastLogTime: number = 0;
  private restCheckInterval: NodeJS.Timeout | null = null;
  private readonly REST_CHECK_INTERVAL = 5 * 60 * 1000; // 5 минут

  private readonly apiKey: string;
  private readonly apiSecret: string;

  private readonly SYMBOL = "SOLUSDT";
  private readonly CANDLE_INTERVAL: string = "60";
  private readonly CANDLE_HISTORY_SIZE = 6;
  private readonly INITIAL_HISTORY_HOURS = 48;
  private readonly LOG_INTERVAL = 15 * 60 * 1000;
  private readonly RETROSPECTIVE_ANALYSIS_SIZE = 12;

  private readonly TRADE_SIZE_USD = 5000;
  private readonly TAKE_PROFIT_POINTS = 3;
  private readonly STOP_LOSS_POINTS = 3;
  private readonly TRAILING_ACTIVATION_POINTS = 1;
  private readonly TRAILING_DISTANCE = 0.5;
  private readonly VOLUME_THRESHOLD = 600000;
  private readonly USE_TRAILING_STOP: boolean = false; // Явно указываем тип boolean

  private onTradeUpdate: (message: string) => void;
  private onSignalUpdate: (message: string) => void;

  private notificationService: NotificationService;
  private tradingLogicService: TradingLogicService;

  constructor(
    apiKey: string,
    apiSecret: string,
    onTradeUpdate: (message: string) => void,
    onSignalUpdate: (message: string) => void,
    volumeMultiplierParam?: number,
    useTrailingStop: boolean = false // Новый параметр
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.client = new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      recv_window: 5000
    });
    this.onTradeUpdate = onTradeUpdate;
    this.onSignalUpdate = onSignalUpdate;
    this.USE_TRAILING_STOP = useTrailingStop;

    this.notificationService = new NotificationService(
      this.SYMBOL,
      this.TRADE_SIZE_USD,
      this.STOP_LOSS_POINTS
    );

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
        useTrailingStop: this.USE_TRAILING_STOP // Передаем параметр
      }
    );
  }

  public async start(): Promise<void> {
    try {
      // Загружаем минимум последних свечей для корректного анализа объемов
      const allCandles = await this.loadInitialCandleHistory();

      // Анализируем историю для поиска сигналов
      await this.performRetrospectiveAnalysis(allCandles);

      // Синхронизируем состояние позиций при запуске
      await this.tradingLogicService.syncPositionState(allCandles);

      // Анализируем только ПОСЛЕДНЮЮ завершенную свечу для контекста
      await this.analyzeLastCandle();

      // Завершаем начальный анализ истории
      this.tradingLogicService.finishInitialHistoryAnalysis();

      this.subscribeToCandleUpdates();
      const startMessage =
        `🤖 БОТ ЗАПУЩЕН\n\n` +
        `📊 Торговая пара: ${this.SYMBOL}\n` +
        `💰 Размер позиции: $${this.TRADE_SIZE_USD}\n` +
        `⏱️ Таймфрейм: ${this.CANDLE_INTERVAL}h\n` +
        `📥 Загружено свечей для анализа: ${this.candleHistory.length}\n` +
        `🚫 Ретроспективный поиск сигналов отключен`;
      this.onTradeUpdate(startMessage);
      logger.info(
        "Сервис Bybit инициализирован, подписан на обновления свечей и стартовое сообщение отправлено."
      );
    } catch (error) {
      logger.error("Ошибка инициализации сервиса Bybit:", error);
      throw error;
    }
  }

  public stop(): void {
    if (this.wsClient) {
      this.wsClient.close(WS_KEY_MAP.linearPublic);
    }
    if (this.restCheckInterval) {
      clearInterval(this.restCheckInterval);
      this.restCheckInterval = null;
    }
    logger.info("Сервис Bybit остановлен");
  }

  private async loadInitialCandleHistory(): Promise<Candle[]> {
    try {
      const limit = 3; // Запрашиваем 3 свечи (2 закрытые + 1 текущая)
      const endTime = Date.now();
      const startTime = endTime - this.INITIAL_HISTORY_HOURS * 60 * 60 * 1000;

      const response = await this.client.getKline({
        category: "linear",
        symbol: this.SYMBOL,
        interval: this.CANDLE_INTERVAL as any,
        start: startTime,
        end: endTime,
        limit: limit
      });

      if (response.retCode === 0 && response.result && response.result.list) {
        const allCandles = response.result.list
          .map(k => {
            const timestamp = Number(k[0]);
            const open = Number(k[1]);
            const high = Number(k[2]);
            const low = Number(k[3]);
            const close = Number(k[4]);
            const volume = Number(k[5]);
            const turnover = Number(k[6]);
            const isGreen = close >= open;

            return {
              timestamp,
              open,
              high,
              low,
              close,
              volume,
              turnover,
              confirmed: true,
              isGreen
            };
          })
          .sort((a, b) => a.timestamp - b.timestamp);

        if (allCandles.length < 3) {
          logger.error(
            `❌ Получено недостаточно свечей: ${allCandles.length}, нужно минимум 3`
          );
          throw new Error("Insufficient candles received");
        }

        // Логируем все полученные свечи для диагностики
        logger.info(`🔍 КОНТЕКСТ АНАЛИЗА - Все полученные свечи:`);
        allCandles.forEach(candle => {
          logger.info(
            `   ${new Date(candle.timestamp).toLocaleTimeString()}: ${
              candle.isGreen ? "🟢" : "🔴"
            } Open=${candle.open} Close=${
              candle.close
            } Vol=${candle.volume.toFixed(2)}`
          );
        });

        // Берем две последние ЗАКРЫТЫЕ свечи (исключая текущую формирующуюся)
        const lastTwoClosedCandles = allCandles.slice(-3, -1);

        logger.info(`🔍 Для анализа берем две последние ЗАКРЫТЫЕ свечи:`);
        lastTwoClosedCandles.forEach(candle => {
          logger.info(
            `   ${new Date(candle.timestamp).toLocaleTimeString()}: ${
              candle.isGreen ? "🟢" : "🔴"
            } Open=${candle.open} Close=${
              candle.close
            } Vol=${candle.volume.toFixed(2)}`
          );
        });

        // Сохраняем все 3 свечи для истории
        this.candleHistory = allCandles;

        logger.info(
          `Загружено ${allCandles.length} свечей, для анализа используем 2 последние закрытые`
        );
        return allCandles;
      } else {
        logger.error(
          "Не удалось загрузить начальную историю свечей:",
          response.retMsg
        );
        throw new Error(
          "Failed to load initial candle history: " + response.retMsg
        );
      }
    } catch (error) {
      logger.error("Ошибка при загрузке истории свечей:", error);
      throw error;
    }
  }

  private async performRetrospectiveAnalysis(
    allCandles: Candle[]
  ): Promise<void> {
    logger.info(
      "🔍 Начинаем ретроспективный анализ для поиска активных сигналов..."
    );

    if (allCandles.length < 3) {
      logger.info("Недостаточно свечей для ретроспективного анализа");
      return;
    }

    // Берем две последние ЗАКРЫТЫЕ свечи (исключая текущую формирующуюся)
    const lastClosedCandle = allCandles[allCandles.length - 2];
    const previousClosedCandle = allCandles[allCandles.length - 3];

    if (!lastClosedCandle.confirmed || !previousClosedCandle.confirmed) {
      logger.info(`⏳ Пропуск незавершенной свечи в истории`);
      return;
    }

    logger.info("📊 АНАЛИЗ ОБЪЕМОВ ЗАКРЫТЫХ СВЕЧЕЙ:");
    logger.info(
      `   📈 Последняя закрытая (${new Date(
        lastClosedCandle.timestamp
      ).toLocaleTimeString()}): V=${lastClosedCandle.volume.toFixed(2)}, ${
        lastClosedCandle.isGreen ? "🟢" : "🔴"
      }`
    );
    logger.info(
      `   📈 Предыдущая закрытая (${new Date(
        previousClosedCandle.timestamp
      ).toLocaleTimeString()}): V=${previousClosedCandle.volume.toFixed(2)}, ${
        previousClosedCandle.isGreen ? "🟢" : "🔴"
      }`
    );
    logger.info(`   🎯 Порог объема: ${this.VOLUME_THRESHOLD}`);

    // Проверяем объем для обнаружения сигналов
    this.tradingLogicService.checkVolumeSpike(
      lastClosedCandle,
      previousClosedCandle
    );

    // Если найден сигнал, проверяем следующую свечу как подтверждающую
    if (this.tradingLogicService.getCurrentSignal()?.isActive) {
      await this.tradingLogicService.processCompletedCandle(
        lastClosedCandle,
        [previousClosedCandle, lastClosedCandle] // Передаем только две закрытые свечи
      );
    }
  }

  private subscribeToCandleUpdates(): void {
    this.wsClient = new WebsocketClient({
      key: this.apiKey,
      secret: this.apiSecret,
      market: "v5",

      // Увеличиваем интервал проверки соединения до 30 секунд
      pingInterval: 30000,

      // Увеличиваем таймаут ожидания pong до 10 секунд
      pongTimeout: 10000,

      // Увеличиваем задержку перед переподключением до 3 секунд
      reconnectTimeout: 3000
    });

    this.wsClient.subscribeV5(
      [`kline.${this.CANDLE_INTERVAL}.${this.SYMBOL}`],
      "linear"
    );

    this.wsClient.on("update", (data: any) => {
      if (data.topic && data.topic.startsWith("kline")) {
        const candleData = data.data[0];
        this.updateCandleHistory({
          timestamp: Number(candleData.start),
          open: Number(candleData.open),
          high: Number(candleData.high),
          low: Number(candleData.low),
          close: Number(candleData.close),
          volume: Number(candleData.volume),
          turnover: Number(candleData.turnover),
          confirmed: candleData.confirm === true,
          isGreen: Number(candleData.close) >= Number(candleData.open)
        });
      }
    });

    this.wsClient.on("close", () => {
      logger.info(
        "Соединение WebSocket закрыто. Попытка переподключения через 5 секунд..."
      );
      setTimeout(() => {
        logger.info("Переподключение WebSocket...");
        this.subscribeToCandleUpdates();
      }, 5000);
    });

    this.wsClient.on("open", (evt: { wsKey: WsKey; event: any }) => {
      logger.info(`Соединение WebSocket открыто. wsKey: ${evt.wsKey}`);
    });

    // Добавляем обработчик переподключения
    this.wsClient.on("reconnect", ({ wsKey }: { wsKey: string }) => {
      logger.info(`WebSocket переподключается... wsKey: ${wsKey}`);
    });

    this.wsClient.on("reconnected", (data: any) => {
      logger.info(`WebSocket переподключен. wsKey: ${data?.wsKey}`);
    });
  }

  private updateCandleHistory(newCandle: Candle): void {
    const currentTime = Date.now();
    if (currentTime - this.lastLogTime > this.LOG_INTERVAL) {
      logger.info(
        `Текущий объем формирующейся свечи (${new Date(
          newCandle.timestamp
        ).toLocaleTimeString()}): ${newCandle.volume.toFixed(2)}, Закрытие: ${
          newCandle.close
        }`
      );
      this.lastLogTime = currentTime;
    }

    const existingCandleIndex = this.candleHistory.findIndex(
      c => c.timestamp === newCandle.timestamp
    );

    if (existingCandleIndex !== -1) {
      this.candleHistory[existingCandleIndex] = newCandle;
    } else {
      logger.info(
        `🆕 ПОЛУЧЕНА НОВАЯ СВЕЧА (${new Date(
          newCandle.timestamp
        ).toLocaleTimeString()}): O=${newCandle.open} H=${newCandle.high} L=${
          newCandle.low
        } C=${newCandle.close} V=${newCandle.volume.toFixed(2)}`
      );
      this.candleHistory.push(newCandle);
      if (this.candleHistory.length > this.CANDLE_HISTORY_SIZE) {
        this.candleHistory.shift();
      }
    }

    this.candleHistory.sort((a, b) => a.timestamp - b.timestamp);

    // Если это новая свеча (не обновление существующей)
    if (existingCandleIndex === -1) {
      logger.info(`📊 ИСТОРИЯ СВЕЧЕЙ ПОСЛЕ ДОБАВЛЕНИЯ НОВОЙ:`);
      this.candleHistory.forEach((candle, index) => {
        logger.info(
          `   ${index}: ${new Date(
            candle.timestamp
          ).toLocaleTimeString()} V=${candle.volume.toFixed(2)} ${
            candle.confirmed ? "✅" : "⏳"
          }`
        );
      });

      logger.info(
        `🔄 Передаем новую свечу в TradingLogicService для проверки условий входа...`
      );
      this.tradingLogicService.processCompletedCandle(newCandle, [
        ...this.candleHistory
      ]);
    }

    if (newCandle.confirmed) {
      logger.info(
        `🕯️ ЗАВЕРШЕННАЯ свеча (${new Date(
          newCandle.timestamp
        ).toLocaleTimeString()}): O=${newCandle.open} H=${newCandle.high} L=${
          newCandle.low
        } C=${newCandle.close} V=${newCandle.volume.toFixed(2)}`
      );

      // Проверяем, что предыдущая свеча тоже подтверждена
      const previousCandle = this.candleHistory[this.candleHistory.length - 2];
      if (!previousCandle?.confirmed) {
        logger.info(
          `⏳ ПРОПУСК ОБРАБОТКИ: Предыдущая свеча (${new Date(
            previousCandle?.timestamp
          ).toLocaleTimeString()}) еще не подтверждена`
        );
        return;
      }

      this.processCompletedCandle(newCandle);
    }
  }

  private processCompletedCandle(completedCandle: Candle): void {
    if (this.candleHistory.length < 2) {
      return;
    }

    const completedCandleActualIndex = this.candleHistory.findIndex(
      c => c.timestamp === completedCandle.timestamp
    );
    if (completedCandleActualIndex < 1) {
      logger.warn(
        `Не найдена предыдущая свеча для анализа завершенной свечи ${new Date(
          completedCandle.timestamp
        ).toLocaleTimeString()}`
      );
      return;
    }
    const previousCandle = this.candleHistory[completedCandleActualIndex - 1];

    this.tradingLogicService.checkVolumeSpike(completedCandle, previousCandle);
    this.tradingLogicService.processCompletedCandle(completedCandle, [
      ...this.candleHistory
    ]);
  }

  public async getAccountBalance(): Promise<any> {
    try {
      const response = await this.client.getWalletBalance({
        accountType: "UNIFIED"
      });
      if (
        response.retCode === 0 &&
        response.result.list &&
        response.result.list.length > 0
      ) {
        return response.result.list[0];
      }
      logger.error(
        "Ошибка при получении баланса или пустой список:",
        response.retMsg
      );
      return null;
    } catch (error) {
      logger.error("Исключение при получении баланса:", error);
      return null;
    }
  }

  private async analyzeLastCandle(): Promise<void> {
    if (this.candleHistory.length >= 3) {
      logger.info(`🔍 Проверка последних свечей на готовые сигналы...`);

      // Анализируем от НОВЫХ к СТАРЫМ
      for (let i = this.candleHistory.length - 1; i > 0; i--) {
        const currentCandle = this.candleHistory[i];
        const previousCandle = this.candleHistory[i - 1];

        // Пропускаем неподтвержденные свечи
        if (!currentCandle.confirmed || !previousCandle.confirmed) {
          logger.info(
            `⏳ Пропуск неподтвержденных свечей: ${new Date(
              currentCandle.timestamp
            ).toLocaleTimeString()} и ${new Date(
              previousCandle.timestamp
            ).toLocaleTimeString()}`
          );
          continue;
        }

        logger.info(
          `   Проверка свечи ${new Date(
            currentCandle.timestamp
          ).toLocaleTimeString()}: V=${currentCandle.volume.toFixed(2)}`
        );

        // Проверяем объем для обнаружения сигналов
        this.tradingLogicService.checkVolumeSpike(
          currentCandle,
          previousCandle
        );

        // Если найден сигнал, проверяем следующую свечу как подтверждающую
        if (this.tradingLogicService.getCurrentSignal()?.isActive) {
          // Проверяем следующую свечу после сигнальной
          if (i + 1 < this.candleHistory.length) {
            const confirmingCandle = this.candleHistory[i + 1];
            // Пропускаем неподтвержденную подтверждающую свечу
            if (!confirmingCandle.confirmed) {
              logger.info(
                `⏳ Пропуск неподтвержденной подтверждающей свечи: ${new Date(
                  confirmingCandle.timestamp
                ).toLocaleTimeString()}`
              );
              continue;
            }
            await this.tradingLogicService.processCompletedCandle(
              confirmingCandle,
              this.candleHistory
            );
          }
        }
      }
    }
  }
}
