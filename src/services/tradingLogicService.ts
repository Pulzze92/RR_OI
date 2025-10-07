import Binance, { Binance as BinanceClient, OrderSide } from "binance-api-node";
import { Candle, VolumeSignal, ActivePosition } from "./binance.types";
import { NotificationService } from "./notificationService";
import { logger } from "../utils/logger";
import axios from "axios";

// Интерфейс для агрегированных сделок (используем тип из binance-api-node)
import { AggregatedTrade } from "binance-api-node";

// Интерфейс для кластера объема
interface VolumeCluster {
  priceLevel: number;
  volume: number;
  percentage: number;
  tradeCount: number;
}

// Интерфейс для накопления данных в реальном времени
interface RealtimeVolumeData {
  trades: Array<{ price: number; volume: number; timestamp: number }>;
  clusters: Map<number, { volume: number; count: number }>;
  totalVolume: number;
  startTime: number;
  endTime: number;
}

// Интерфейс для WebSocket данных
interface WebSocketTrade {
  price: number;
  volume: number;
  timestamp: number;
  isBuyerMaker: boolean;
}

// Результат кластерного анализа
interface ClusterAnalysisResult {
  upperClusterVolume: number; // Объем в верхней трети
  middleClusterVolume: number; // Объем в средней трети
  lowerClusterVolume: number; // Объем в нижней трети
  dominantZone: "upper" | "middle" | "lower";
  entryDirection: "long" | "short" | "continuation";
  clusters: VolumeCluster[];
}

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
  leverage: number;
  // Для режимов без торговли: отключает вызовы API, влияющие на торговый аккаунт
  disableBrokerSideEffects?: boolean;
}

export class TradingLogicService {
  private currentSignal: VolumeSignal | null = null;
  private readonly MAX_HISTORY_SIZE = 5; // Нам достаточно 5 последних свечей
  private candleHistory: Candle[] = [];

  public getCandleHistory(): Candle[] {
    return this.candleHistory;
  }
  private readonly usedSignalTimestamps: Set<number> = new Set();
  private activePosition: ActivePosition | null = null;

  // Анализ диапазона сигнальной свечи
  private calculateSignalCandleRange(signalCandle: Candle): number {
    return signalCandle.high - signalCandle.low;
  }

  // Анализ OI по 5-минутным свечам внутри часа сигнальной свечи и распределение по зонам (низ/сред/верх)
  public async analyzeOpenInterestZones(
    signalCandle: Candle
  ): Promise<{
    lowerDelta: number;
    middleDelta: number;
    upperDelta: number;
  } | null> {
    try {
      const startTime = signalCandle.timestamp;
      const endTime = startTime + 60 * 60 * 1000 - 1;

      // 12 пятиминутных свечей для данного часа
      const fiveMinCandles = await this.client.futuresCandles({
        symbol: this.SYMBOL,
        interval: "5m" as any,
        startTime,
        endTime,
        limit: 12
      });

      // Исторический OI (USDT-M): futures/data/openInterestHist
      const oiResp = await axios.get(
        "https://fapi.binance.com/futures/data/openInterestHist",
        {
          params: {
            symbol: this.SYMBOL,
            period: "5m",
            limit: 30,
            startTime,
            endTime
          }
        }
      );

      const oiRows: any[] = Array.isArray(oiResp.data) ? oiResp.data : [];
      if (oiRows.length < 2 || fiveMinCandles.length === 0) {
        return null;
      }

      // Сортируем по времени
      oiRows.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

      // Границы зон сигнальной свечи
      const range = signalCandle.high - signalCandle.low;
      const z1 = signalCandle.low + range / 3; // нижняя -> средняя
      const z2 = signalCandle.low + (2 * range) / 3; // средняя -> верхняя

      let lowerDelta = 0;
      let middleDelta = 0;
      let upperDelta = 0;

      // Создаем индекс по времени для 5м свечей
      const fiveMap = new Map<number, any>();
      for (const c of fiveMinCandles as any[]) {
        // ключ по закрытию интервала (openTime + 5м)
        const closeTs = Number(c.openTime) + 5 * 60 * 1000;
        fiveMap.set(closeTs, c);
      }

      // Пробегаем по соседним точкам OI, считаем дельту и сопоставляем 5м свечу того же интервала
      for (let i = 1; i < oiRows.length; i++) {
        const prev = oiRows[i - 1];
        const curr = oiRows[i];
        const ts = Number(curr.timestamp);
        const prevOi = parseFloat(
          prev.sumOpenInterest ?? prev.openInterest ?? "0"
        );
        const currOi = parseFloat(
          curr.sumOpenInterest ?? curr.openInterest ?? "0"
        );
        const delta = currOi - prevOi;

        const c = fiveMap.get(ts);
        if (!c) continue;
        const closePrice = parseFloat(c.close);

        if (closePrice < z1) {
          lowerDelta += delta;
        } else if (closePrice < z2) {
          middleDelta += delta;
        } else {
          upperDelta += delta;
        }
      }

      return { lowerDelta, middleDelta, upperDelta };
    } catch (error) {
      logger.warn("⚠️ Не удалось выполнить анализ OI по зонам:", error);
      return null;
    }
  }
  private trailingStopCheckInterval: NodeJS.Timeout | null = null;
  private isOpeningPosition: boolean = false;
  private lastSignalNotificationTime: number = 0;
  private lastRestCheckTime: number = 0;
  private readonly REST_CHECK_INTERVAL = 15 * 60 * 1000; // 15 минут для часового таймфрейма
  private readonly POSITION_CHECK_INTERVAL = 10 * 1000; // 10 секунд
  private hasInitialSync = false;
  private lastPositionOpenTime: number = 0;
  private positionCheckInterval: NodeJS.Timeout | null = null;

  // Правила точности
  private pricePrecision: number = 2;
  private quantityPrecision: number = 2;
  private tickSize: number = 0.01;

  private readonly TAKE_PROFIT_POINTS: number;
  private readonly STOP_LOSS_POINTS: number;
  private readonly TRAILING_ACTIVATION_POINTS: number;
  private readonly TRAILING_DISTANCE: number;
  private readonly VOLUME_THRESHOLD: number;
  private readonly TRADE_SIZE_USD: number;
  private readonly SYMBOL: string;
  private readonly LEVERAGE: number;
  private readonly TRAILING_STOP_INTERVAL_MS = 10000; // 10 секунд
  private readonly USE_TRAILING_STOP: boolean;
  // УДАЛЕНЫ константы MAX_SIGNAL_CANDLES - больше не нужны!
  private readonly MIN_TRAILING_UPDATE_DISTANCE = 0.05; // Минимальное расстояние для обновления стопа
  private lastTrailingUpdateTime: number = 0;
  private readonly MIN_TRAILING_UPDATE_INTERVAL = 10 * 1000; // 30 секунд между обновлениями

  // WebSocket сбор данных по кластерам
  private realtimeVolumeData: RealtimeVolumeData | null = null;
  private websocketTradeStream: any = null;
  private isCollectingRealtimeData: boolean = false;

  constructor(
    private client: BinanceClient,
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
    this.USE_TRAILING_STOP = false;
    this.LEVERAGE = options.leverage;

    if (!options.disableBrokerSideEffects) {
      // Устанавливаем плечо при инициализации
      this.client
        .futuresLeverage({
          symbol: this.SYMBOL,
          leverage: this.LEVERAGE
        })
        .then(() => {
          logger.info(
            `✅ Установлено кредитное плечо ${this.LEVERAGE}x для ${this.SYMBOL}`
          );
        })
        .catch(error => {
          logger.error(`❌ Ошибка при установке кредитного плеча:`, error);
        });

      // Запускаем периодическую проверку позиции
      this.startPositionCheck();
    }
  }

  // Начать сбор данных через WebSocket для текущей свечи
  public startRealtimeDataCollection(signalCandle: Candle): void {
    if (this.isCollectingRealtimeData) {
      logger.warn("⚠️ Уже идет сбор данных в реальном времени");
      return;
    }

    this.isCollectingRealtimeData = true;
    const startTime = signalCandle.timestamp;
    const endTime = startTime + 60 * 60 * 1000; // +1 час

    // Инициализируем структуру данных
    this.realtimeVolumeData = {
      trades: [],
      clusters: new Map(),
      totalVolume: 0,
      startTime: startTime,
      endTime: endTime
    };

    logger.info(
      `📡 НАЧИНАЕМ WEBSOCKET СБОР ДАННЫХ для свечи: ${new Date(
        startTime
      ).toLocaleString()}`
    );

    // Используем Aggregate Trade Streams WebSocket
    logger.info(`📡 Подключаемся к Aggregate Trade Streams...`);

    try {
      // Подключаемся к Aggregate Trade Streams
      this.websocketTradeStream = this.client.ws.aggTrades(
        this.SYMBOL,
        (trade: any) => {
          this.handleRealtimeTrade(trade, signalCandle);
        }
      );

      logger.info(`✅ Aggregate Trade Streams подключен для ${this.SYMBOL}`);
    } catch (error) {
      logger.error(`❌ Ошибка подключения к Aggregate Trade Streams:`, error);
      this.isCollectingRealtimeData = false;
      return;
    }

    // Автоматически останавливаем сбор через час
    setTimeout(() => {
      this.stopRealtimeDataCollection();
    }, 60 * 60 * 1000);
  }

  // Проактивный сбор данных для текущей активной свечи
  public startProactiveDataCollection(): void {
    if (this.isCollectingRealtimeData) {
      logger.info("📡 Уже идет проактивный сбор данных");
      return;
    }

    // Создаем виртуальную свечу для текущего часа
    const currentTime = Date.now();
    const currentHour =
      Math.floor(currentTime / (60 * 60 * 1000)) * (60 * 60 * 1000);

    const currentCandle: Candle = {
      timestamp: currentHour,
      open: 0, // Будет обновляться в реальном времени
      high: 0,
      low: 0,
      close: 0,
      volume: 0,
      turnover: 0,
      isGreen: false,
      confirmed: false
    };

    logger.info(
      `📡 ПРОАКТИВНЫЙ СБОР ДАННЫХ отключен (используем минутные свечи для анализа)`
    );

    // this.startRealtimeDataCollection(currentCandle); // Отключено - используем минутные свечи
  }

  // Обработка сделки в реальном времени
  private handleRealtimeTrade(trade: any, signalCandle: Candle): void {
    if (!this.realtimeVolumeData || !this.isCollectingRealtimeData) {
      return;
    }

    // Aggregate Trade Streams использует другие поля
    const tradeTime = trade.timestamp || trade.eventTime; // Timestamp или Event time
    const price = parseFloat(trade.price); // Price
    const volume = parseFloat(trade.quantity); // Quantity
    const isBuyerMaker = trade.isBuyerMaker; // Is the buyer the market maker?

    // Проверяем, что данные валидны
    if (isNaN(price) || isNaN(volume) || !tradeTime) {
      logger.warn(
        `⚠️ Некорректные данные WebSocket: price=${price}, volume=${volume}, time=${tradeTime}`
      );
      return;
    }

    // Проверяем, что сделка относится к нашей свече
    if (
      tradeTime < this.realtimeVolumeData.startTime ||
      tradeTime > this.realtimeVolumeData.endTime
    ) {
      return;
    }

    // Проверяем, что цена входит в диапазон свечи (если свеча уже сформирована)
    if (
      signalCandle.high > 0 &&
      (price < signalCandle.low || price > signalCandle.high)
    ) {
      return;
    }

    // Добавляем сделку
    const tradeData: WebSocketTrade = {
      price: price,
      volume: volume,
      timestamp: tradeTime,
      isBuyerMaker: isBuyerMaker
    };

    this.realtimeVolumeData.trades.push(tradeData);
    this.realtimeVolumeData.totalVolume += volume;

    // Обновляем кластеры
    const clusterPrice = this.roundToClusterPrice(price, signalCandle);
    if (this.realtimeVolumeData.clusters.has(clusterPrice)) {
      const cluster = this.realtimeVolumeData.clusters.get(clusterPrice)!;
      cluster.volume += volume;
      cluster.count += 1;
    } else {
      this.realtimeVolumeData.clusters.set(clusterPrice, {
        volume: volume,
        count: 1
      });
    }

    // Логируем каждые 500 сделок для мониторинга
    if (this.realtimeVolumeData.trades.length % 500 === 0) {
      logger.info(
        `📊 WebSocket: собрано ${
          this.realtimeVolumeData.trades.length
        } сделок, объем: ${this.realtimeVolumeData.totalVolume.toFixed(2)}`
      );
    }
  }

