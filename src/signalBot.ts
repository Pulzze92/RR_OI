import dotenv from "dotenv";
import { BinanceService } from "./services/binance";
import { TelegramService } from "./services/telegram";
import { logger } from "./utils/logger";
import { Candle } from "./services/binance.types";
import {
  TradingLogicService,
  TradingLogicCallbacks,
  TradingLogicOptions
} from "./services/tradingLogicService";
import { NotificationService } from "./services/notificationService";

dotenv.config();

type Side = "Buy" | "Sell";

interface ActiveTracker {
  id: string;
  side: Side;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  notionalUsd: number;
  quantityAsset: number;
  createdAt: number;
  resolved: boolean;
}

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BINANCE_TESTNET } = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
}

async function main() {
  const symbol = "SOLUSDT";
  const baseCapitalUsd = 3000; // капитал пользователя
  const leverage = 6; // плечо 1:6
  const notionalUsd = baseCapitalUsd * leverage; // размер позиции в долларах
  const volumeThreshold = 100000; // порог объема для сигнала
  const takeProfitPoints = 1.0; // TP = $1
  const stopLossPoints = 0.5; // SL = $0.5

  const telegram = new TelegramService(
    TELEGRAM_BOT_TOKEN as string,
    TELEGRAM_CHAT_ID as string
  );
  const binance = new BinanceService(
    process.env.BINANCE_API_KEY || "",
    process.env.BINANCE_API_SECRET || "",
    BINANCE_TESTNET === "true"
  );

  // Создаем экземпляр TradingLogicService, чтобы использовать 1-в-1 анализ кластеров и OI
  const callbacks: TradingLogicCallbacks = {
    onTradeOperation: async () => {},
    onSignalDetected: async () => {}
  };
  const options: TradingLogicOptions = {
    symbol,
    tradeSizeUsd: notionalUsd,
    takeProfitPoints: takeProfitPoints,
    stopLossPoints: stopLossPoints,
    trailingActivationPoints: 1,
    trailingDistance: 1.5,
    volumeThreshold: volumeThreshold,
    useTrailingStop: false,
    leverage
  };
  const analysisService = new TradingLogicService(
    binance.getClient(),
    new NotificationService(symbol, notionalUsd, stopLossPoints),
    callbacks,
    options
  );

  logger.info(
    `🚀 Сигнальный режим (без торговли) запущен: ${symbol}, капитал=$${baseCapitalUsd}, плечо=${leverage}x, TP=$${takeProfitPoints}, SL=$${stopLossPoints}`
  );

  // Состояние
  let candleHistory: Candle[] = [];
  let currentSignal: { candle: Candle } | null = null;
  let latestTradePrice = 0;
  const trackers: ActiveTracker[] = [];

  // Исторические данные для разгона
  const initial = await binance.getHistoricalCandles(symbol, "1h" as any, 5);
  candleHistory = initial.slice(-5);

  // Стрим сделок для фиксации цены входа и отслеживания TP/SL
  try {
    binance.startTradesWebSocket(symbol, trade => {
      const price = parseFloat(trade.price);
      if (!Number.isFinite(price)) return;
      latestTradePrice = price;

      // Проверяем активные трекеры на первое касание TP/SL
      for (const tr of trackers) {
        if (tr.resolved) continue;

        if (tr.side === "Buy") {
          if (price >= tr.tpPrice) {
            resolveTracker(tr, price, telegram);
          } else if (price <= tr.slPrice) {
            resolveTracker(tr, price, telegram);
          }
        } else {
          if (price <= tr.tpPrice) {
            resolveTracker(tr, price, telegram);
          } else if (price >= tr.slPrice) {
            resolveTracker(tr, price, telegram);
          }
        }
      }
    });
  } catch (e) {
    logger.warn(
      "⚠️ Не удалось запустить поток сделок, отслеживание TP/SL может быть неточным",
      e
    );
  }

  // WebSocket свечей (1h), детекция сигнала и подтверждения
  await binance.startWebSocket(symbol, async (candle: Candle) => {
    try {
      if (!candle.confirmed) return;

      // Добавляем свечу в историю и ограничиваем размер
      candleHistory.push(candle);
      if (candleHistory.length > 6) candleHistory = candleHistory.slice(-6);

      const prev = findPreviousConfirmed(candleHistory, candle.timestamp);
      if (!prev) return;

      // Если уже есть активный сигнальный бар — ждем подтверждения (объем ниже)
      if (currentSignal) {
        if (candle.volume < currentSignal.candle.volume) {
          // Подтверждение получено — формируем направление и создаем трекер
          const signalCandle = currentSignal.candle;
          // Определяем направление 1-в-1 по логике TradingLogicService (кластеры + OI)
          let side: Side = signalCandle.isGreen ? "Buy" : "Sell";
          try {
            const clusterAnalysis = await analysisService.analyzeVolumeClusters(
              signalCandle,
              prev
            );
            try {
              const oiZones = await analysisService.analyzeOpenInterestZones(
                signalCandle
              );
              if (oiZones) {
                const comparedZone =
                  clusterAnalysis.upperClusterVolume >=
                  clusterAnalysis.lowerClusterVolume
                    ? "upper"
                    : "lower";
                const zoneDelta =
                  comparedZone === "upper"
                    ? oiZones.upperDelta
                    : oiZones.lowerDelta;
                side =
                  comparedZone === "lower"
                    ? zoneDelta < 0
                      ? "Buy"
                      : "Sell"
                    : zoneDelta < 0
                    ? "Sell"
                    : "Buy";
              }
            } catch (e) {
              // Если OI недоступен — остаемся на базовом направлении по цвету свечи
            }
          } catch (e) {
            // Если кластеры недоступны — остаемся на базовом направлении по цвету свечи
          }

          const entry = latestTradePrice > 0 ? latestTradePrice : candle.close;
          const { tp, sl } = calcTpSl(
            entry,
            side,
            takeProfitPoints,
            stopLossPoints
          );
          const qty = notionalUsd / entry;

          const tracker: ActiveTracker = {
            id: `${signalCandle.timestamp}`,
            side,
            entryPrice: entry,
            tpPrice: tp,
            slPrice: sl,
            notionalUsd,
            quantityAsset: qty,
            createdAt: Date.now(),
            resolved: false
          };
          trackers.push(tracker);

          // Отправляем сигнал в Telegram
          // Подготовим расширенную информацию (кластеры и OI) для сообщения
          let clusterInfo = "";
          let oiInfo = "";
          try {
            const clusterAnalysis = await analysisService.analyzeVolumeClusters(
              signalCandle,
              prev
            );
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
            clusterInfo = `\n📊 КЛАСТЕРЫ: Верх ${upperPercent}% | Сред ${middlePercent}% | Низ ${lowerPercent}%`;
            try {
              const oiZones = await analysisService.analyzeOpenInterestZones(
                signalCandle
              );
              if (oiZones) {
                const comparedZone =
                  clusterAnalysis.upperClusterVolume >=
                  clusterAnalysis.lowerClusterVolume
                    ? "upper"
                    : "lower";
                const zoneDelta =
                  comparedZone === "upper"
                    ? oiZones.upperDelta
                    : oiZones.lowerDelta;
                const oiTrend = zoneDelta >= 0 ? "рост" : "падение";
                oiInfo = `\n📈 OI(5м/час): low=${oiZones.lowerDelta.toFixed(
                  2
                )} | mid=${oiZones.middleDelta.toFixed(
                  2
                )} | up=${oiZones.upperDelta.toFixed(
                  2
                )} → зона=${comparedZone}, в зоне ${oiTrend}`;
              }
            } catch (e) {}
          } catch (e) {}

          await telegram.sendMessage(
            formatSignalMessage({
              symbol,
              side,
              entry,
              tp,
              sl,
              baseCapitalUsd,
              leverage,
              notionalUsd
            }) +
              clusterInfo +
              oiInfo
          );

          logger.info(
            `🎯 Сигнал: ${side} @ ${entry.toFixed(3)} | TP ${tp.toFixed(
              3
            )} | SL ${sl.toFixed(3)} | notional $${notionalUsd}`
          );

          // Сбрасываем текущий сигнал — он отработан
          currentSignal = null;
          return;
        }
        // Если подтверждение не пришло – просто продолжаем ждать
      }

      // Иначе ищем новый сигнальный бар: объем > порога и > предыдущей свечи
      if (candle.volume > volumeThreshold && candle.volume > prev.volume) {
        currentSignal = { candle };
        logger.info(
          `📢 Обнаружен сигнальный бар: ${new Date(
            candle.timestamp
          ).toLocaleString()} V=${candle.volume.toFixed(
            2
          )} (порог=${volumeThreshold})`
        );
      }
    } catch (error) {
      logger.error("Ошибка в обработчике свечей сигнального режима:", error);
    }
  });
}

