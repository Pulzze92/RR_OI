import dotenv from 'dotenv';
import { BybitService } from './services/bybit';
import { TelegramService } from './services/telegram';
import { logger } from './utils/logger';

dotenv.config();

const {
    BYBIT_API_KEY,
    BYBIT_API_SECRET,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    VOLUME_MULTIPLIER
} = process.env;

if (!BYBIT_API_KEY || !BYBIT_API_SECRET || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('Missing required environment variables');
}

async function main() {
    try {
        const volumeMultiplier = Number(VOLUME_MULTIPLIER) || 4;
        
        const bybitService = new BybitService(
            BYBIT_API_KEY as string,
            BYBIT_API_SECRET as string,
            volumeMultiplier
        );

        const telegramService = new TelegramService(
            TELEGRAM_BOT_TOKEN as string,
            TELEGRAM_CHAT_ID as string
        );

        // Подключаем обработчики событий
        bybitService.onVolumeSpike = async (message: string) => {
            await telegramService.sendMessage(message);
            logger.info('Volume spike detected and notification sent');
        };

        bybitService.onTradeOpen = async (message: string) => {
            await telegramService.sendMessage(message);
            logger.info('Trade opened and notification sent');
        };

        // Подписываемся на BTCUSDT
        await bybitService.subscribeToSymbol();
        
        logger.info('Bot started successfully');

        // Держим процесс активным
        process.on('SIGINT', async () => {
            logger.info('Shutting down...');
            process.exit(0);
        });
    } catch (error) {
        logger.error('Failed to start bot:', error);
        process.exit(1);
    }
}

main(); 