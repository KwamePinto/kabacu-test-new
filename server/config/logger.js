const path    = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const LOG_DIR = path.join(__dirname, '../../log');

// ── Rotation settings ────────────────────────────────────────────────────────
// Each file rotates daily, is capped at 20 MB, and is compressed once closed.
// Only the last 30 days of files are kept — anything older is deleted automatically.
const rotateOptions = (filename) => ({
  dirname:       LOG_DIR,
  filename:      `${filename}-%DATE%.log`,
  datePattern:   'YYYY-MM-DD',
  zippedArchive: true,
  maxSize:       '20m',
  maxFiles:      '30d',
  auditFile:     path.join(LOG_DIR, `.${filename}-audit.json`),
});

const { combine, timestamp, printf, colorize, errors, splat } = winston.format;

const logLine = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level.toUpperCase()}] ${stack || message}`;
});

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    splat(),
    logLine,
  ),
  transports: [
    // All logs (info and above) → combined.log
    new winston.transports.DailyRotateFile({
      ...rotateOptions('combined'),
      level: 'info',
    }),
    // Errors only → error.log
    new winston.transports.DailyRotateFile({
      ...rotateOptions('error'),
      level: 'error',
    }),
  ],
});

// In development also print coloured output to the console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: combine(
      colorize(),
      timestamp({ format: 'HH:mm:ss' }),
      errors({ stack: true }),
      splat(),
      logLine,
    ),
  }));
}

module.exports = logger;