  // Округление цены до кластера
  private roundToClusterPrice(price: number, signalCandle: Candle): number {
    const range = signalCandle.high - signalCandle.low;
    const clusterSize = range / 50; // 50 кластеров по цене
    const clusterIndex = Math.floor((price - signalCandle.low) / clusterSize);
    return signalCandle.low + clusterIndex * clusterSize;
  }

  // Остановить сбор данных и очистить память
  private stopRealtimeDataCollection(): void {
    if (!this.isCollectingRealtimeData) {
      return;
    }

    this.isCollectingRealtimeData = false;

    if (this.websocketTradeStream) {
      this.websocketTradeStream();
      this.websocketTradeStream = null;
    }

    if (this.realtimeVolumeData) {
      logger.info(
        `📡 WebSocket сбор завершен: ${
          this.realtimeVolumeData.trades.length
        } сделок, объем: ${this.realtimeVolumeData.totalVolume.toFixed(2)}`
      );

      // Очищаем данные из памяти
      this.realtimeVolumeData = null;
    }
  }

  // Получить данные из WebSocket (если доступны)
  private getRealtimeVolumeData(): RealtimeVolumeData | null {
    return this.realtimeVolumeData;
  }

  // Проверяем, нужен ли кластерный анализ для свечи
  private shouldAnalyzeClusters(signalCandle: Candle): boolean {
    const currentTime = Date.now();
    const candleAge = currentTime - signalCandle.timestamp;
    const maxAge = 2 * 60 * 60 * 1000; // 2 часа

    // Для исторических сигналов всегда анализируем кластеры
    // Проверяем, что свеча уже закрылась (прошло больше часа с её начала)
    const timeSinceCandleStart = currentTime - signalCandle.timestamp;
    const isCandleClosed = timeSinceCandleStart > 60 * 60 * 1000; // 1 час

    if (isCandleClosed) {
      logger.info(
        `📊 Анализируем историческую свечу (${Math.round(
          candleAge / (60 * 1000)
        )}мин назад) с помощью минутных свечей`
      );
      return true;
    }

    // Если свеча еще активна (не закрылась), используем WebSocket
    const candleEndTime = signalCandle.timestamp + 60 * 60 * 1000;
    if (currentTime < candleEndTime) {
      logger.info(`📡 Свеча еще активна, будем использовать WebSocket данные`);
      return true;
    }

    // Для закрытых свечей анализируем минутные свечи (исторические данные)
    // Это работает как для недавно закрытых, так и для исторических свечей при перезапуске
    const timeSinceClose = currentTime - candleEndTime;
    logger.info(
      `📊 Анализируем историческую свечу (${Math.round(
        timeSinceClose / (60 * 1000)
      )}мин назад) с помощью минутных свечей`
    );
    return true;
  }

  // Анализ минутных свечей для определения распределения объема
  private analyzeSecondCandles(
    secondCandles: any[],
    signalCandle: Candle,
    previousCandle: Candle
  ): ClusterAnalysisResult {
    // Определяем границы третей часовой свечи
    const range = signalCandle.high - signalCandle.low;
    const third = range / 3;
    const upperMiddle = signalCandle.high - third;
    const lowerMiddle = signalCandle.low + third;

    // ДИАГНОСТИКА: Логируем границы третей
    logger.info(`🔍 ДИАГНОСТИКА ГРАНИЦ ТРЕТЕЙ (секундный анализ):`);
    logger.info(
      `   📊 Диапазон свечи: ${signalCandle.low.toFixed(
        2
      )} - ${signalCandle.high.toFixed(2)} (range=${range.toFixed(2)})`
    );
    logger.info(`   📊 Треть диапазона: ${third.toFixed(2)}`);
    logger.info(
      `   📊 Верхняя граница средней трети: ${upperMiddle.toFixed(2)}`
    );
    logger.info(
      `   📊 Нижняя граница средней трети: ${lowerMiddle.toFixed(2)}`
    );

    // Подсчитываем объем по третям на основе секундных свечей
    let upperVolume = 0;
    let middleVolume = 0;
    let lowerVolume = 0;

    for (const secondCandle of secondCandles) {
      const open = parseFloat(secondCandle.open);
      const close = parseFloat(secondCandle.close);
      const high = parseFloat(secondCandle.high);
      const low = parseFloat(secondCandle.low);
      const volume = parseFloat(secondCandle.volume);

      // Используем VWAP вместо bodyPosition для учета теней
      const vwap = (high + low + close) / 3;

      if (vwap >= upperMiddle) {
        upperVolume += volume;
      } else if (vwap >= lowerMiddle) {
        middleVolume += volume;
      } else {
        lowerVolume += volume;
      }
    }

    // ДИАГНОСТИКА: Логируем первые несколько секундных свечей
    logger.info(`🔍 ДИАГНОСТИКА СЕКУНДНЫХ СВЕЧЕЙ (первые 5):`);
    for (let i = 0; i < Math.min(5, secondCandles.length); i++) {
      const sc = secondCandles[i];
      const open = parseFloat(sc.open);
      const close = parseFloat(sc.close);
      const high = parseFloat(sc.high);
      const low = parseFloat(sc.low);
      const vwap = (high + low + close) / 3;
      const volume = parseFloat(sc.volume);

      let zone = "";
      if (vwap >= upperMiddle) {
        zone = "ВЕРХНЯЯ";
      } else if (vwap >= lowerMiddle) {
        zone = "СРЕДНЯЯ";
      } else {
        zone = "НИЖНЯЯ";
      }

      logger.info(
        `   ${i + 1}: vwap=${vwap.toFixed(
          2
        )}, zone=${zone}, volume=${volume.toFixed(2)}`
      );
    }

    // Определяем доминирующую зону
    let dominantZone: "upper" | "middle" | "lower";
    if (upperVolume > middleVolume && upperVolume > lowerVolume) {
      dominantZone = "upper";
    } else if (middleVolume > upperVolume && middleVolume > lowerVolume) {
      dominantZone = "middle";
    } else {
      dominantZone = "lower";
    }

    // Определяем направление входа
    let entryDirection: "long" | "short" | "continuation";

    if (signalCandle.isGreen) {
      if (dominantZone === "upper") {
        entryDirection = "short";
      } else if (dominantZone === "lower") {
        entryDirection = "long";
      } else {
        // Объем в середине = сравниваем верхнюю и нижнюю трети
        if (upperVolume > lowerVolume) {
          entryDirection = "short"; // Больше объема сверху → шорт
        } else {
          entryDirection = "long"; // Больше объема снизу → лонг
        }
      }
    } else {
      // Красная сигнальная свеча
      if (dominantZone === "upper") {
        entryDirection = "short";
      } else if (dominantZone === "lower") {
        entryDirection = "long";
      } else {
        // Объем в середине = сравниваем верхнюю и нижнюю трети
        if (upperVolume > lowerVolume) {
          entryDirection = "short"; // Больше объема сверху → шорт
        } else {
          entryDirection = "long"; // Больше объема снизу → лонг
        }
      }
    }

    const totalVolume = upperVolume + middleVolume + lowerVolume;
    const upperPercent = (upperVolume / totalVolume) * 100;
    const middlePercent = (middleVolume / totalVolume) * 100;
    const lowerPercent = (lowerVolume / totalVolume) * 100;

    logger.info(`📊 СЕКУНДНЫЙ АНАЛИЗ:`);
    logger.info(
      `   📈 Верхняя треть: ${upperVolume.toFixed(2)} (${upperPercent.toFixed(
        1
      )}%)`
    );
    logger.info(
      `   📊 Средняя треть: ${middleVolume.toFixed(2)} (${middlePercent.toFixed(
        1
      )}%)`
    );
    logger.info(
      `   📉 Нижняя треть: ${lowerVolume.toFixed(2)} (${lowerPercent.toFixed(
        1
      )}%)`
    );
    logger.info(`   🎯 Доминирующая зона: ${dominantZone}`);
    logger.info(`   🚀 Направление входа: ${entryDirection}`);

    return {
      upperClusterVolume: upperVolume,
      middleClusterVolume: middleVolume,
      lowerClusterVolume: lowerVolume,
      dominantZone,
      entryDirection,
      clusters: []
    };
  }

  private analyzeMinuteCandlesWithVWAP(
    minuteCandles: any[],
    signalCandle: Candle,
    previousCandle: Candle
  ): ClusterAnalysisResult {
    // Определяем границы третей часовой свечи
    const range = signalCandle.high - signalCandle.low;
    const third = range / 3;
    const upperMiddle = signalCandle.high - third;
    const lowerMiddle = signalCandle.low + third;

    // ДИАГНОСТИКА: Логируем границы третей
    logger.info(`🔍 ДИАГНОСТИКА ГРАНИЦ ТРЕТЕЙ (VWAP анализ):`);
    logger.info(
      `   📊 Диапазон свечи: ${signalCandle.low.toFixed(
        2
      )} - ${signalCandle.high.toFixed(2)} (range=${range.toFixed(2)})`
    );
    logger.info(`   📊 Треть диапазона: ${third.toFixed(2)}`);
    logger.info(
      `   📊 Верхняя граница средней трети: ${upperMiddle.toFixed(2)}`
    );
    logger.info(
      `   📊 Нижняя граница средней трети: ${lowerMiddle.toFixed(2)}`
    );

    // Подсчитываем объем по третям на основе минутных свечей с VWAP
    let upperVolume = 0;
    let middleVolume = 0;
    let lowerVolume = 0;

    for (const minuteCandle of minuteCandles) {
      const open = parseFloat(minuteCandle.open);
      const close = parseFloat(minuteCandle.close);
      const high = parseFloat(minuteCandle.high);
      const low = parseFloat(minuteCandle.low);
      const volume = parseFloat(minuteCandle.volume);

      // Используем VWAP для учета теней
      const vwap = (high + low + close) / 3;

      if (vwap >= upperMiddle) {
        upperVolume += volume;
      } else if (vwap >= lowerMiddle) {
        middleVolume += volume;
      } else {
        lowerVolume += volume;
      }
    }

    // ДИАГНОСТИКА: Логируем первые несколько минутных свечей
    logger.info(`🔍 ДИАГНОСТИКА МИНУТНЫХ СВЕЧЕЙ (VWAP, первые 5):`);
    for (let i = 0; i < Math.min(5, minuteCandles.length); i++) {
      const mc = minuteCandles[i];
      const open = parseFloat(mc.open);
      const close = parseFloat(mc.close);
      const high = parseFloat(mc.high);
      const low = parseFloat(mc.low);
      const vwap = (high + low + close) / 3;
      const volume = parseFloat(mc.volume);

      let zone = "";
      if (vwap >= upperMiddle) {
        zone = "ВЕРХНЯЯ";
      } else if (vwap >= lowerMiddle) {
        zone = "СРЕДНЯЯ";
      } else {
        zone = "НИЖНЯЯ";
      }

      logger.info(
        `   ${i + 1}: vwap=${vwap.toFixed(
          2
        )}, zone=${zone}, volume=${volume.toFixed(2)}`
      );
    }

    // Определяем доминирующую зону
    let dominantZone: "upper" | "middle" | "lower";
    if (upperVolume > middleVolume && upperVolume > lowerVolume) {
      dominantZone = "upper";
    } else if (middleVolume > upperVolume && middleVolume > lowerVolume) {
      dominantZone = "middle";
    } else {
      dominantZone = "lower";
    }

    // Определяем направление входа
    let entryDirection: "long" | "short" | "continuation";

    if (signalCandle.isGreen) {
      if (dominantZone === "upper") {
        entryDirection = "short";
      } else if (dominantZone === "lower") {
        entryDirection = "long";
      } else {
        // Объем в середине = сравниваем верхнюю и нижнюю трети
        if (upperVolume > lowerVolume) {
          entryDirection = "short"; // Больше объема сверху → шорт
        } else {
          entryDirection = "long"; // Больше объема снизу → лонг
        }
      }
    } else {
      // Красная сигнальная свеча
      if (dominantZone === "upper") {
        entryDirection = "short";
      } else if (dominantZone === "lower") {
        entryDirection = "long";
      } else {
        // Объем в середине = сравниваем верхнюю и нижнюю трети
        if (upperVolume > lowerVolume) {
          entryDirection = "short"; // Больше объема сверху → шорт
        } else {
          entryDirection = "long"; // Больше объема снизу → лонг
        }
      }
    }

    const totalVolume = upperVolume + middleVolume + lowerVolume;
    const upperPercent = (upperVolume / totalVolume) * 100;
    const middlePercent = (middleVolume / totalVolume) * 100;
    const lowerPercent = (lowerVolume / totalVolume) * 100;

    logger.info(`📊 VWAP АНАЛИЗ:`);
    logger.info(
      `   📈 Верхняя треть: ${upperVolume.toFixed(2)} (${upperPercent.toFixed(
        1
      )}%)`
    );
    logger.info(
      `   📊 Средняя треть: ${middleVolume.toFixed(2)} (${middlePercent.toFixed(
        1
      )}%)`
    );
    logger.info(
      `   📉 Нижняя треть: ${lowerVolume.toFixed(2)} (${lowerPercent.toFixed(
        1
      )}%)`
    );
    logger.info(`   🎯 Доминирующая зона: ${dominantZone}`);
    logger.info(`   🚀 Направление входа: ${entryDirection}`);

    return {
      upperClusterVolume: upperVolume,
      middleClusterVolume: middleVolume,
      lowerClusterVolume: lowerVolume,
      dominantZone,
      entryDirection,
      clusters: []
    };
  }

