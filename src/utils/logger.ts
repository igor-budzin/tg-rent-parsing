import winston from "winston";

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length
    ? `\n    L- Data: ${JSON.stringify(meta, null, 2)}`
    : "";
  return `[${timestamp}] [${level}] ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
        logFormat
      ),
    }),
  ],
});

// Convenience wrapper to match existing API
export function log(
  level: "INFO" | "DEBUG" | "WARN" | "ERROR",
  message: string,
  data?: Record<string, unknown>
): void {
  const winstonLevel = level.toLowerCase();
  if (data) {
    logger.log(winstonLevel, message, data);
  } else {
    logger.log(winstonLevel, message);
  }
}
