import { Candle, ActivePosition } from "./binance.types";
import { OrderSide } from "binance-api-node";
import { logger } from "../utils/logger";

export class NotificationService {
  constructor(
    private readonly SYMBOL: string,
    private readonly TRADE_SIZE_USD: number,
    private readonly STOP_LOSS_POINTS: number
  ) {}

  public formatVolumeAlert(
    completedCandle: Candle,
    previousCandle: Candle
  ): string {
    const volumeRatio = completedCandle.volume / previousCandle.volume;
    return (
      `📢 ОБНАРУЖЕН ВСПЛЕСК ОБЪЕМА ${this.SYMBOL}\n\n` +
      `📈 Свеча: ${new Date(
        completedCandle.timestamp
      ).toLocaleTimeString()}\n` +
      `📊 Объем: ${completedCandle.volume.toFixed(
        2
      )} (вырос в ${volumeRatio.toFixed(2)}x)\n` +
      `📈 Предыдущий объем: ${previousCandle.volume.toFixed(2)}\n` +
      `💰 Цена закрытия: ${completedCandle.close}\n` +
      `📊 Движение цены: ${(
        ((completedCandle.close - completedCandle.open) /
          completedCandle.open) *
        100
      ).toFixed(2)}%`
    );
  }

  public formatTradeOpenAlert(
    activePosition: ActivePosition,
    takeProfit: number,
    stopLoss: number,
    signalCandle: Candle,
    currentCandle: Candle,
    isLimitOrder: boolean,
    side: "Buy" | "Sell",
    actualTradeSize?: number,
    candleRange?: number,
    clusterAnalysis?: {
      upperClusterVolume: number;
      middleClusterVolume: number;
      lowerClusterVolume: number;
      dominantZone: "upper" | "middle" | "lower";
      entryDirection: "long" | "short" | "continuation";
    },
    oiAnalysis?: {
      lowerDelta: number;
      middleDelta: number;
      upperDelta: number;
      comparedZone: "upper" | "lower";
      oiTrendInZone: "up" | "down";
      sideByOi: "Buy" | "Sell";
    }
  ): string {
    const tradeSide = side === "Buy" ? "ЛОНГ" : "ШОРТ";
    const orderType = isLimitOrder ? "лимитного" : "рыночного";
    const tradeSize = actualTradeSize || this.TRADE_SIZE_USD;
    const contractSize = (tradeSize / activePosition.entryPrice).toFixed(3);
    const stopLossLevel =
      activePosition.side === "Buy"
        ? Math.min(signalCandle.low, currentCandle.low)
        : Math.max(signalCandle.high, currentCandle.high);

    // Формируем информацию о кластерном анализе (только распределение, без вердикта)
    let clusterInfo = "";
    if (clusterAnalysis) {
      const upperPercent = (
        (clusterAnalysis.upperClusterVolume / signalCandle.volume) *
        100
      ).toFixed(1);
      const middlePercent = (
        (clusterAnalysis.middleClusterVolume / signalCandle.volume) *
        100
      ).toFixed(1);
      const lowerPercent = (
        (clusterAnalysis.lowerClusterVolume / signalCandle.volume) *
        100
      ).toFixed(1);

      clusterInfo =
        `\n📊 КЛАСТЕРНЫЙ АНАЛИЗ:\n` +
        `📈 Верх: ${upperPercent}% | 📊 Сред: ${middlePercent}% | 📉 Низ: ${lowerPercent}%\n`;
    }

    // Формируем информацию об OI-анализе
    let oiInfo = "";
    if (oiAnalysis) {
      const zoneText =
        oiAnalysis.comparedZone === "lower" ? "нижней" : "верхней";
      const trendText = oiAnalysis.oiTrendInZone === "down" ? "падал" : "рос";
      oiInfo =
        `\n📈 ОТКРЫТЫЙ ИНТЕРЕС (5м за час сигнала):\n` +
        `📉 Низ: ${oiAnalysis.lowerDelta.toFixed(
          2
        )} | 📊 Сред: ${oiAnalysis.middleDelta.toFixed(
          2
        )} | 📈 Верх: ${oiAnalysis.upperDelta.toFixed(2)}\n` +
        `🧭 В ${zoneText} трети OI ${trendText} → решение по OI: ${
          oiAnalysis.sideByOi === "Buy" ? "ЛОНГ" : "ШОРТ"
        }`;
    }

    return (
      `🎯 ${
        isLimitOrder ? "ЛИМИТНЫЙ ОРДЕР РАЗМЕЩЕН" : "ОТКРЫТА НОВАЯ СДЕЛКА"
      } ${this.SYMBOL}\n\n` +
      `${activePosition.side === "Buy" ? "📈 ЛОНГ" : "📉 ШОРТ"}\n` +
      `💵 ${
        isLimitOrder ? "Цена ордера" : "Цена входа"
      }: ${activePosition.entryPrice.toFixed(2)}\n` +
      `🎯 Тейк-профит: ${takeProfit.toFixed(1)}${
        candleRange
          ? ` (Диапазон сигнальной: ${candleRange.toFixed(4)}, ${
              candleRange < 3 ? "узкий флет" : "нормальное движение"
            })`
          : ""
      }\n` +
      `🛑 Стоп-лосс: ${stopLoss.toFixed(1)}\n` +
      `💰 Размер позиции: $${tradeSize.toFixed(2)} (${contractSize} SOL)\n` +
      `📈 Потенциальная прибыль: $${(
        (Math.abs(takeProfit - activePosition.entryPrice) /
          activePosition.entryPrice) *
        tradeSize
      ).toFixed(2)}\n` +
      `⚠️ Максимальный убыток: $${(
        (Math.abs(stopLoss - activePosition.entryPrice) /
          activePosition.entryPrice) *
        tradeSize
      ).toFixed(2)}` +
      clusterInfo +
      oiInfo
    );
  }