  private analyzeMinuteCandles(
    minuteCandles: any[],
    signalCandle: Candle,
    previousCandle: Candle
  ): ClusterAnalysisResult {
    // Определяем границы третей часовой свечи
    const range = signalCandle.high - signalCandle.low;
    const third = range / 3;
    const upperMiddle = signalCandle.high - third;
    const lowerMiddle = signalCandle.low + third;

    // ДИАГНОСТИКА: Логируем границы третей
    logger.info(`🔍 ДИАГНОСТИКА ГРАНИЦ ТРЕТЕЙ:`);
    logger.info(
      `   📊 Диапазон свечи: ${signalCandle.low.toFixed(
        2
      )} - ${signalCandle.high.toFixed(2)} (range=${range.toFixed(2)})`
    );
    logger.info(`   📊 Треть диапазона: ${third.toFixed(2)}`);
    logger.info(
      `   📊 Верхняя граница средней трети: ${upperMiddle.toFixed(2)}`
    );
    logger.info(
      `   📊 Нижняя граница средней трети: ${lowerMiddle.toFixed(2)}`
    );

    // Подсчитываем объем по третям на основе минутных свечей
    let upperVolume = 0;
    let middleVolume = 0;
    let lowerVolume = 0;

    for (const minuteCandle of minuteCandles) {
      const open = parseFloat(minuteCandle.open);
      const close = parseFloat(minuteCandle.close);
      const high = parseFloat(minuteCandle.high);
      const low = parseFloat(minuteCandle.low);
      const volume = parseFloat(minuteCandle.volume);

      // Используем VWAP вместо bodyPosition для учета теней
      const vwap = (high + low + close) / 3;

      if (vwap >= upperMiddle) {
        upperVolume += volume;
      } else if (vwap >= lowerMiddle) {
        middleVolume += volume;
      } else {
        lowerVolume += volume;
      }
    }

    // ДИАГНОСТИКА: Логируем первые несколько минутных свечей
    logger.info(`🔍 ДИАГНОСТИКА МИНУТНЫХ СВЕЧЕЙ (первые 5):`);
    for (let i = 0; i < Math.min(5, minuteCandles.length); i++) {
      const mc = minuteCandles[i];
      const open = parseFloat(mc.open);
      const close = parseFloat(mc.close);
      const high = parseFloat(mc.high);
      const low = parseFloat(mc.low);
      const vwap = (high + low + close) / 3;
      const volume = parseFloat(mc.volume);

      let zone = "";
      if (vwap >= upperMiddle) {
        zone = "ВЕРХНЯЯ";
      } else if (vwap >= lowerMiddle) {
        zone = "СРЕДНЯЯ";
      } else {
        zone = "НИЖНЯЯ";
      }

      logger.info(
        `   ${i + 1}: vwap=${vwap.toFixed(
          2
        )}, zone=${zone}, volume=${volume.toFixed(2)}`
      );
    }

    // Определяем доминирующую зону
    let dominantZone: "upper" | "middle" | "lower";
    if (upperVolume > middleVolume && upperVolume > lowerVolume) {
      dominantZone = "upper";
    } else if (middleVolume > upperVolume && middleVolume > lowerVolume) {
      dominantZone = "middle";
    } else {
      dominantZone = "lower";
    }

    // Определяем направление входа
    let entryDirection: "long" | "short" | "continuation";

    if (signalCandle.isGreen) {
      // Зеленая сигнальная свеча
      if (dominantZone === "upper") {
        entryDirection = "short"; // Объем вверху = продажи = шорт
      } else if (dominantZone === "lower") {
        entryDirection = "long"; // Объем внизу = покупки = лонг
      } else {
        // Объем в середине = сравниваем верхнюю и нижнюю трети
        if (upperVolume > lowerVolume) {
          entryDirection = "short"; // Больше объема сверху → шорт
        } else {
          entryDirection = "long"; // Больше объема снизу → лонг
        }
      }
    } else {
      // Красная сигнальная свеча
      if (dominantZone === "upper") {
        entryDirection = "short"; // Объем вверху = продажи = шорт
      } else if (dominantZone === "lower") {
        entryDirection = "long"; // Объем внизу = покупки = лонг
      } else {
        // Объем в середине = сравниваем верхнюю и нижнюю трети
        if (upperVolume > lowerVolume) {
          entryDirection = "short"; // Больше объема сверху → шорт
        } else {
          entryDirection = "long"; // Больше объема снизу → лонг
        }
      }
    }

    const totalVolume = upperVolume + middleVolume + lowerVolume;
    const upperPercent = (upperVolume / totalVolume) * 100;
    const middlePercent = (middleVolume / totalVolume) * 100;
    const lowerPercent = (lowerVolume / totalVolume) * 100;

    logger.info(`📊 МИНУТНЫЙ АНАЛИЗ:`);
    logger.info(
      `   📈 Верхняя треть: ${upperVolume.toFixed(2)} (${upperPercent.toFixed(
        1
      )}%)`
    );
    logger.info(
      `   📊 Средняя треть: ${middleVolume.toFixed(2)} (${middlePercent.toFixed(
        1
      )}%)`
    );
    logger.info(
      `   📉 Нижняя треть: ${lowerVolume.toFixed(2)} (${lowerPercent.toFixed(
        1
      )}%)`
    );
    logger.info(`   🎯 Доминирующая зона: ${dominantZone}`);
    logger.info(`   🚀 Направление входа: ${entryDirection}`);

    return {
      upperClusterVolume: upperVolume,
      middleClusterVolume: middleVolume,
      lowerClusterVolume: lowerVolume,
      dominantZone,
      entryDirection,
      clusters: []
    };
  }

  // Простой анализ направления без кластерного анализа
  private getSimpleDirectionAnalysis(
    signalCandle: Candle,
    previousCandle: Candle
  ): ClusterAnalysisResult {
    logger.info(`🔍 Простой анализ направления (без кластеров)`);

    // Простая логика на основе цвета свечи и предыдущей свечи
    let entryDirection: "long" | "short" | "continuation";

    if (signalCandle.isGreen) {
      // Зеленая свеча - смотрим на предыдущую
      if (previousCandle.isGreen) {
        entryDirection = "long"; // Продолжение восходящего тренда
      } else {
        entryDirection = "short"; // Разворот после красной
      }
    } else {
      // Красная свеча - смотрим на предыдущую
      if (previousCandle.isGreen) {
        entryDirection = "short"; // Разворот после зеленой
      } else {
        entryDirection = "long"; // Продолжение нисходящего тренда
      }
    }

    // Равномерное распределение объема (так как кластеры не анализировались)
    const totalVolume = signalCandle.volume;
    const upperVolume = totalVolume * 0.33;
    const middleVolume = totalVolume * 0.34;
    const lowerVolume = totalVolume * 0.33;

    return {
      upperClusterVolume: upperVolume,
      middleClusterVolume: middleVolume,
      lowerClusterVolume: lowerVolume,
      dominantZone: "middle",
      entryDirection,
      clusters: []
    };
  }

  // Анализ кластеров на основе WebSocket данных
  private analyzeRealtimeClusters(
    realtimeData: RealtimeVolumeData,
    signalCandle: Candle,
    previousCandle: Candle
  ): ClusterAnalysisResult {
    // Определяем границы третей
    const range = signalCandle.high - signalCandle.low;
    const third = range / 3;
    const upperMiddle = signalCandle.high - third;
    const lowerMiddle = signalCandle.low + third;

    // Подсчитываем объем по третям на основе WebSocket данных
    let upperVolume = 0;
    let middleVolume = 0;
    let lowerVolume = 0;

    for (const [price, data] of realtimeData.clusters.entries()) {
      if (price >= upperMiddle) {
        upperVolume += data.volume;
      } else if (price >= lowerMiddle) {
        middleVolume += data.volume;
      } else {
        lowerVolume += data.volume;
      }
    }

    // Определяем доминирующую зону
    const dominantZone =
      upperVolume > middleVolume && upperVolume > lowerVolume
        ? "upper"
        : middleVolume > upperVolume && middleVolume > lowerVolume
        ? "middle"
        : "lower";

    // Определяем направление входа
    let entryDirection: "long" | "short" | "continuation";

    if (signalCandle.isGreen) {
      if (dominantZone === "upper") {
        entryDirection = "short";
      } else if (dominantZone === "lower") {
        entryDirection = "long";
      } else {
        entryDirection = previousCandle.isGreen ? "long" : "short";
      }
    } else {
      if (dominantZone === "upper") {
        entryDirection = "short";
      } else if (dominantZone === "lower") {
        entryDirection = "long";
      } else {
        entryDirection = previousCandle.isGreen ? "long" : "short";
      }
    }

    return {
      upperClusterVolume: upperVolume,
      middleClusterVolume: middleVolume,
      lowerClusterVolume: lowerVolume,
      dominantZone,
      entryDirection,
      clusters: []
    };
  }

  // Агрессивный сбор данных для сигнальной свечи (множественные запросы)
  private async fetchAggTradesForCandle(
    signalCandle: Candle
  ): Promise<AggregatedTrade[]> {
    try {
      const startTime = signalCandle.timestamp;
      const endTime = startTime + 60 * 60 * 1000; // +1 час для часовой свечи

      logger.info(
        `📊 АГРЕССИВНЫЙ СБОР ДАННЫХ для свечи: ${new Date(
          startTime
        ).toLocaleString()}`
      );

      const allTrades: AggregatedTrade[] = [];
      const intervalMs = 5 * 60 * 1000; // 5-минутные интервалы
      let totalRequests = 0;
      let successfulRequests = 0;

      // Разбиваем час на 5-минутные интервалы (12 запросов)
      for (let time = startTime; time < endTime; time += intervalMs) {
        const intervalEnd = Math.min(time + intervalMs, endTime);

        try {
          const aggTrades = await this.client.aggTrades({
            symbol: this.SYMBOL,
            startTime: time,
            endTime: intervalEnd,
            limit: 1000 // Максимум 1000 сделок за интервал
          });

          if (aggTrades.length > 0) {
            allTrades.push(...aggTrades);
            successfulRequests++;
            logger.info(
              `📊 Интервал ${new Date(time).toLocaleTimeString()}: ${
                aggTrades.length
              } сделок (всего: ${allTrades.length})`
            );
          }

          totalRequests++;

          // Небольшая задержка между запросами
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          logger.debug(
            `Ошибка для интервала ${new Date(time).toLocaleString()}: ${error}`
          );
          totalRequests++;
        }
      }

      // Дополнительные запросы с разными параметрами для максимального покрытия

      // Запрос без временных ограничений (последние сделки)
      try {
        const recentTrades = await this.client.aggTrades({
          symbol: this.SYMBOL,
          limit: 1000
        });

        // Фильтруем только сделки за период нашей свечи
        const filteredTrades = recentTrades.filter(trade => {
          const tradeTime = trade.timestamp;
          return tradeTime >= startTime && tradeTime <= endTime;
        });

        if (filteredTrades.length > 0) {
          allTrades.push(...filteredTrades);
        }
      } catch (error) {
        // Игнорируем ошибки
      }

      // Если свеча еще активна (не закрылась), ждем еще немного и собираем данные
      const currentTime = Date.now();
      const candleEndTime = startTime + 60 * 60 * 1000;

      if (currentTime < candleEndTime) {
        const timeToWait = Math.min(candleEndTime - currentTime, 30 * 1000); // Ждем до 30 секунд
        await new Promise(resolve => setTimeout(resolve, timeToWait));

        // Еще один запрос после ожидания
        try {
          const finalTrades = await this.client.aggTrades({
            symbol: this.SYMBOL,
            startTime: startTime,
            endTime: endTime,
            limit: 1000
          });

          if (finalTrades.length > 0) {
            allTrades.push(...finalTrades);
          }
        } catch (error) {
          // Игнорируем ошибки
        }
      }

      // Удаляем дубликаты по timestamp и price
      const uniqueTrades = allTrades.filter(
        (trade, index, self) =>
          index ===
          self.findIndex(
            t => t.timestamp === trade.timestamp && t.price === trade.price
          )
      );

      const totalVolume = uniqueTrades.reduce(
        (sum, trade) => sum + parseFloat(trade.quantity),
        0
      );
      const coveragePercentage = (totalVolume / signalCandle.volume) * 100;

      return uniqueTrades;
    } catch (error) {
      logger.error(`❌ Ошибка при агрессивном сборе данных:`, error);
      return [];
    }
  }

