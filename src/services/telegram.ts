import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../utils/logger';

export class TelegramService {
    private bot: TelegramBot;
    private chatId: string;
    private onRestartCallback?: () => Promise<void>;

    constructor(token: string, chatId: string) {
        this.chatId = chatId;
        this.bot = new TelegramBot(token, { polling: true });
        this.setupCommandHandlers();
    }

    private setupCommandHandlers(): void {
        // Обработчик команды /restart
        this.bot.onText(/\/restart/, async (msg) => {
            const chatId = msg.chat.id.toString();
            
            // Проверяем, что команда пришла из авторизованного чата
            if (chatId !== this.chatId) {
                logger.warn(`⚠️ Попытка использования команды /restart из неавторизованного чата: ${chatId}`);
                return;
            }

            logger.info(`🔄 Получена команда /restart от пользователя: ${msg.from?.first_name || 'Unknown'}`);
            
            try {
                await this.bot.sendMessage(chatId, '🔄 Перезапуск бота...');
                
                if (this.onRestartCallback) {
                    await this.onRestartCallback();
                    await this.bot.sendMessage(chatId, '✅ Бот успешно перезапущен!');
                } else {
                    await this.bot.sendMessage(chatId, '❌ Ошибка: callback для перезапуска не установлен');
                }
            } catch (error) {
                logger.error('❌ Ошибка при выполнении команды /restart:', error);
                await this.bot.sendMessage(chatId, '❌ Ошибка при перезапуске бота');
            }
        });

        // Обработчик команды /status
        this.bot.onText(/\/status/, async (msg) => {
            const chatId = msg.chat.id.toString();
            
            if (chatId !== this.chatId) {
                return;
            }

            try {
                await this.bot.sendMessage(chatId, '🤖 Бот работает нормально\n\nДоступные команды:\n/restart - Перезапустить бота\n/status - Проверить статус');
            } catch (error) {
                logger.error('❌ Ошибка при выполнении команды /status:', error);
            }
        });

        logger.info('📱 Telegram команды настроены: /restart, /status');
    }

    public setRestartCallback(callback: () => Promise<void>): void {
        this.onRestartCallback = callback;
    }

    public async sendMessage(message: string): Promise<void> {
        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
            logger.info('Message sent to Telegram');
        } catch (error) {
            logger.error('Failed to send message to Telegram:', error);
        }
    }
} 