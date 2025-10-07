import Binance, { CandleChartInterval } from "binance-api-node";
import { Candle } from "./binance.types";
import { logger } from "../utils/logger";

export class BinanceService {
  private client;
  private wsClient: any = null;

  constructor(apiKey: string, apiSecret: string, testnet: boolean) {
    this.client = Binance({
      apiKey: apiKey,
      apiSecret: apiSecret
      // API URL-ы для фьючерсов, если нужно
      // futures: testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com',
    });
  }

  public getClient() {
    return this.client;
  }

  // WebSocket для сделок (trades)
  public startTradesWebSocket(
    symbol: string,
    onTradeUpdate: (trade: any) => void
  ) {
    try {
      logger.info(`📡 Подключаемся к WebSocket сделок для ${symbol}...`);

      const tradesStream = this.client.ws.trades(symbol, (trade: any) => {
        onTradeUpdate(trade);
      });

      logger.info(`✅ WebSocket сделок подключен для ${symbol}`);
      return tradesStream;
    } catch (error) {
      logger.error(`❌ Ошибка подключения к WebSocket сделок:`, error);
      return null;
    }
  }

  public async startWebSocket(
    symbol: string,
    onCandleUpdate: (candle: Candle) => void
  ) {
    const connectWebSocket = () => {
      try {
        logger.info(`🔌 Подключаемся к WebSocket для ${symbol}...`);

        let lastLoggedVolume = 0;
        let lastLoggedTime = 0;

        // Создаем WebSocket подключение для фьючерсов
        this.wsClient = this.client.ws.futuresCandles(
          symbol,
          "1h",
          (candle: any) => {
            // Определяем confirmed более надежно
            const isConfirmed = candle.isFinal === true || candle.isFinal === 1;
            const currentTime = Date.now();
            const candleEndTime =
              (candle.openTime || candle.startTime) + 60 * 60 * 1000; // +1 час для часовой свечи

            // Если свеча уже должна быть закрыта по времени, считаем её confirmed
            const shouldBeConfirmed = currentTime > candleEndTime;

            const formattedCandle: Candle = {
              timestamp: candle.openTime || candle.startTime,
              open: parseFloat(candle.open),
              high: parseFloat(candle.high),
              low: parseFloat(candle.low),
              close: parseFloat(candle.close),
              volume: parseFloat(candle.volume),
              turnover: parseFloat(candle.quoteVolume || "0"),
              confirmed: isConfirmed || shouldBeConfirmed,
              isGreen: parseFloat(candle.close) >= parseFloat(candle.open)
            };

            if (formattedCandle.timestamp) {
              const currentTime = Date.now();
              const timeSinceLastLog = currentTime - lastLoggedTime;

              if (formattedCandle.confirmed) {
                logger.info(
                  `📊 WebSocket: ${new Date(
                    formattedCandle.timestamp
                  ).toLocaleString()} - V=${formattedCandle.volume.toFixed(
                    2
                  )} ✅`
                );
                lastLoggedTime = currentTime;
              } else {
                // НЕ логируем неподтвержденные свечи (убираем спам)
                // if (timeSinceLastLog >= 60000) {
                //   logger.info(
                //     `📊 WebSocket: ${new Date(
                //       formattedCandle.timestamp
                //     ).toLocaleString()} - V=${formattedCandle.volume.toFixed(
                //       2
                //     )} ⏳`
                //   );
                //   lastLoggedTime = currentTime;
                // }
              }
            }

            onCandleUpdate(formattedCandle);
          }
        );

        // Добавляем обработчики ошибок и переподключения
        if (this.wsClient && typeof this.wsClient.on === "function") {
          this.wsClient.on("error", (error: any) => {
            logger.error("❌ WebSocket ошибка:", error);
            setTimeout(() => {
              logger.info("🔄 Переподключаем WebSocket через 5 секунд...");
              connectWebSocket();
            }, 5000);
          });

          this.wsClient.on("close", () => {
            logger.warn(
              "⚠️ WebSocket соединение закрыто, переподключаемся через 3 секунды..."
            );
            setTimeout(() => {
              connectWebSocket();
            }, 3000);
          });
        }

        logger.info(`✅ WebSocket подключен для ${symbol}`);
      } catch (error) {
        logger.error("❌ Ошибка при подключении к WebSocket:", error);
        setTimeout(() => {
          logger.info("🔄 Повторное подключение через 10 секунд...");
          connectWebSocket();
        }, 10000);
      }
    };

    connectWebSocket();
  }

