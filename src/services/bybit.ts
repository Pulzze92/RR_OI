import { RestClientV5, WebsocketClient, WsKey } from "bybit-api";
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

  private readonly apiKey: string;
  private readonly apiSecret: string;

  private readonly SYMBOL = "BTCUSDT";
  private readonly CANDLE_INTERVAL: string = "60";
  private readonly CANDLE_HISTORY_SIZE = 6;
  private readonly INITIAL_HISTORY_HOURS = 12;
  private readonly LOG_INTERVAL = 15 * 60 * 1000;
  private readonly RETROSPECTIVE_ANALYSIS_SIZE = 6;

  private readonly TRADE_SIZE_USD = 10000;
  private readonly TAKE_PROFIT_POINTS = 600;
  private readonly STOP_LOSS_POINTS = 450;
  private readonly TRAILING_ACTIVATION_POINTS = 400;
  private readonly TRAILING_DISTANCE = 50;
  private readonly VOLUME_THRESHOLD = 2000;
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
    this.client = new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      recv_window: 5000
    });
    this.onTradeUpdate = onTradeUpdate;
    this.onSignalUpdate = onSignalUpdate;

    if (typeof volumeMultiplierParam === "number") {
      this.VOLUME_MULTIPLIER = volumeMultiplierParam;
    }

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
        volumeMultiplier: this.VOLUME_MULTIPLIER
      }
    );
  }

  public async initialize(): Promise<void> {
    try {
      // Загружаем минимум последних свечей для корректного анализа объемов
      await this.loadInitialCandleHistory();

      // Синхронизируем состояние позиций при запуске
      await this.tradingLogicService.syncPositionState();

      // Анализируем только ПОСЛЕДНЮЮ завершенную свечу для контекста
      await this.analyzeLastCandle();

      this.subscribeToCandleUpdates();
      const startMessage =
        `🤖 БОТ ЗАПУЩЕН\n\n` +
        `📊 Торговая пара: ${this.SYMBOL}\n` +
        `💰 Размер позиции: $${this.TRADE_SIZE_USD}\n` +
        `📈 Множитель объема: ${this.VOLUME_MULTIPLIER}x\n` +
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

  private async loadInitialCandleHistory(): Promise<Candle[]> {
    try {
      const limit = Math.min(this.RETROSPECTIVE_ANALYSIS_SIZE, 200);
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

        // Логируем только последние 3 свечи для диагностики контекста
        logger.info(
          `🔍 КОНТЕКСТ АНАЛИЗА - Последние ${Math.min(
            3,
            allCandles.length
          )} свечи:`
        );
        allCandles.slice(-3).forEach(candle => {
          logger.info(
            `   ${new Date(candle.timestamp).toISOString()}: ${
              candle.isGreen ? "🟢" : "🔴"
            } Open=${candle.open} Close=${
              candle.close
            } Vol=${candle.volume.toFixed(2)}`
          );
        });

        // Сохраняем только последние CANDLE_HISTORY_SIZE свечей для рабочей истории
        this.candleHistory = allCandles.slice(-this.CANDLE_HISTORY_SIZE);

        // Возвращаем все свечи для ретроспективного анализа
        logger.info(
          `Загружено ${allCandles.length} свечей для ретроспективного анализа, рабочая история: ${this.candleHistory.length} свечей`
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

    if (allCandles.length < 2) {
      logger.info("Недостаточно свечей для ретроспективного анализа");
      return;
    }

    // Анализируем свечи, начиная со второй (нужна предыдущая для сравнения)
    for (let i = 1; i < allCandles.length; i++) {
      const currentCandle = allCandles[i];
      const previousCandle = allCandles[i - 1];

      // Проверяем объем для обнаружения сигналов
      this.tradingLogicService.checkVolumeSpike(currentCandle, previousCandle);

      // Если найден активный сигнал, проверяем последующие свечи на возможность входа
      const currentSignal = this.tradingLogicService.getCurrentSignal();
      if (currentSignal?.isActive) {
        logger.info(
          `📊 Найден сигнал в истории: ${new Date(
            currentSignal.candle.timestamp
          ).toLocaleTimeString()}, объем: ${currentSignal.candle.volume.toFixed(
            2
          )}`
        );

        // Проверяем все последующие свечи на возможность входа
        for (let j = i + 1; j < allCandles.length; j++) {
          const laterCandle = allCandles[j];
          this.tradingLogicService.processCompletedCandle(
            laterCandle,
            allCandles.slice(0, j + 1)
          );

          // Если уже есть активная позиция, прекращаем анализ
          if (this.tradingLogicService.getActivePosition()) {
            logger.info(
              "✅ Найдена возможность входа в ретроспективном анализе, позиция открыта"
            );
            return;
          }

          // Если сигнал был сброшен, продолжаем поиск
          const updatedSignal = this.tradingLogicService.getCurrentSignal();
          if (!updatedSignal?.isActive) {
            break;
          }
        }
      }
    }

    const finalSignal = this.tradingLogicService.getCurrentSignal();
    if (finalSignal?.isActive) {
      logger.info(
        `⏳ Ретроспективный анализ завершен. Активный сигнал найден (${new Date(
          finalSignal.candle.timestamp
        ).toLocaleTimeString()}), ожидаем подтверждение`
      );
    } else {
      logger.info(
        "🔍 Ретроспективный анализ завершен. Активных сигналов не найдено"
      );
    }
  }

  private subscribeToCandleUpdates(): void {
    this.wsClient = new WebsocketClient({
      key: this.apiKey,
      secret: this.apiSecret,
      market: "v5"
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
          confirmed: candleData.confirm,
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
      this.candleHistory.push(newCandle);
      if (this.candleHistory.length > this.CANDLE_HISTORY_SIZE) {
        this.candleHistory.shift();
      }
    }

    this.candleHistory.sort((a, b) => a.timestamp - b.timestamp);

    if (newCandle.confirmed) {
      logger.info(
        `🕯️ Новая ЗАВЕРШЕННАЯ свеча (${new Date(
          newCandle.timestamp
        ).toLocaleTimeString()}): O=${newCandle.open} H=${newCandle.high} L=${
          newCandle.low
        } C=${newCandle.close} V=${newCandle.volume.toFixed(2)}`
      );
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

      let latestActiveSignal: any = null;
      let latestSignalIndex = -1;

      // ВАЖНО: Анализируем от НОВЫХ к СТАРЫМ чтобы найти самый свежий сигнал
      for (let i = this.candleHistory.length - 1; i >= 1; i--) {
        const currentCandle = this.candleHistory[i];
        const previousCandle = this.candleHistory[i - 1];

        logger.info(
          `   ${new Date(
            currentCandle.timestamp
          ).toLocaleTimeString()}: V=${currentCandle.volume.toFixed(
            2
          )} vs предыдущая V=${previousCandle.volume.toFixed(2)}`
        );

        // Временно сбрасываем текущий сигнал для проверки
        const originalSignal = this.tradingLogicService.getCurrentSignal();
        this.tradingLogicService.resetSignal();

        // Проверяем есть ли всплеск объема в этой свече
        this.tradingLogicService.checkVolumeSpike(
          currentCandle,
          previousCandle
        );

        // Если обнаружен сигнал, запоминаем его как кандидата
        const detectedSignal = this.tradingLogicService.getCurrentSignal();
        if (detectedSignal?.isActive && !latestActiveSignal) {
          latestActiveSignal = detectedSignal;
          latestSignalIndex = i;
          logger.info(
            `📊 Найден сигнал-кандидат: ${new Date(
              detectedSignal.candle.timestamp
            ).toLocaleTimeString()}, V=${detectedSignal.candle.volume.toFixed(
              2
            )}`
          );
        }

        // Восстанавливаем оригинальный сигнал
        this.tradingLogicService.setSignal(originalSignal);
      }

      // Если найден самый свежий сигнал, активируем его и проверяем подтверждения
      if (latestActiveSignal && latestSignalIndex >= 0) {
        logger.info(
          `🎯 САМЫЙ СВЕЖИЙ СИГНАЛ: ${new Date(
            latestActiveSignal.candle.timestamp
          ).toLocaleTimeString()}, V=${latestActiveSignal.candle.volume.toFixed(
            2
          )}`
        );

        this.tradingLogicService.setSignal(latestActiveSignal);

        // Проверяем все последующие свечи на подтверждение
        for (
          let j = latestSignalIndex + 1;
          j < this.candleHistory.length;
          j++
        ) {
          const laterCandle = this.candleHistory[j];

          logger.info(
            `   Проверка подтверждения: ${new Date(
              laterCandle.timestamp
            ).toLocaleTimeString()}, V=${laterCandle.volume.toFixed(
              2
            )} vs сигнал V=${latestActiveSignal.candle.volume.toFixed(2)}`
          );

          this.tradingLogicService.processCompletedCandle(
            laterCandle,
            this.candleHistory.slice(0, j + 1)
          );

          // Если позиция открыта, завершаем анализ
          if (this.tradingLogicService.getActivePosition()) {
            logger.info("✅ Позиция открыта по историческому сигналу");
            return;
          }

          // Если сигнал был обработан/сброшен, завершаем проверку
          const updatedSignal = this.tradingLogicService.getCurrentSignal();
          if (!updatedSignal?.isActive) {
            logger.info("⏹️ Исторический сигнал завершен");
            break;
          }
        }

        // Если сигнал все еще активен после проверки всех последующих свечей
        const finalSignal = this.tradingLogicService.getCurrentSignal();
        if (finalSignal?.isActive) {
          logger.info(
            `⏳ Самый свежий сигнал остается активным (${new Date(
              finalSignal.candle.timestamp
            ).toLocaleTimeString()}), ожидаем подтверждения`
          );
          return;
        }
      }

      logger.info(
        "✅ Анализ истории завершен. Готовых сигналов не найдено, ожидаем новые данные..."
      );
    } else {
      logger.warn("⚠️ Недостаточно свечей для анализа истории");
    }
  }
}
