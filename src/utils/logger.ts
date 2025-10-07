import winston from 'winston';

// Уровень логирования управляется переменными окружения
// LOG_LEVEL имеет приоритет, иначе если VOLUME_DEBUG=true → debug, по умолчанию info
const resolvedLevel = 'debug'; // Временно включаем debug для диагностики трейлинга

export const logger = winston.createLogger({
    level: resolvedLevel,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
}); 