  // Создание кластеров объема на основе aggTrades
  private createVolumeClusters(
    aggTrades: AggregatedTrade[],
    signalCandle: Candle
  ): VolumeCluster[] {
    const range = signalCandle.high - signalCandle.low;
    const clusterSize = range / 20; // 20 кластеров по цене

    // Группируем сделки по ценовым уровням
    const priceClusters = new Map<number, { volume: number; count: number }>();

    for (const trade of aggTrades) {
      const price = parseFloat(trade.price);
      const volume = parseFloat(trade.quantity);

      // Определяем кластер для этой цены
      const clusterIndex = Math.floor((price - signalCandle.low) / clusterSize);
      const clusterPrice = signalCandle.low + clusterIndex * clusterSize;

      if (priceClusters.has(clusterPrice)) {
        const cluster = priceClusters.get(clusterPrice)!;
        cluster.volume += volume;
        cluster.count += 1;
      } else {
        priceClusters.set(clusterPrice, { volume, count: 1 });
      }
    }

    // Преобразуем в массив кластеров
    const clusters: VolumeCluster[] = [];
    const totalVolume = Array.from(priceClusters.values()).reduce(
      (sum, cluster) => sum + cluster.volume,
      0
    );

    // ОТЛАДКА: Проверяем соответствие объемов

    for (const [price, data] of priceClusters.entries()) {
      clusters.push({
        priceLevel: price,
        volume: data.volume,
        percentage: (data.volume / totalVolume) * 100,
        tradeCount: data.count
      });
    }

    // Сортируем по цене
    clusters.sort((a, b) => a.priceLevel - b.priceLevel);

    return clusters;
  }

  // Реальный кластерный анализ на основе WebSocket или API данных
  public async analyzeVolumeClusters(
    signalCandle: Candle,
    previousCandle: Candle
  ): Promise<ClusterAnalysisResult> {
    // Проверяем, нужен ли кластерный анализ для этой свечи
    if (!this.shouldAnalyzeClusters(signalCandle)) {
      // Если кластерный анализ не нужен, используем простую логику
      return this.getSimpleDirectionAnalysis(signalCandle, previousCandle);
    }

    // Используем минутные свечи для анализа распределения объема
    logger.info(
      `📊 Анализ минутных свечей для часовой свечи: ${new Date(
        signalCandle.timestamp
      ).toLocaleString()}`
    );

    try {
      const minuteCandles = await this.client.futuresCandles({
        symbol: this.SYMBOL,
        interval: "1m",
        startTime: signalCandle.timestamp,
        endTime: signalCandle.timestamp + 60 * 60 * 1000, // +1 час
        limit: 60
      });

      if (minuteCandles.length === 0) {
        logger.warn(`⚠️ Нет минутных свечей, используем простой анализ`);
        return this.getSimpleDirectionAnalysis(signalCandle, previousCandle);
      }

      logger.info(`📊 Получено ${minuteCandles.length} минутных свечей`);

      // Проверяем на черные дыры (> 70% объема в одной минутной свече)
      const totalVolume = minuteCandles.reduce(
        (sum, c) => sum + parseFloat(c.volume),
        0
      );
      const problemMinutes = minuteCandles.filter(c => {
        const percent = (parseFloat(c.volume) / totalVolume) * 100;
        return percent > 70;
      });

      if (problemMinutes.length > 0) {
        logger.info(
          `⚠️ Найдено ${problemMinutes.length} проблемных минутных свечей (> 70% объема)`
        );
        logger.info(`🔍 Используем VWAP анализ для точности...`);

        // Используем VWAP анализ для проблемных минутных свечей
        return this.analyzeMinuteCandlesWithVWAP(
          minuteCandles,
          signalCandle,
          previousCandle
        );
      }

      // Обычный анализ минутных свечей
      return this.analyzeMinuteCandles(
        minuteCandles,
        signalCandle,
        previousCandle
      );
    } catch (error) {
      logger.error(`❌ Ошибка при получении минутных свечей:`, error);
      return this.getSimpleDirectionAnalysis(signalCandle, previousCandle);
    }
  }

  public async initialize(): Promise<void> {
    try {
      logger.info(`🔍 Загрузка правил торговли для ${this.SYMBOL}...`);
      const exchangeInfo = await this.client.futuresExchangeInfo();
      const symbolInfo = exchangeInfo.symbols.find(
        s => s.symbol === this.SYMBOL
      );

      if (symbolInfo) {
        this.pricePrecision = symbolInfo.pricePrecision;
        this.quantityPrecision = symbolInfo.quantityPrecision;

        // Находим tick size из фильтров
        const filterTickSize = symbolInfo.filters.find(
          f => f.filterType === "PRICE_FILTER"
        );
        if (filterTickSize) {
          this.tickSize = parseFloat(filterTickSize.tickSize);
        }

        logger.info(
          `✅ Правила для ${this.SYMBOL}: Точность цены=${this.pricePrecision}, Точность кол-ва=${this.quantityPrecision}, Шаг цены=${this.tickSize}`
        );
      } else {
        logger.warn(
          `⚠️ Не удалось найти правила для ${this.SYMBOL}, используются значения по умолчанию.`
        );
      }
    } catch (error) {
      logger.error("❌ Ошибка при загрузке правил торговли:", error);
    }
  }

  private roundToTickSize(price: number): number {
    return Math.round(price / this.tickSize) * this.tickSize;
  }

  public getActivePosition(): ActivePosition | null {
    return this.activePosition;
  }

  public getCurrentSignal(): VolumeSignal | null {
    return this.currentSignal;
  }

  // УДАЛЕН метод getMaxSignalCandles - больше не нужен!

  private async forceAnalysisAfterPositionClose(): Promise<void> {
    try {
      logger.info("🔍 Принудительный анализ после закрытия позиции...");

      // Сначала проверяем, есть ли уже активный сигнал
      const existingSignal = this.getCurrentSignal();
      if (existingSignal) {
        logger.info(
          `📊 Проверяем существующий сигнал: ${new Date(
            existingSignal.candle.timestamp
          ).toLocaleString()}, V=${existingSignal.candle.volume.toFixed(2)}`
        );
      }

      // Получаем последние свечи через API
      const candles = await this.client.futuresCandles({
        symbol: this.SYMBOL,
        interval: "1h",
        limit: 10
      });

      if (candles && candles.length >= 2) {
        // Форматируем все свечи
        const formattedCandles: Candle[] = candles.map(kline => ({
          timestamp: kline.openTime,
          open: parseFloat(kline.open),
          high: parseFloat(kline.high),
          low: parseFloat(kline.low),
          close: parseFloat(kline.close),
          volume: parseFloat(kline.volume),
          turnover: parseFloat(kline.quoteVolume),
          confirmed: true, // Исторические свечи всегда подтверждены
          isGreen: parseFloat(kline.close) >= parseFloat(kline.open)
        }));

        // Берем последние 2 свечи
        const currentCandle = formattedCandles[formattedCandles.length - 1];
        const prevCandle = formattedCandles[formattedCandles.length - 2];

        logger.info(`🔍 Анализируем свечи после закрытия позиции:`);
        logger.info(
          `   📊 Текущая: ${new Date(
            currentCandle.timestamp
          ).toLocaleString()} - V=${currentCandle.volume.toFixed(2)}`
        );
        logger.info(
          `   📊 Предыдущая: ${new Date(
            prevCandle.timestamp
          ).toLocaleString()} - V=${prevCandle.volume.toFixed(2)}`
        );

        // Если есть существующий сигнал, проверяем возможность входа
        if (existingSignal) {
          logger.info(
            "🎯 Проверяем возможность входа по существующему сигналу..."
          );

          // Проверяем, что текущая свеча может быть подтверждающей
          if (
            currentCandle.timestamp > existingSignal.candle.timestamp &&
            currentCandle.volume < existingSignal.candle.volume
          ) {
            logger.info(
              `✅ ПОТЕНЦИАЛЬНОЕ ПОДТВЕРЖДЕНИЕ: Объем ${currentCandle.volume.toFixed(
                2
              )} < сигнальной ${existingSignal.candle.volume.toFixed(2)}`
            );
            logger.info(
              "⏳ СИГНАЛ ГОТОВ К ВХОДУ - ждем закрытия подтверждающей свечи в реальном времени"
            );

            // НЕ входим в позицию здесь! Это должно происходить только через WebSocket при реальном закрытии свечи
            // await this.processCompletedCandle(currentCandle, formattedCandles);
            return; // Оставляем сигнал активным для обработки в реальном времени
          } else {
            logger.info(
              `⚠️ Подтверждения не найдено: объем ${currentCandle.volume.toFixed(
                2
              )} >= сигнальной ${existingSignal.candle.volume.toFixed(
                2
              )} или свеча слишком старая`
            );
          }
        }

        // НЕ ищем новые сигналы здесь! API данные могут быть устаревшими.
        // Поиск новых сигналов должен происходить только в реальном времени через WebSocket!

        logger.info(
          "⏳ Ждем новые сигналы в реальном времени через WebSocket..."
        );
      }
    } catch (error) {
      logger.error("❌ Ошибка при принудительном анализе:", error);
    }
  }