function findPreviousConfirmed(history: Candle[], ts: number): Candle | null {
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].timestamp < ts && history[i].confirmed) return history[i];
  }
  return null;
}

function calcTpSl(entry: number, side: Side, tpPts: number, slPts: number) {
  if (side === "Buy") {
    return { tp: entry + tpPts, sl: entry - slPts };
  }
  return { tp: entry - tpPts, sl: entry + slPts };
}

function resolveTracker(
  tr: ActiveTracker,
  exitPrice: number,
  telegram: TelegramService
) {
  if (tr.resolved) return;
  tr.resolved = true;

  const delta =
    tr.side === "Buy" ? exitPrice - tr.entryPrice : tr.entryPrice - exitPrice;
  const pnlUsd = delta * tr.quantityAsset; // линейный контракт USDT
  const result = pnlUsd >= 0 ? "✅ TP" : "❌ SL";

  telegram
    .sendMessage(
      formatResolutionMessage({
        symbol: "SOLUSDT",
        side: tr.side,
        entry: tr.entryPrice,
        exit: exitPrice,
        delta,
        notionalUsd: tr.notionalUsd,
        qty: tr.quantityAsset,
        pnlUsd
      })
    )
    .catch(err =>
      logger.error("Не удалось отправить результат сигнала в Telegram:", err)
    );

  logger.info(
    `${result} ${tr.side} | entry ${tr.entryPrice.toFixed(
      3
    )} → exit ${exitPrice.toFixed(3)} | PnL $${pnlUsd.toFixed(2)}`
  );
}

