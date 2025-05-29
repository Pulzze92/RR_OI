import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../utils/logger';

export class TelegramService {
    private bot: TelegramBot;
    private chatId: string;

    constructor(token: string, chatId: string) {
        this.chatId = chatId;
        this.bot = new TelegramBot(token, { polling: false });
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