  public resetSignal(): void {
    if (this.currentSignal) {
      const signalAge = Date.now() - this.currentSignal.candle.timestamp;
      const ageInHours = signalAge / (60 * 60 * 1000);

      logger.info(
        `🔄 СИГНАЛ СБРОШЕН: ${new Date(
          this.currentSignal.candle.timestamp
        ).toLocaleString()}, V=${this.currentSignal.candle.volume.toFixed(
          2
        )}, возраст: ${ageInHours.toFixed(1)}ч`
      );

      // Предупреждение о подозрительно быстром сбросе
      if (ageInHours < 2) {
        logger.warn(
          `⚠️ ПОДОЗРИТЕЛЬНО БЫСТРЫЙ СБРОС: Сигнал сброшен через ${ageInHours.toFixed(
            1
          )} часов. Возможна ошибка в логике!`
        );
      }

      this.currentSignal = null;

      // ОЧИСТКА ИСТОРИИ: После сброса сигнала очищаем старые свечи
      this.cleanupCandleHistory();
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

  private cleanupCandleHistory(): void {
    // Очищаем историю свечей, оставляя только последние 2-3 свечи
    if (this.candleHistory.length > 3) {
      const oldLength = this.candleHistory.length;
      this.candleHistory = this.candleHistory.slice(-3);
      logger.info(
        `🧹 Очищена история свечей: ${oldLength} → ${this.candleHistory.length}`
      );
    }
  }

  public async syncPositionState(candleHistory: Candle[] = []): Promise<void> {
    try {
      // Сохраняем только последние несколько свечей
      this.candleHistory = candleHistory.slice(-this.MAX_HISTORY_SIZE);

      // В Binance информация о позициях и ордерах получается раздельно
      // Сначала получаем информацию о позициях
      const positions = await this.client.futuresPositionRisk({
        symbol: this.SYMBOL
      });

      const openPositions = positions.filter(
        pos => parseFloat(pos.positionAmt) !== 0
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
          this.activePosition.side ===
            (parseFloat(position.positionAmt) > 0 ? "Buy" : "Sell") &&
          Math.abs(
            parseFloat(position.entryPrice) - this.activePosition.entryPrice
          ) < 0.1
        ) {
          logger.info(
            "⚠️ Пропускаем усыновление - это наша недавно открытая позиция"
          );
          return;
        }
        const positionSize = position.positionAmt;
        const currentPrice = parseFloat(position.markPrice);
        const side = parseFloat(position.positionAmt) > 0 ? "Buy" : "Sell";
        const entryPrice = parseFloat(position.entryPrice);
        const unrealisedPnl = parseFloat(position.unRealizedProfit);

        logger.info(`🔄 УСЫНОВЛЕНИЕ СУЩЕСТВУЮЩЕЙ ПОЗИЦИИ:`);
        logger.info(`    Размер: ${positionSize} ${this.SYMBOL}`);
        logger.info(`   📈 Сторона: ${side}`);
        logger.info(`   💰 Средняя цена входа: ${entryPrice}`);
        logger.info(`   💹 Текущая P&L: ${unrealisedPnl} USDT`);

        // Получаем текущие TP/SL через запрос открытых ордеров
        const openOrders = await this.client.futuresOpenOrders({
          symbol: this.SYMBOL
        });

        const takeProfitOrder = openOrders.find(
          o => o.type === "TAKE_PROFIT_MARKET"
        );
        const stopLossOrder = openOrders.find(o => o.type === "STOP_MARKET");

        let currentTakeProfit: number | undefined = takeProfitOrder
          ? parseFloat(takeProfitOrder.stopPrice)
          : undefined;
        let currentStopLoss: number | undefined = stopLossOrder
          ? parseFloat(stopLossOrder.stopPrice)
          : undefined;
        let isTrailingActive = false;

        // Проверяем профит для активации трейлинга
        const profitPoints =
          side === "Buy"
            ? currentPrice - entryPrice
            : entryPrice - currentPrice;

        // Ищем последний сигнал для установки стоп-лосса
        let stopLossLevel = 0;
        let foundSignal = false;
        let prevCandle: Candle | null = null;

        // Берем последние две свечи из истории
        if (this.candleHistory.length >= 2) {
          const lastCandle = this.candleHistory[this.candleHistory.length - 1];
          prevCandle = this.candleHistory[this.candleHistory.length - 2];

          // Проверяем объем для определения сигнальной свечи
          if (prevCandle.volume > this.VOLUME_THRESHOLD) {
            foundSignal = true;
            stopLossLevel =
              side === "Buy"
                ? Math.min(prevCandle.low, lastCandle.low)
                : Math.max(prevCandle.high, lastCandle.high);
          }
        }

        // Фиксированные уровни: TP=1, SL=0.5 от цены входа
        const stopLoss = side === "Buy" ? entryPrice - 0.5 : entryPrice + 0.5;
        const takeProfit = side === "Buy" ? entryPrice + 1 : entryPrice - 1;

        // Отменяем все существующие стоп-ордера
        try {
          for (const order of openOrders) {
            if (
              order.type === "STOP_MARKET" ||
              order.type === "TAKE_PROFIT_MARKET"
            ) {
              await this.client.futuresCancelOrder({
                symbol: this.SYMBOL,
                orderId: Number(order.orderId)
              });
              logger.info(`✅ Отменен существующий ордер: ${order.orderId}`);
            }
          }
        } catch (error) {
          logger.error("❌ Ошибка при отмене существующих ордеров:", error);
        }

        // Устанавливаем TP/SL
        logger.info("\n🎯 УСТАНАВЛИВАЕМ TP/SL:");

        try {
          // Установка Take Profit
          await this.client.futuresOrder({
            symbol: this.SYMBOL,
            side: side === "Buy" ? "SELL" : "BUY",
            type: "TAKE_PROFIT_MARKET",
            quantity: position.positionAmt.replace("-", ""),
            stopPrice: takeProfit.toFixed(2),
            reduceOnly: "true"
          });
          logger.info(`✅ Установлен TP=${takeProfit.toFixed(2)}`);

          // Установка Stop Loss
          await this.client.futuresOrder({
            symbol: this.SYMBOL,
            side: side === "Buy" ? "SELL" : "BUY",
            type: "STOP_MARKET",
            quantity: position.positionAmt.replace("-", ""),
            stopPrice: stopLoss.toFixed(2),
            reduceOnly: "true"
          });
          logger.info(`✅ Установлен SL=${stopLoss.toFixed(2)}`);
        } catch (e) {
          logger.error(`❌ Ошибка при установке TP/SL: ${e.body}`);
        }

        // Трейлинг отключен
        isTrailingActive = false;

        // Рассчитываем actualTradeSize на основе реальной позиции
        const positionSizeUSD =
          Math.abs(parseFloat(position.positionAmt)) * entryPrice;

        // Находим реальное время открытия позиции из истории сделок
        let realEntryTime = Date.now();
        try {
          const recentTrades = await this.client.futuresUserTrades({
            symbol: this.SYMBOL,
            limit: 50
          });

          // Ищем первую сделку по позиции (самую старую)
          const positionTrades = recentTrades.filter(trade => {
            const tradeTime = Number(trade.time);
            const tradeSize = parseFloat(trade.qty);
            const isPositionTrade =
              Math.abs(tradeSize) >=
              Math.abs(parseFloat(position.positionAmt)) * 0.1; // Примерно 10% от размера позиции
            return isPositionTrade;
          });

          if (positionTrades.length > 0) {
            // Берем самую старую сделку
            const oldestTrade = positionTrades.reduce((oldest, current) => {
              return Number(current.time) < Number(oldest.time)
                ? current
                : oldest;
            });
            realEntryTime = Number(oldestTrade.time);
            logger.info(
              `🔍 Найдено реальное время открытия позиции: ${new Date(
                realEntryTime
              ).toLocaleString()}`
            );
          }
        } catch (error) {
          logger.error("❌ Ошибка при поиске времени открытия позиции:", error);
        }

        this.activePosition = {
          side: side as any,
          entryPrice: entryPrice,
          entryTime: realEntryTime,
          isTrailingActive: isTrailingActive,
          lastTrailingStopPrice: stopLoss,
          orderId: "",
          plannedTakeProfit: takeProfit,
          plannedStopLoss: stopLoss,
          executionNotificationSent: true,
          actualTradeSize: positionSizeUSD
        };

        // Сохраняем время открытия позиции
        this.lastPositionOpenTime = Date.now();

        // Отправляем уведомление об усыновлении
        const adoptMessage = this.formatPositionAdoptedAlert(position as any);
        await this.callbacks.onTradeOperation(adoptMessage);

        // Всегда запускаем мониторинг позиции при усыновлении для отслеживания закрытия
        logger.info("🔄 Запускаем мониторинг усыновленной позиции...");
        this.startPositionCheck();

        // Не запускаем трейлинг-стоп

        // Проверять и устанавливать TP/SL заново не нужно, мы это сделали выше
      } else {
        logger.info("✅ Открытых позиций не найдено, состояние чистое");
      }
    } catch (error) {
      logger.error("❌ Ошибка при синхронизации состояния позиций:", error);
    }
  }

  private formatPositionAdoptedAlert(position: {
    positionAmt: string;
    unRealizedProfit: string;
    entryPrice: string;
    liquidationPrice: string;
    positionMargin: string;
  }): string {
    const positionAmt = parseFloat(position.positionAmt);
    const side = positionAmt > 0 ? "ЛОНГ" : "ШОРТ";
    const pnl = Number(position.unRealizedProfit);
    const pnlEmoji = pnl >= 0 ? "📈" : "📉";
    const pnlText = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);

    let message = `🔄 ПОЗИЦИЯ УСЫНОВЛЕНА\n\n`;
    message += `📊 Направление: ${side}\n`;
    message += `💰 Размер: ${position.positionAmt} ${this.SYMBOL}\n`;
    message += `📈 Цена входа: ${position.entryPrice}\n`;
    message += `💹 Текущая P&L: ${pnlEmoji} ${pnlText} USDT\n`;

    message += `\n📊 Дополнительная информация:\n`;
    message += `⚡️ Ликвидационная цена: ${position.liquidationPrice ||
      "Н/Д"}\n`;
    message += `💵 Маржа позиции: ${position.positionMargin || "Н/Д"} USDT\n`;
    message += `📅 Время создания: ${new Date().toLocaleString()}\n`;

    // Трейлинг-стоп отключен

    return message;
  }

  //

