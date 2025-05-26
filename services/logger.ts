import winston from "winston";
import "winston-daily-rotate-file";
import path from "path";
import fs from "fs";

const LOG_DIR = "logs";

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR);
}

const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: "YYYY-MM-DD HH:mm:ss"
  }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: "info",
  format: logFormat,
  defaultMeta: { service: "vsa-bot" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({
          format: "YYYY-MM-DDTHH:mm:ss"
        }),
        winston.format.printf(
          info => `${info.timestamp}: ${info.level}: ${info.message}`
        )
      )
    })
  ]
});
