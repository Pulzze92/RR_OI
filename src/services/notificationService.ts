import { Candle, ActivePosition } from "./bybit.types";
import { OrderSideV5 } from "bybit-api";

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
    isLimitOrder: boolean = false,
    side: "Buy" | "Sell"
  ): string {
    const contractSize = (
      this.TRADE_SIZE_USD / activePosition.entryPrice
    ).toFixed(3);
    const stopLossLevel =
      activePosition.side === "Buy"
        ? Math.min(signalCandle.low, currentCandle.low)
        : Math.max(signalCandle.high, currentCandle.high);

    return (
      `🎯 ${
        isLimitOrder ? "ЛИМИТНЫЙ ОРДЕР РАЗМЕЩЕН" : "ОТКРЫТА НОВАЯ СДЕЛКА"
      } ${this.SYMBOL}\n\n` +
      `${activePosition.side === "Buy" ? "📈 ЛОНГ" : "📉 ШОРТ"}\n` +
      `🆔 Order ID: ${activePosition.orderId}\n` +
      `💵 ${isLimitOrder ? "Цена ордера" : "Цена входа"}: ${
        activePosition.entryPrice
      }\n` +
      `🎯 Тейк-профит: ${takeProfit.toFixed(1)}\n` +
      `🛑 Стоп-лосс: ${stopLoss.toFixed(1)}\n` +
      `📊 Расчет стопа:\n` +
      `  • Сигнальная свеча (${signalCandle.isGreen ? "🟢" : "🔴"}): ${
        signalCandle.isGreen
          ? `High=${signalCandle.high}`
          : `Low=${signalCandle.low}`
      }\n` +
      `  • Текущая свеча: ${
        signalCandle.isGreen
          ? `High=${currentCandle.high}`
          : `Low=${currentCandle.low}`
      }\n` +
      `  • Выбран ${
        activePosition.side === "Buy" ? "минимум" : "максимум"
      }: ${stopLossLevel}\n` +
      `  • Стоп: ${Math.abs(this.STOP_LOSS_POINTS)} пунктов ${
        activePosition.side === "Buy" ? "ниже" : "выше"
      }\n` +
      `💰 Размер позиции: $${this.TRADE_SIZE_USD} (${contractSize} BTC)\n` +
      `📈 Потенциальная прибыль: $${(
        (Math.abs(takeProfit - activePosition.entryPrice) /
          activePosition.entryPrice) *
        this.TRADE_SIZE_USD
      ).toFixed(2)}\n` +
      `⚠️ Максимальный убыток: $${(
        (Math.abs(stopLoss - activePosition.entryPrice) /
          activePosition.entryPrice) *
        this.TRADE_SIZE_USD
      ).toFixed(2)}`
    );
  }

  public formatTradeCloseAlert(
    activePosition: ActivePosition,
    closePrice: number,
    reason: string
  ): string {
    const profit =
      activePosition.side === "Buy"
        ? closePrice - activePosition.entryPrice
        : activePosition.entryPrice - closePrice;

    const profitPercent = (profit / activePosition.entryPrice) * 100;
    const profitUSD =
      (profit / activePosition.entryPrice) * this.TRADE_SIZE_USD;

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
      `🆔 Order ID: ${activePosition.orderId || "N/A"}\n` +
      `📅 Время в сделке: ${timeString}\n\n` +
      `💵 Цена входа: ${activePosition.entryPrice.toFixed(1)}\n` +
      `💰 Цена выхода: ${closePrice.toFixed(1)}\n` +
      `📏 Пунктов взято: ${points.toFixed(1)}\n\n` +
      `${profitEmoji} РЕЗУЛЬТАТ:\n` +
      `💲 P&L: ${signPrefix}$${profitUSD.toFixed(2)}\n` +
      `📊 Процент: ${signPrefix}${profitPercent.toFixed(2)}%\n\n` +
      `⚠️ Причина: ${reason}`
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
    orderPrice: number
  ): string {
    const contractSize = (
      this.TRADE_SIZE_USD / activePosition.entryPrice
    ).toFixed(3);
    const stopLossLevel =
      activePosition.side === "Buy"
        ? Math.min(signalCandle.low, currentCandle.low)
        : Math.max(signalCandle.high, currentCandle.high);

    return (
      `📝 ЛИМИТНЫЙ ОРДЕР РАЗМЕЩЕН ${this.SYMBOL}\n\n` +
      `${activePosition.side === "Buy" ? "📈 ЛОНГ ОРДЕР" : "📉 ШОРТ ОРДЕР"}\n` +
      `🆔 Order ID: ${activePosition.orderId}\n` +
      `💵 Цена ордера: ${orderPrice.toFixed(1)}\n` +
      `🎯 Планируемый ТП: ${takeProfit.toFixed(1)}\n` +
      `🛑 Планируемый СЛ: ${stopLoss.toFixed(1)}\n` +
      `📊 Расчет стопа:\n` +
      `  • Сигнальная свеча (${signalCandle.isGreen ? "🟢" : "🔴"}): ${
        signalCandle.isGreen
          ? `High=${signalCandle.high}`
          : `Low=${signalCandle.low}`
      }\n` +
      `  • Текущая свеча: ${
        signalCandle.isGreen
          ? `High=${currentCandle.high}`
          : `Low=${currentCandle.low}`
      }\n` +
      `  • Выбран ${
        activePosition.side === "Buy" ? "минимум" : "максимум"
      }: ${stopLossLevel}\n` +
      `  • Стоп: ${Math.abs(this.STOP_LOSS_POINTS)} пунктов ${
        activePosition.side === "Buy" ? "ниже" : "выше"
      }\n` +
      `💰 Размер: $${this.TRADE_SIZE_USD} (${contractSize} BTC)\n` +
      `⏳ ОЖИДАЕМ ИСПОЛНЕНИЯ ОРДЕРА...`
    );
  }

  public formatOrderExecutedAlert(
    activePosition: ActivePosition,
    executionPrice: number
  ): string {
    const contractSize = (this.TRADE_SIZE_USD / executionPrice).toFixed(3);

    return (
      `✅ ОРДЕР ИСПОЛНЕН! ПОЗИЦИЯ ОТКРЫТА ${this.SYMBOL}\n\n` +
      `${activePosition.side === "Buy" ? "📈 ЛОНГ" : "📉 ШОРТ"}\n` +
      `🆔 Order ID: ${activePosition.orderId}\n` +
      `💵 Цена исполнения: ${executionPrice.toFixed(1)}\n` +
      `💰 Размер позиции: $${this.TRADE_SIZE_USD} (${contractSize} BTC)\n` +
      `🎯 Позиция активна, TP/SL будут установлены автоматически`
    );
  }
}