  public stopWebSocket() {
    if (this.wsClient) {
      try {
        // Проверяем тип WebSocket клиента и вызываем правильный метод
        if (typeof this.wsClient.close === "function") {
          this.wsClient.close();
        } else if (typeof this.wsClient.closeAll === "function") {
          this.wsClient.closeAll();
        } else if (typeof this.wsClient === "function") {
          // Некоторые клиенты возвращают функцию для отключения
          this.wsClient();
        }
        logger.info("🔌 WebSocket отключен");
      } catch (error) {
        logger.warn("⚠️ Ошибка при отключении WebSocket:", error);
      }
      this.wsClient = null;
    }
  }

  public async getUSDTBalance(): Promise<number> {
    try {
      const balances = await this.client.futuresAccountBalance();
      const usdtBalance = balances.find(b => b.asset === "USDT");
      if (usdtBalance) {
        const available = parseFloat(usdtBalance.availableBalance);
        logger.info(`💰 Доступный баланс: ${available.toFixed(2)} USDT`);
        return available;
      }
      logger.warn("⚠️ Не удалось найти баланс USDT.");
      return 0;
    } catch (error) {
      logger.error("❌ Ошибка при получении баланса:", error);
      return 0;
    }
  }

  public async getHistoricalCandles(
    symbol: string,
    interval: CandleChartInterval,
    limit: number
  ): Promise<Candle[]> {
    try {
      logger.info(
        `📊 Загрузка исторических данных: ${symbol}, ${interval}, ${limit} свечей...`
      );

      const candles = await this.client.futuresCandles({
        symbol: symbol,
        interval: interval,
        limit: limit
      });

      // Важно: последнюю свечу помечаем как неподтвержденную.
      // Это защищает от входа на незакрытой подтверждающей при перезапуске,
      // не используя время. При получении isFinal по WebSocket статус будет обновлен.
      const formattedCandles: Candle[] = candles.map((c, idx) => ({
        timestamp: c.openTime,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
        turnover: parseFloat(c.quoteVolume),
        confirmed: idx < candles.length - 1, // последняя считается еще незакрытой
        isGreen: parseFloat(c.close) >= parseFloat(c.open)
      }));

      logger.info(
        `✅ Загружено ${formattedCandles.length} исторических свечей.`
      );
      return formattedCandles;
    } catch (error) {
      logger.error("❌ Ошибка при загрузке исторических данных:", error);
      return [];
    }
  }

  // Метод для отключения WebSocket соединений
  public async disconnect(): Promise<void> {
    try {
      if (this.wsClient) {
        logger.info("🔌 Отключаем WebSocket соединения...");

        // Проверяем тип WebSocket клиента и используем соответствующий метод
        if (typeof this.wsClient.close === "function") {
          this.wsClient.close();
        } else if (typeof this.wsClient.destroy === "function") {
          this.wsClient.destroy();
        } else if (typeof this.wsClient.end === "function") {
          this.wsClient.end();
        } else {
          // Если нет стандартных методов закрытия, просто обнуляем
          logger.warn(
            "⚠️ WebSocket клиент не имеет метода закрытия, обнуляем ссылку"
          );
        }

        this.wsClient = null;
        logger.info("✅ WebSocket соединения отключены");
      } else {
        logger.info("ℹ️ WebSocket соединения уже отключены");
      }
    } catch (error) {
      logger.error("❌ Ошибка при отключении WebSocket:", error);
      // В любом случае обнуляем ссылку
      this.wsClient = null;
    }
  }
}