  private cleanupOldSignals(oldestCandleTimestamp: number): void {
    // Очищаем сигналы старше 24 часов
    const MAX_SIGNAL_AGE = 2 * 60 * 60 * 1000; // 2 часа в миллисекундах
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

  public async checkVolumeSpike(
    currentCandle: Candle,
    previousCandle: Candle,
    candleHistory: Candle[]
  ): Promise<void> {
    logger.info(
      `🚨 ВХОД В checkVolumeSpike: ${new Date(
        currentCandle.timestamp
      ).toLocaleString()}`
    );
    logger.info(`   📊 Текущая свеча confirmed: ${currentCandle.confirmed}`);
    logger.info(
      `   📊 Предыдущая свеча confirmed: ${previousCandle.confirmed}`
    );

    // КРИТИЧЕСКАЯ ПРОВЕРКА: Не анализируем свечу, которая уже была сигнальной
    if (this.currentSignal?.candle.timestamp === currentCandle.timestamp) {
      logger.info(
        `⚠️ ПРОПУСК: Свеча ${new Date(
          currentCandle.timestamp
        ).toLocaleString()} уже была сигнальной`
      );
      return;
    }

    // ПРИНУДИТЕЛЬНАЯ ДИАГНОСТИКА: Логируем все ключевые данные
    logger.info(`🔍 ПРИНУДИТЕЛЬНАЯ ДИАГНОСТИКА:`);
    logger.info(
      `   📊 Текущая свеча: ${new Date(
        currentCandle.timestamp
      ).toLocaleString()}, V=${currentCandle.volume.toFixed(2)}, confirmed=${
        currentCandle.confirmed
      }`
    );
    logger.info(
      `   📊 Предыдущая свеча: ${new Date(
        previousCandle.timestamp
      ).toLocaleString()}, V=${previousCandle.volume.toFixed(2)}, confirmed=${
        previousCandle.confirmed
      }`
    );
    logger.info(`   📊 Порог объема: ${this.VOLUME_THRESHOLD.toFixed(2)}`);
    if (this.currentSignal?.isActive) {
      logger.info(
        `   🎯 Активный сигнал: ${new Date(
          this.currentSignal.candle.timestamp
        ).toLocaleString()}, V=${this.currentSignal.candle.volume.toFixed(2)}`
      );
    } else {
      logger.info(`   ❌ Нет активного сигнала`);
    }

    // Проверяем состояние активного сигнала
    if (this.currentSignal) {
      logger.info(
        `   🎯 Активный сигнал: ${new Date(
          this.currentSignal.candle.timestamp
        ).toLocaleString()}, V=${this.currentSignal.candle.volume.toFixed(2)}`
      );
    } else {
      logger.info(`   ❌ Активного сигнала нет`);
    }

    // Проверяем, что обе свечи подтверждены
    if (!currentCandle.confirmed || !previousCandle.confirmed) {
      logger.info(`❌ ВЫХОД: Одна из свечей не подтверждена`);
      return;
    }

    // WebSocket сбор данных больше не нужен - используем минутные свечи

    logger.info(
      `🔍 ПРОВЕРКА СИГНАЛА: ${new Date(
        currentCandle.timestamp
      ).toLocaleString()}`
    );
    logger.info(
      `   📊 Текущая свеча: V=${currentCandle.volume.toFixed(2)} (${
        currentCandle.isGreen ? "🟢" : "🔴"
      })`
    );
    logger.info(
      `   📊 Предыдущая свеча: V=${previousCandle.volume.toFixed(2)} (${
        previousCandle.isGreen ? "🟢" : "🔴"
      })`
    );
    logger.info(`   📊 Порог: ${this.VOLUME_THRESHOLD.toFixed(2)}`);
    logger.info(
      `   📊 Условия: объем > порога = ${
        currentCandle.volume > this.VOLUME_THRESHOLD ? "✅" : "❌"
      }, объем > предыдущей = ${
        currentCandle.volume > previousCandle.volume ? "✅" : "❌"
      }`
    );

    // СНАЧАЛА проверяем подтверждение существующего сигнала
    if (this.currentSignal?.isActive) {
      // Проверяем, не является ли текущая свеча подтверждающей для существующего сигнала
      if (currentCandle.volume < this.currentSignal.candle.volume) {
        logger.info(
          `✅ ПОДТВЕРЖДАЮЩАЯ СВЕЧА: Объем ${currentCandle.volume.toFixed(
            2
          )} < сигнальной ${this.currentSignal.candle.volume.toFixed(2)}`
        );

        // Подтверждение найдено - сигнал готов к входу
        return;
      }
    }

    // Проверяем, что объем текущей свечи превышает порог только для сигнальной свечи
    if (currentCandle.volume > this.VOLUME_THRESHOLD) {
      logger.info(
        `🔍 Объем выше порога: ${currentCandle.volume.toFixed(2)} > ${
          this.VOLUME_THRESHOLD
        }`
      );

      // ДИАГНОСТИКА: Логируем состояние активного сигнала
      if (this.currentSignal?.isActive) {
        logger.info(
          `🔍 ДИАГНОСТИКА: Активный сигнал V=${this.currentSignal.candle.volume.toFixed(
            2
          )}`
        );
        logger.info(
          `🔍 ДИАГНОСТИКА: Текущая свеча V=${currentCandle.volume.toFixed(2)}`
        );
        logger.info(
          `🔍 ДИАГНОСТИКА: Сравнение: ${currentCandle.volume.toFixed(
            2
          )} > ${this.currentSignal.candle.volume.toFixed(2)} = ${
            currentCandle.volume > this.currentSignal.candle.volume
              ? "✅"
              : "❌"
          }`
        );
      } else {
        logger.info(`🔍 ДИАГНОСТИКА: Нет активного сигнала`);
      }

      // Если есть активный сигнал, проверяем объемы
      if (this.currentSignal?.isActive) {
        logger.info(
          `🔍 Есть активный сигнал: ${this.currentSignal.candle.volume.toFixed(
            2
          )} (${new Date(
            this.currentSignal.candle.timestamp
          ).toLocaleString()})`
        );
        logger.info(
          `🔍 Проверяем: ${currentCandle.volume.toFixed(
            2
          )} > ${this.currentSignal.candle.volume.toFixed(2)} = ${
            currentCandle.volume > this.currentSignal.candle.volume
              ? "✅"
              : "❌"
          }`
        );
        // Если текущая свеча имеет больший объем чем сигнальная - она становится новой сигнальной
        if (currentCandle.volume > this.currentSignal.candle.volume) {
          // КЛАСТЕРНЫЙ АНАЛИЗ для новой сигнальной свечи
          const clusterAnalysis = await this.analyzeVolumeClusters(
            currentCandle,
            previousCandle
          );

          logger.info(
            `🔄 НОВАЯ СИГНАЛЬНАЯ СВЕЧА: Объем ${currentCandle.volume.toFixed(
              2
            )} > предыдущей сигнальной ${this.currentSignal.candle.volume.toFixed(
              2
            )}`
          );
          logger.info(
            `   📊 Доминирующая зона объема: ${clusterAnalysis.dominantZone}`
          );

          this.currentSignal = {
            candle: currentCandle,
            isActive: true,
            waitingForLowerVolume: true // Ждем подтверждающую свечу
          };

          // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Устанавливаем сигнал через setSignal
          this.setSignal(this.currentSignal);
        }
      } else {
        // Если нет активного сигнала - нужны ОБА условия: объем выше порога И выше предыдущей свечи
        if (currentCandle.volume > previousCandle.volume) {
          logger.info(
            `🎯 ОБНАРУЖЕН СИГНАЛ: Объем свечи ${new Date(
              currentCandle.timestamp
            ).toLocaleTimeString()} (${currentCandle.volume.toFixed(
              2
            )}) > порога (${this.VOLUME_THRESHOLD.toFixed(
              2
            )}) И > предыдущей (${previousCandle.volume.toFixed(2)})`
          );
          // КЛАСТЕРНЫЙ АНАЛИЗ для определения направления
          const clusterAnalysis = await this.analyzeVolumeClusters(
            currentCandle,
            previousCandle
          );

          logger.info(`\n📊 КЛАСТЕРНЫЙ АНАЛИЗ ИСТОРИЧЕСКОГО СИГНАЛА:`);
          logger.info(
            `   📈 Верхняя треть: ${clusterAnalysis.upperClusterVolume.toFixed(
              2
            )} (${(
              (clusterAnalysis.upperClusterVolume / currentCandle.volume) *
              100
            ).toFixed(1)}%)`
          );
          logger.info(
            `   📊 Средняя треть: ${clusterAnalysis.middleClusterVolume.toFixed(
              2
            )} (${(
              (clusterAnalysis.middleClusterVolume / currentCandle.volume) *
              100
            ).toFixed(1)}%)`
          );
          logger.info(
            `   📉 Нижняя треть: ${clusterAnalysis.lowerClusterVolume.toFixed(
              2
            )} (${(
              (clusterAnalysis.lowerClusterVolume / currentCandle.volume) *
              100
            ).toFixed(1)}%)`
          );
          logger.info(
            `   🎯 Доминирующая зона: ${clusterAnalysis.dominantZone}`
          );
          logger.info(
            `   🚀 Направление входа: ${clusterAnalysis.entryDirection}`
          );

          const directionText =
            clusterAnalysis.entryDirection === "long"
              ? "🟢 ЛОНГ"
              : clusterAnalysis.entryDirection === "short"
              ? "🔴 ШОРТ"
              : "🔄 ПРОДОЛЖЕНИЕ";

          logger.info(
            `   📊 Направление: ${directionText} (на основе кластерного анализа)`
          );
          // OI-анализ 5м внутри часа сигнальной свечи и заключение по направлению
          try {
            const oiZones = await this.analyzeOpenInterestZones(currentCandle);
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
            // игнорируем ошибки OI в моменте фиксации сигнала
          }

          logger.debug(
            `   ⏳ Ожидаем подтверждающую свечу с объемом < ${currentCandle.volume.toFixed(
              2
            )}`
          );

          this.currentSignal = {
            candle: currentCandle,
            isActive: true,
            waitingForLowerVolume: true // Ждем подтверждающую свечу
          };

          // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Устанавливаем сигнал через setSignal
          this.setSignal(this.currentSignal);
        }
      }
    }
  }

  public async processCompletedCandle(
    completedCandle: Candle,
    candleHistory: Candle[]
  ): Promise<void> {
    // Проверяем, что свеча подтверждена
    if (!completedCandle.confirmed) {
      return;
    }

    // Проверяем, есть ли активный сигнал
    if (!this.currentSignal?.isActive) {
      logger.info(
        `ℹ️ Нет активного сигнала для свечи ${new Date(
          completedCandle.timestamp
        ).toLocaleTimeString()}`
      );
      return;
    }

    logger.info(
      `🔍 ОБРАБОТКА СИГНАЛА: Проверяем свечу ${new Date(
        completedCandle.timestamp
      ).toLocaleTimeString()}`
    );

    // КРИТИЧЕСКАЯ ПРОВЕРКА: Не обрабатываем ту же самую свечу, что и сигнальная
    if (completedCandle.timestamp === this.currentSignal.candle.timestamp) {
      logger.info(
        `⚠️ ПРОПУСК: Это та же самая свеча, что и сигнальная (${new Date(
          completedCandle.timestamp
        ).toLocaleTimeString()})`
      );
      return;
    }

    // КРИТИЧЕСКАЯ ПРОВЕРКА: Сигнал должен быть на предыдущей свече от подтверждающей
    const signalCandleTime = this.currentSignal.candle.timestamp;
    const completedCandleTime = completedCandle.timestamp;
    const timeDifference = completedCandleTime - signalCandleTime;

    // Сигнал должен быть на предыдущей свече (разница в 1 час)
    if (timeDifference > 60 * 60 * 1000) {
      logger.info(
        `⚠️ ПРОПУСК: Сигнал слишком старый (${Math.round(
          timeDifference / (60 * 1000)
        )} мин назад), пропускаем`
      );
      return;
    }

    // Проверяем объем подтверждающей свечи
    if (completedCandle.volume >= this.currentSignal.candle.volume) {
      logger.info(
        `❌ ОТМЕНА СИГНАЛА: Объем подтверждающей свечи (${completedCandle.volume.toFixed(
          2
        )}) >= объема сигнальной свечи (${this.currentSignal.candle.volume.toFixed(
          2
        )})`
      );
      this.resetSignal();
      return;
    }

    logger.info(
      `✅ ПОДТВЕРЖДЕНИЕ СИГНАЛА: Объем в норме (${completedCandle.volume.toFixed(
        2
      )} < ${this.currentSignal.candle.volume.toFixed(2)})`
    );

    // Проверяем существующие позиции через API
    try {
      const positions = await this.client.futuresPositionRisk({
        symbol: this.SYMBOL
      });

      if (positions && positions.length > 0) {
        const openPositions = positions.filter(
          pos => parseFloat(pos.positionAmt) !== 0
        );

        if (openPositions.length > 0) {
          // Проверяем общий размер позиции
          const totalPositionSize = openPositions.reduce((sum, pos) => {
            const positionSize = Math.abs(parseFloat(pos.positionAmt));
            const positionPrice = parseFloat(pos.entryPrice);
            return sum + positionSize * positionPrice;
          }, 0);

          if (totalPositionSize >= this.TRADE_SIZE_USD) {
            logger.info(
              `⚠️ ПРОПУСК ОТКРЫТИЯ: Общий размер позиции (${totalPositionSize.toFixed(
                2
              )} USDT) превышает максимальный (${this.TRADE_SIZE_USD} USDT)`
            );
            this.resetSignal();
            return;
          }

          logger.info(
            `⚠️ ПРОПУСК ОТКРЫТИЯ: Уже есть открытая позиция (${totalPositionSize.toFixed(
              2
            )} USDT)`
          );
          this.resetSignal();
          return;
        }
      }
    } catch (error) {
      logger.error("❌ Ошибка при проверке существующих позиций:", error);
      return;
    }

    // Если все проверки пройдены, открываем позицию
    logger.info(`🚀 ОТКРЫВАЕМ ПОЗИЦИЮ: Все проверки пройдены успешно!`);

    // Сохраняем ссылку на сигнал перед открытием позиции
    const signalToUse = this.currentSignal;

    // СБРАСЫВАЕМ СИГНАЛ СРАЗУ - он уже отработан!
    logger.info("🗑️ Сигнал отработан и забыт навсегда");
    this.currentSignal = null;

    try {
      // Открываем позицию
      await this.openPosition(signalToUse.candle, completedCandle);

      // Ждем установки TP и SL
      await new Promise(resolve => setTimeout(resolve, 2000)); // Даем 2 секунды на установку TP/SL

      logger.info("✅ Позиция открыта, сигнал успешно отработан");
    } catch (error) {
      logger.error("❌ Ошибка при открытии позиции:", error);
      // Сигнал уже сброшен - не восстанавливаем его!
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
      logger.info("💰 Проверяем баланс аккаунта...");
      const accountInfo = await this.client.futuresAccountInfo();

      if (!accountInfo || !accountInfo.assets) {
        logger.error("❌ Не удалось получить информацию о балансе");
        this.isOpeningPosition = false;
        return false;
      }

      const usdtAsset = accountInfo.assets.find(
        (asset: any) => asset.asset === "USDT"
      );
      if (!usdtAsset) {
        logger.error("❌ Не найден USDT в балансе");
        this.isOpeningPosition = false;
        return false;
      }

      const availableBalance = parseFloat(usdtAsset.availableBalance);

      // Пересчитываем размер позиции на основе текущего баланса
      const riskPercentage = 95; // 95% от баланса
      const currentTradeSize =
        availableBalance * (riskPercentage / 100) * this.LEVERAGE;
      const requiredMargin = currentTradeSize / this.LEVERAGE; // Требуемая маржа с учетом плеча

      logger.info(`💰 Доступный баланс: ${availableBalance.toFixed(2)} USDT`);
      logger.info(
        `💰 Требуемая маржа (${this.LEVERAGE}x): ${requiredMargin.toFixed(
          2
        )} USDT`
      );

      if (availableBalance < requiredMargin) {
        logger.error(
          `❌ НЕДОСТАТОЧНО СРЕДСТВ: Доступно ${availableBalance.toFixed(
            2
          )} USDT, требуется ${requiredMargin.toFixed(2)} USDT`
        );
        logger.info(
          `💡 Рекомендация: пополнить баланс или уменьшить размер позиции`
        );
        this.isOpeningPosition = false;
        return false;
      }

      logger.info(`✅ Баланс достаточен для открытия позиции`);
      logger.info(`💰 Пересчет размера позиции:`);
      logger.info(
        `   📊 Доступный баланс: ${availableBalance.toFixed(2)} USDT`
      );
      logger.info(`   📊 Риск: ${riskPercentage}%`);
      logger.info(`   📊 Плечо: ${this.LEVERAGE}x`);
      logger.info(
        `   📊 Новый размер позиции: ${currentTradeSize.toFixed(2)} USDT`
      );
      logger.info(
        `   📊 Старый размер позиции: ${this.TRADE_SIZE_USD.toFixed(2)} USDT`
      );

      // Получаем текущую рыночную цену через API
      const tickerResponse = await this.client.futuresMarkPrice();
      // The response can be an array if no symbol is passed, or a single object.
      // The types might be a bit off in the lib, so we handle both.
      const ticker = Array.isArray(tickerResponse)
        ? tickerResponse.find(t => t.symbol === this.SYMBOL)
        : tickerResponse; // Should be an array based on no-arg call

      if (!ticker) {
        logger.error(`❌ Не удалось получить цену для ${this.SYMBOL}`);
        this.isOpeningPosition = false;
        return false;
      }
      const currentMarketPrice = parseFloat(ticker.markPrice);

      if (!currentMarketPrice) {
        logger.error("❌ Не удалось получить текущую цену");
        this.isOpeningPosition = false;
        return false;
      }

      logger.info(`   💰 Текущая цена: ${currentMarketPrice}`);

      // РЕАЛЬНЫЙ КЛАСТЕРНЫЙ АНАЛИЗ: определяем доминирующую зону по объему на основе aggTrades
      const clusterAnalysis = await this.analyzeVolumeClusters(
        signalCandle,
        currentCandle
      );

      logger.info(`\n📊 РЕАЛЬНЫЙ КЛАСТЕРНЫЙ АНАЛИЗ ОБЪЕМА:`);
      logger.info(
        `   📈 Верхняя треть: ${clusterAnalysis.upperClusterVolume.toFixed(
          2
        )} (${(
          (clusterAnalysis.upperClusterVolume / signalCandle.volume) *
          100
        ).toFixed(1)}%)`
      );
      logger.info(
        `   📊 Средняя треть: ${clusterAnalysis.middleClusterVolume.toFixed(
          2
        )} (${(
          (clusterAnalysis.middleClusterVolume / signalCandle.volume) *
          100
        ).toFixed(1)}%)`
      );
      logger.info(
        `   📉 Нижняя треть: ${clusterAnalysis.lowerClusterVolume.toFixed(
          2
        )} (${(
          (clusterAnalysis.lowerClusterVolume / signalCandle.volume) *
          100
        ).toFixed(1)}%)`
      );
      logger.info(`   🎯 Доминирующая зона: ${clusterAnalysis.dominantZone}`);
      // Убираем «направление» из кластеров — используем только доминирующую зону

      // Показываем топ-5 кластеров по объему
      if (clusterAnalysis.clusters.length > 0) {
        const topClusters = clusterAnalysis.clusters
          .sort((a, b) => b.volume - a.volume)
          .slice(0, 5);

        logger.info(`   🔥 Топ-5 кластеров по объему:`);
        for (const cluster of topClusters) {
          logger.info(
            `      💰 ${cluster.priceLevel.toFixed(
              4
            )}: ${cluster.volume.toFixed(2)} (${cluster.percentage.toFixed(
              1
            )}%) - ${cluster.tradeCount} сделок`
          );
        }
      }

      // Определяем сторону ТОЛЬКО по правилу OI в доминирующей зоне кластеров
      let side: "Buy" | "Sell" = currentCandle.isGreen ? "Buy" : "Sell";
      try {
        const oiZones = await this.analyzeOpenInterestZones(signalCandle);
        if (oiZones) {
          const comparedZone =
            clusterAnalysis.upperClusterVolume >=
            clusterAnalysis.lowerClusterVolume
              ? "upper"
              : "lower";
          const zoneDelta =
            comparedZone === "upper" ? oiZones.upperDelta : oiZones.lowerDelta;
          const oiTrend = zoneDelta >= 0 ? "рост" : "падение";
          side =
            comparedZone === "lower"
              ? zoneDelta < 0
                ? "Buy"
                : "Sell"
              : zoneDelta < 0
              ? "Sell"
              : "Buy";
          logger.info(
            `   🧭 Итоговый вердикт по OI: зона=${comparedZone}, в зоне ${oiTrend} → ${side}`
          );
        }
      } catch (e) {
        logger.warn(
          "⚠️ Не удалось получить анализ OI при входе, используем цвет свечи"
        );
      }
      const limitPrice =
        side === "Buy"
          ? this.roundToTickSize(currentMarketPrice - 0.01) // Для покупки ставим ближе к рынку
          : this.roundToTickSize(currentMarketPrice + 0.01); // Для продажи ставим ближе к рынку

      logger.info(
        `   📊 Лимитный ордер будет установлен по цене: ${limitPrice}`
      );

      // Рассчитываем размер позиции на основе текущего баланса
      const rawSize = currentTradeSize / limitPrice;

      // Для SOL используем правильные параметры
      const qtyStep = 0.01; // Минимальный шаг для SOL
      const minQty = 0.01; // Минимальный размер для SOL

      const contractSize = (Math.floor(rawSize / qtyStep) * qtyStep).toFixed(
        this.quantityPrecision
      );

      // Проверяем, что размер позиции корректный
      if (Number(contractSize) < minQty) {
        logger.error(
          `❌ Размер позиции ${contractSize} меньше минимального ${minQty}`
        );
        this.isOpeningPosition = false;
        return false;
      }

      logger.info(
        `💰 Расчет размера позиции: $${currentTradeSize.toFixed(
          2
        )} / ${limitPrice} = ${rawSize} → ${contractSize} SOL`
      );

      // Создаем лимитный ордер на вход
      logger.info("\n🚀 РАЗМЕЩАЕМ ЛИМИТНЫЙ ОРДЕР НА ВХОД:");
      logger.info(`   📊 Параметры ордера:`);
      logger.info(`   - Сторона: ${side}`);
      logger.info(`   - Цена: ${limitPrice}`);
      logger.info(`   - Размер: ${contractSize}`);
      logger.info(`   - Плечо: ${this.LEVERAGE}x`);
      logger.info(`   - Размер в USDT: $${currentTradeSize.toFixed(2)}`);

      const orderResponse = await this.client.futuresOrder({
        symbol: this.SYMBOL,
        side: side.toUpperCase() as OrderSide,
        type: "LIMIT",
        quantity: contractSize,
        price: limitPrice.toFixed(this.pricePrecision),
        timeInForce: "GTC"
      });

      logger.info(
        `📊 Ответ на размещение ордера: ${JSON.stringify(orderResponse)}`
      );

      if (!orderResponse.orderId) {
        logger.error(`❌ Ошибка при установке лимитного ордера: нет orderId`);
        this.isOpeningPosition = false;
        return false;
      }

      const orderId = orderResponse.orderId;

      logger.info(
        `✅ Размещен лимитный ордер ${orderId} на ${side} по цене ${limitPrice}`
      );

      // Ждем исполнения ордера
      let orderFilled = false;
      let retryCount = 0;
      const maxRetries = 1; // 1 попытка = 10 секунд ожидания
      const RETRY_INTERVAL = 10000; // 10 секунд между попытками

      while (!orderFilled && retryCount < maxRetries) {
        try {
          // Проверяем активные ордера
          const activeOrders = await this.client.futuresOpenOrders({
            symbol: this.SYMBOL
          });

          // Если ордера нет в активных, проверяем историю
          if (!activeOrders.some(o => String(o.orderId) === String(orderId))) {
            // Проверяем позицию
            const positionInfo = await this.client.futuresPositionRisk({
              symbol: this.SYMBOL
            });

            if (
              positionInfo.length > 0 &&
              positionInfo.some(p => parseFloat(p.positionAmt) !== 0)
            ) {
              orderFilled = true;
              logger.info("✅ Позиция открыта, устанавливаем TP/SL");
              break;
            }

            // Если ордера нет в активных и позиция не открыта, проверяем последние сделки
            const trades = await this.client.futuresUserTrades({
              symbol: this.SYMBOL,
              limit: 5
            });

            const recentTrade = trades.find(
              (t: any) => String(t.orderId) === String(orderId)
            );
            if (recentTrade) {
              orderFilled = true;
              logger.info(
                "✅ Ордер исполнен (найден в истории сделок), устанавливаем TP/SL"
              );
              break;
            }
          }

          if (!orderFilled) {
            logger.info(
              `⏳ Ожидание исполнения ордера... (попытка ${retryCount +
                1}/${maxRetries})`
            );
          }
        } catch (error) {
          logger.error("Ошибка при проверке статуса ордера:", error);
        }

        retryCount++;
        await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL));
      }

      if (!orderFilled) {
        // Проверяем позицию еще раз перед отменой
        const finalPositionCheck = await this.client.futuresPositionRisk({
          symbol: this.SYMBOL
        });

        if (
          finalPositionCheck.length > 0 &&
          finalPositionCheck.some(p => parseFloat(p.positionAmt) !== 0)
        ) {
          orderFilled = true;
          logger.info("✅ Позиция все-таки открыта, устанавливаем TP/SL");
        } else {
          // Отменяем лимитный ордер и переходим на рыночный
          try {
            await this.client.futuresCancelOrder({
              symbol: this.SYMBOL,
              orderId: Number(orderId)
            });
            logger.info(`✅ Отменен неисполненный лимитный ордер ${orderId}`);
          } catch (error) {
            logger.error("Ошибка при отмене ордера:", error);
          }

          // Переходим на рыночный ордер
          logger.info("🚀 Переходим на рыночный ордер...");
          const marketOrderResponse = await this.client.futuresOrder({
            symbol: this.SYMBOL,
            side: side === "Buy" ? "BUY" : "SELL",
            type: "MARKET",
            quantity: contractSize,
            newOrderRespType: "RESULT"
          });

          if (marketOrderResponse.orderId) {
            logger.info(
              `✅ Размещен рыночный ордер ${marketOrderResponse.orderId} на ${side}`
            );
            orderFilled = true;
          } else {
            throw new Error("Не удалось разместить рыночный ордер");
          }
        }
      }

      // Фиксированные уровни TP/SL: TP=1$, SL=0.5$
      const takeProfit = this.roundToTickSize(
        side === "Buy" ? limitPrice + 1 : limitPrice - 1
      );

      const baseSL = 0.5;
      const stopLoss = this.roundToTickSize(
        side === "Buy" ? limitPrice - baseSL : limitPrice + baseSL
      );

      logger.info(`\n📊 РАСЧЕТ УРОВНЕЙ:`);
      logger.info(`   💰 Цена входа: ${limitPrice}`);
      logger.info(`   🎯 Take Profit: ${takeProfit} (+1$)`);
      logger.info(`   🛡️ Stop Loss: ${stopLoss} (-0.5$) от цены входа`);

      const finalStopLoss = stopLoss;

      // Устанавливаем TP/SL только после исполнения ордера
      console.log("🎯 УСТАНАВЛИВАЕМ TP/SL:");

      try {
        await this.client.futuresOrder({
          symbol: this.SYMBOL,
          side: side === "Buy" ? "SELL" : "BUY",
          type: "TAKE_PROFIT_MARKET",
          quantity: contractSize,
          stopPrice: takeProfit.toFixed(this.pricePrecision),
          reduceOnly: "true"
        });
        logger.info(`✅ Установлен TP=${takeProfit}`);

        await this.client.futuresOrder({
          symbol: this.SYMBOL,
          side: side === "Buy" ? "SELL" : "BUY",
          type: "STOP_MARKET",
          quantity: contractSize,
          stopPrice: finalStopLoss.toFixed(this.pricePrecision),
          reduceOnly: "true"
        });
        logger.info(`✅ Установлен SL=${finalStopLoss}`);
      } catch (e) {
        logger.error(`❌ Ошибка при установке TP/SL: ${e.body}`);
      }

      // Создаем запись о позиции
      this.activePosition = {
        side: side,
        entryPrice: limitPrice,
        entryTime: Date.now(),
        isTrailingActive: false,
        lastTrailingStopPrice: finalStopLoss,
        orderId: String(orderId),
        plannedTakeProfit: takeProfit,
        plannedStopLoss: finalStopLoss,
        executionNotificationSent: false,
        actualTradeSize: currentTradeSize
      };

      // Формируем OI-анализ для сообщения
      let oiAnalysisForMsg: any = undefined;
      try {
        const oiZones = await this.analyzeOpenInterestZones(signalCandle);
        if (oiZones) {
          // Определяем доминирующую зону по объему кластеров и сопоставляем с направлением OI
          const volumes = [
            { zone: "lower", vol: clusterAnalysis.lowerClusterVolume },
            { zone: "middle", vol: clusterAnalysis.middleClusterVolume },
            { zone: "upper", vol: clusterAnalysis.upperClusterVolume }
          ];
          volumes.sort((a, b) => b.vol - a.vol);
          const topZone = volumes[0].zone as "upper" | "lower" | "middle";

          // Берем только верх/низ согласно правилу
          const comparedZone: "upper" | "lower" =
            topZone === "upper" ? "upper" : "lower";
          const zoneDelta =
            comparedZone === "upper" ? oiZones.upperDelta : oiZones.lowerDelta;
          const oiTrendInZone: "up" | "down" = zoneDelta >= 0 ? "up" : "down";

          // Правила направления по OI относительно объема
          // - если объем снизу больше и там OI падал → лонг
          // - если объем сверху больше и там OI падал → шорт
          // - если объем снизу больше и OI рос → шорт
          // - если объем сверху больше и OI рос → лонг
          let sideByOi: "Buy" | "Sell";
          if (comparedZone === "lower" && oiTrendInZone === "down")
            sideByOi = "Buy";
          else if (comparedZone === "upper" && oiTrendInZone === "down")
            sideByOi = "Sell";
          else if (comparedZone === "lower" && oiTrendInZone === "up")
            sideByOi = "Sell";
          else sideByOi = "Buy"; // comparedZone === 'upper' && oiTrendInZone === 'up'

          oiAnalysisForMsg = {
            lowerDelta: oiZones.lowerDelta,
            middleDelta: oiZones.middleDelta,
            upperDelta: oiZones.upperDelta,
            comparedZone,
            oiTrendInZone,
            sideByOi
          };
        }
      } catch (e) {
        // ignore
      }

      // Отправляем уведомление о размещении лимитного ордера
      if (this.activePosition) {
        const openPositionMessage = this.notificationService.formatTradeOpenAlert(
          this.activePosition,
          takeProfit,
          finalStopLoss, // Используем finalStopLoss вместо stopLoss
          signalCandle,
          currentCandle,
          true,
          side,
          currentTradeSize,
          undefined,
          clusterAnalysis,
          oiAnalysisForMsg
        );
        await this.callbacks.onTradeOperation(openPositionMessage);
      }

      // Сохраняем время открытия позиции
      this.lastPositionOpenTime = Date.now();

      // Запускаем проверку позиции (без трейлинга)
      this.startTrailingStopCheck();

      // Очищаем WebSocket данные после входа в сделку
      this.stopRealtimeDataCollection();

      this.isOpeningPosition = false;
      return true;
    } catch (error) {
      logger.error("❌ Ошибка при открытии позиции:", error);
      this.isOpeningPosition = false;
      return false;
    }
  }

  public async finishInitialHistoryAnalysis(): Promise<void> {
    // После завершения исторического анализа проверяем возраст сигнала и окно входа
    if (this.currentSignal?.isActive) {
      const signalAge = Date.now() - this.currentSignal.candle.timestamp;
      const MAX_INITIAL_SIGNAL_AGE = 2 * 60 * 60 * 1000; // 2 часа для перезапуска

      if (signalAge > MAX_INITIAL_SIGNAL_AGE) {
        logger.info(
          `🧹 Сброс устаревшего исторического сигнала от ${new Date(
            this.currentSignal.candle.timestamp
          ).toLocaleTimeString()}`
        );
        this.currentSignal = null;
      } else {
        // Дополнительная проверка: окно входа (20 минут после закрытия подтверждающей)
        const confirmingCandle = this.currentSignal.confirmingCandle;
        if (confirmingCandle) {
          const nextCandleStart = confirmingCandle.timestamp + 60 * 60 * 1000; // +1 час
          const currentTime = Date.now();
          const timeInNextCandle = currentTime - nextCandleStart;
          const ENTRY_WINDOW_MS = 20 * 60 * 1000; // 20 минут

          if (timeInNextCandle > ENTRY_WINDOW_MS) {
            logger.info(
              `⏰ Сброс сигнала: окно входа закрыто (прошло ${Math.round(
                timeInNextCandle / (60 * 1000)
              )} мин, лимит: 20 мин)`
            );
            this.currentSignal = null;
          } else {
            logger.info(
              `🎯 Начальный анализ завершен с активным сигналом от свечи ${new Date(
                this.currentSignal.candle.timestamp
              ).toLocaleTimeString()}`
            );
          }
        } else {
          logger.info(
            `🎯 Начальный анализ завершен с активным сигналом от свечи ${new Date(
              this.currentSignal.candle.timestamp
            ).toLocaleTimeString()}`
          );
        }
      }
    }
    logger.info(
      "✅ Начальный анализ истории завершен, система готова к торговле"
    );
  }

  private async startTrailingStopCheck(): Promise<void> {
    // Запускаем проверку позиции независимо от настроек трейлинга
    if (this.trailingStopCheckInterval) {
      clearInterval(this.trailingStopCheckInterval);
    }

    this.trailingStopCheckInterval = setInterval(async () => {
      await this.checkPositionState();
    }, this.TRAILING_STOP_INTERVAL_MS);
  }

  private async checkPositionState(): Promise<void> {
    try {
      // Если активной позиции нет, прекращаем проверки
      if (!this.activePosition) {
        return;
      }

      // Проверяем текущее состояние позиции
      const positions = await this.client.futuresPositionRisk({
        symbol: this.SYMBOL
      });

      const openPositions = positions.filter(
        pos => parseFloat(pos.positionAmt) !== 0
      );

      // Если нет открытых позиций, но у нас есть активная позиция в состоянии
      if (openPositions.length === 0 && this.activePosition) {
        logger.info("🔄 Позиция закрыта, отменяем оставшиеся ордера");

        // Отменяем все оставшиеся ордера
        try {
          const activeOrders = await this.client.futuresOpenOrders({
            symbol: this.SYMBOL
          });

          for (const order of activeOrders) {
            if (
              order.type === "STOP_MARKET" ||
              order.type === "TAKE_PROFIT_MARKET"
            ) {
              try {
                await this.client.futuresCancelOrder({
                  symbol: this.SYMBOL,
                  orderId: Number(order.orderId)
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
        } catch (error) {
          logger.error("❌ Ошибка при отмене оставшихся ордеров:", error);
        }

        // Получаем реальный P&L из истории сделок
        const trades = await this.client.futuresUserTrades({
          symbol: this.SYMBOL,
          limit: 50 // Получаем больше сделок для поиска всех сделок по позиции
        });

        let closePrice = 0;
        let realPnL = 0;
        let closeReason = "Неизвестно";

        if (trades.length > 0) {
          // ИСПРАВЛЕНИЕ: Берем только сделки по текущей позиции
          // Фильтруем сделки по времени открытия позиции
          const positionOpenTime = this.activePosition?.entryTime || 0;

          const positionTrades = trades.filter(trade => {
            const tradeTime = Number(trade.time);
            return tradeTime >= positionOpenTime; // Только сделки после открытия позиции
          });

          realPnL = positionTrades.reduce((total, trade) => {
            const pnl = parseFloat(trade.realizedPnl || "0");
            return total + pnl;
          }, 0);

          // Берем цену последней сделки как цену закрытия
          const lastTrade = trades[0];
          closePrice = parseFloat(lastTrade.price);
          closeReason = "Позиция закрыта";

          logger.info(
            `📊 Реальный P&L из ${
              positionTrades.length
            } сделок по позиции: $${realPnL.toFixed(2)}`
          );
          logger.debug(
            `📊 Детали сделок по позиции:`,
            positionTrades.map(t => ({
              price: t.price,
              qty: t.qty,
              pnl: t.realizedPnl,
              side: t.side,
              time: new Date(Number(t.time)).toLocaleString()
            }))
          );
        }

        // Отправляем уведомление о закрытии позиции с реальным P&L
        const closePositionMessage = this.notificationService.formatTradeCloseAlert(
          this.activePosition,
          closePrice,
          closeReason,
          realPnL,
          this.activePosition.actualTradeSize
        );

        // Получаем актуальный баланс после закрытия позиции и добавляем в сообщение
        let messageWithBalance = closePositionMessage;
        try {
          const balances = await this.client.futuresAccountBalance();
          const usdt = Array.isArray(balances)
            ? balances.find((b: any) => b.asset === "USDT")
            : null;
          if (usdt && usdt.availableBalance !== undefined) {
            const availableAfter = parseFloat(usdt.availableBalance);
            messageWithBalance = `${closePositionMessage}\n💼 Баланс после сделки: ${availableAfter.toFixed(
              2
            )} USDT`;
          }
        } catch (e) {
          // Если не удалось получить баланс, отправляем исходное сообщение
        }

        await this.callbacks.onTradeOperation(messageWithBalance);

        // Отменяем оставшиеся ордера (TP или SL) после закрытия позиции
        try {
          const remainingOrders = await this.client.futuresOpenOrders({
            symbol: this.SYMBOL
          });

          for (const order of remainingOrders) {
            if (
              order.type === "TAKE_PROFIT_MARKET" ||
              order.type === "STOP_MARKET"
            ) {
              await this.client.futuresCancelOrder({
                symbol: this.SYMBOL,
                orderId: Number(order.orderId)
              });
              logger.info(
                `✅ Отменен оставшийся ордер ${order.type}: ${order.orderId}`
              );
            }
          }
        } catch (error) {
          logger.error("❌ Ошибка при отмене оставшихся ордеров:", error);
        }

        // Сбрасываем состояние
        this.activePosition = null;
        // НЕ сбрасываем сигнал сразу - сначала проверим возможность нового входа
        // this.currentSignal = null;

        // Останавливаем мониторинг позиции и трейлинг
        this.stopPositionCheck();
        this.stopTrailingStopCheck();

        logger.info(
          "✅ Состояние позиции сброшено, проверяем возможность нового входа"
        );

        // ПРИНУДИТЕЛЬНО запускаем анализ после закрытия позиции
        logger.info("🔍 Запускаем анализ после закрытия позиции...");
        await this.forceAnalysisAfterPositionClose();
        return;
      }

      // Трейлинг отключен - просто возвращаемся
      return;
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
      const klineResponse = await this.client.futuresCandles({
        symbol: this.SYMBOL,
        interval: "1h",
        limit: 5 // Получаем последние 5 свечей
      });

      if (klineResponse && klineResponse.length > 0) {
        const candles: Candle[] = klineResponse.map(item => ({
          timestamp: item.openTime,
          open: parseFloat(item.open),
          high: parseFloat(item.high),
          low: parseFloat(item.low),
          close: parseFloat(item.close),
          volume: parseFloat(item.volume),
          turnover: parseFloat(item.quoteVolume),
          confirmed: true,
          isGreen: parseFloat(item.close) >= parseFloat(item.open)
        }));

        logger.info(`📊 Получено ${candles.length} свечей через REST API`);

        // Проверяем каждую свечу на наличие сигнала
        for (let i = 1; i < candles.length; i++) {
          const currentCandle = candles[i];
          const previousCandle = candles[i - 1];

          // Проверяем объем
          this.checkVolumeSpike(currentCandle, previousCandle, candles);

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
    // Запускаем отдельный интервал для мониторинга позиции (независимо от трейлинга)
    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
    }

    logger.info("🔄 Запущен мониторинг позиции каждые 10 секунд");
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

  public clearSignal(): void {
    if (this.currentSignal) {
      logger.info(
        `🗑️ СИГНАЛ ОЧИЩЕН: ${new Date(
          this.currentSignal.candle.timestamp
        ).toLocaleString()}, V=${this.currentSignal.candle.volume.toFixed(2)}`
      );
    }
    this.currentSignal = null;
  }

  public async syncClosedPositions(): Promise<void> {
    try {
      // Получаем информацию о закрытых позициях через историю сделок
      const trades = await this.client.futuresUserTrades({
        symbol: this.SYMBOL,
        limit: 100
      });

      // Группируем сделки по позициям и рассчитываем PnL
      const positionGroups = new Map<string, any[]>();

      trades.forEach((trade: any) => {
        const tradeTime = new Date(Number(trade.time))
          .toISOString()
          .split("T")[0]; // Группируем по дням
        if (!positionGroups.has(tradeTime)) {
          positionGroups.set(tradeTime, []);
        }
        positionGroups.get(tradeTime)!.push(trade);
      });

      // Логируем результаты по дням
      positionGroups.forEach((dayTrades, date) => {
        const totalPnL = dayTrades.reduce(
          (sum, trade) => sum + parseFloat(trade.realizedPnl || "0"),
          0
        );
        logger.info(
          `🔍 ${date}: ${dayTrades.length} сделок, PnL = ${totalPnL.toFixed(
            2
          )} USDT`
        );
      });
    } catch (error) {
      logger.error("❌ Ошибка при получении закрытых позиций:", error);
    }
  }
}