function formatSignalMessage(args: {
  symbol: string;
  side: Side;
  entry: number;
  tp: number;
  sl: number;
  baseCapitalUsd: number;
  leverage: number;
  notionalUsd: number;
}): string {
  const dir = args.side === "Buy" ? "ЛОНГ" : "ШОРТ";
  return (
    `📢 СИГНАЛ (симуляция) ${args.symbol}\n\n` +
    `Направление: ${dir}\n` +
    `Точка входа: ${args.entry.toFixed(3)}\n` +
    `TP: ${args.tp.toFixed(3)} (+$1.0)\n` +
    `SL: ${args.sl.toFixed(3)} (-$0.5)\n\n` +
    `Капитал: $${args.baseCapitalUsd} | Плечо: ${args.leverage}x\n` +
    `Нотионал: $${args.notionalUsd}`
  );
}

function formatResolutionMessage(args: {
  symbol: string;
  side: Side;
  entry: number;
  exit: number;
  delta: number;
  notionalUsd: number;
  qty: number;
  pnlUsd: number;
}): string {
  const dir = args.side === "Buy" ? "ЛОНГ" : "ШОРТ";
  const outcome = args.pnlUsd >= 0 ? "✅ TP" : "❌ SL";
  const sign = args.pnlUsd >= 0 ? "+" : "";
  return (
    `${outcome} ${args.symbol}\n\n` +
    `${dir}\n` +
    `Вход: ${args.entry.toFixed(3)}\n` +
    `Выход: ${args.exit.toFixed(3)}\n` +
    `Δ: ${args.delta >= 0 ? "+" : ""}${args.delta.toFixed(3)}\n\n` +
    `Нотионал: $${args.notionalUsd} | Кол-во: ${args.qty.toFixed(4)}\n` +
    `Результат: ${sign}$${args.pnlUsd.toFixed(2)}`
  );
}

main().catch(e => {
  logger.error("Сигнальный бот завершился с ошибкой:", e);
  process.exit(1);
});