  public formatTradeCloseAlert(
    activePosition: ActivePosition,
    closePrice: number,
    reason: string,
    realPnL?: number,
    actualTradeSize?: number
  ): string {
    const profit =
      activePosition.side === "Buy"
        ? closePrice - activePosition.entryPrice
        : activePosition.entryPrice - closePrice;

    const profitPercent = (profit / activePosition.entryPrice) * 100;

    // Используем реальный P&L из биржи, если доступен, иначе рассчитываем
    const tradeSize = actualTradeSize || this.TRADE_SIZE_USD;
    const profitUSD =
      realPnL !== undefined
        ? realPnL
        : profit * (tradeSize / activePosition.entryPrice);

    // Расчет количества пунктов
    const points = Math.abs(closePrice - activePosition.entryPrice);

    // Время в сделке
    const timeInTrade = Date.now() - activePosition.entryTime;
    const hours = Math.floor(timeInTrade / (1000 * 60 * 60));
    const minutes = Math.floor((timeInTrade % (1000 * 60 * 60)) / (1000 * 60));
    const timeString = hours > 0 ? `${hours}ч ${minutes}м` : `${minutes}м`;

    // Эмодзи для результата
    const resultEmoji = profitUSD >= 0 ? "✅" : "❌";
    const profitEmoji = profitUSD >= 0 ? "💰" : "💸";
    const signPrefix = profitUSD >= 0 ? "+" : "";

    return (
      `${resultEmoji} ПОЗИЦИЯ ЗАКРЫТА ${this.SYMBOL}\n\n` +
      `${activePosition.side === "Buy" ? "📈 ЛОНГ" : "📉 ШОРТ"}\n` +
      `📅 Время в сделке: ${timeString}\n\n` +
      `${profitEmoji} РЕЗУЛЬТАТ:\n` +
      `💲 P&L: ${signPrefix}$${profitUSD.toFixed(2)}\n`
    );
  }

  public formatTrailingStopUpdate(
    newStopPrice: number,
    trailingDistance: number,
    currentPrice: number
  ): string {
    return `📈 Трейлинг-стоп передвинут: ${newStopPrice.toFixed(
      1
    )} (${trailingDistance} пунктов от цены ${currentPrice.toFixed(1)}) для ${
      this.SYMBOL
    }`;
  }

  public formatTrailingStopActivation(): string {
    return `🎯 Активация трейлинг-стопа! Отменяем тейк-профит для ${this.SYMBOL}.`;
  }

  public formatOrderPlacedAlert(
    activePosition: ActivePosition,
    takeProfit: number,
    stopLoss: number,
    signalCandle: Candle,
    currentCandle: Candle,
    orderPrice: number,
    actualTradeSize?: number
  ): string {
    const tradeSize = actualTradeSize || this.TRADE_SIZE_USD;
    const contractSize = (tradeSize / activePosition.entryPrice).toFixed(3);
    const stopLossLevel =
      activePosition.side === "Buy"
        ? Math.min(signalCandle.low, currentCandle.low)
        : Math.max(signalCandle.high, currentCandle.high);

    return (
      `📝 ЛИМИТНЫЙ ОРДЕР РАЗМЕЩЕН ${this.SYMBOL}\n\n` +
      `${activePosition.side === "Buy" ? "📈 ЛОНГ ОРДЕР" : "📉 ШОРТ ОРДЕР"}\n` +
      `💵 Цена ордера: ${orderPrice.toFixed(1)}\n` +
      `🎯 Планируемый ТП: ${takeProfit.toFixed(1)}\n` +
      `🛑 Планируемый СЛ: ${stopLoss.toFixed(1)}\n` +
      `💰 Размер: $${tradeSize.toFixed(2)} (${contractSize} BTC)\n` +
      `⏳ ОЖИДАЕМ ИСПОЛНЕНИЯ ОРДЕРА...`
    );
  }

  public formatOrderExecutedAlert(
    activePosition: ActivePosition,
    executionPrice: number,
    actualTradeSize?: number
  ): string {
    const tradeSize = actualTradeSize || this.TRADE_SIZE_USD;
    const contractSize = (tradeSize / executionPrice).toFixed(3);

    return (
      `✅ ОРДЕР ИСПОЛНЕН! ПОЗИЦИЯ ОТКРЫТА ${this.SYMBOL}\n\n` +
      `${activePosition.side === "Buy" ? "📈 ЛОНГ" : "📉 ШОРТ"}\n` +
      `💵 Цена исполнения: ${executionPrice.toFixed(1)}\n` +
      `💰 Размер позиции: $${tradeSize.toFixed(2)} (${contractSize} SOL)\n` +
      `🎯 Позиция активна, TP/SL будут установлены автоматически`
    );
  }
}
