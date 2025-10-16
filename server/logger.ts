/**
 * 统一日志系统
 * 基于 winston 实现结构化日志、日志级别控制和自动轮转
 */

import winston from 'winston'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * 日志级别枚举
 */
export enum LogLevel {
    ERROR = 'error',
    WARN = 'warn',
    INFO = 'info',
    DEBUG = 'debug'
}

/**
 * 日志元数据接口
 */
export interface LogMeta {
    [key: string]: any
}

/**
 * Logger 类
 * 提供统一的日志记录接口
 */
export class Logger {
    private logger: winston.Logger
    private serviceName: string

    /**
     * 构造函数
     * @param serviceName 服务名称（用于区分不同模块的日志）
     */
    constructor(serviceName: string) {
        this.serviceName = serviceName

        // 获取日志级别（从环境变量或默认 info）
        const logLevel = process.env.LOG_LEVEL || LogLevel.INFO

        // 日志目录
        const logDir = path.join(__dirname, '../logs')

        // 创建 Winston Logger
        this.logger = winston.createLogger({
            level: logLevel,
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.errors({ stack: true }),
                winston.format.splat(),
                winston.format.json()
            ),
            defaultMeta: { service: serviceName },
            transports: [
                // 错误日志文件（只记录 error 级别）
                new winston.transports.File({
                    filename: path.join(logDir, 'error.log'),
                    level: 'error',
                    maxsize: 10485760, // 10MB
                    maxFiles: 5,
                    format: winston.format.combine(
                        winston.format.timestamp(),
                        winston.format.json()
                    )
                }),

                // 综合日志文件（记录所有级别）
                new winston.transports.File({
                    filename: path.join(logDir, 'combined.log'),
                    maxsize: 10485760, // 10MB
                    maxFiles: 10,
                    format: winston.format.combine(
                        winston.format.timestamp(),
                        winston.format.json()
                    )
                }),

                // 控制台输出（带颜色和简化格式）
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.timestamp({ format: 'HH:mm:ss' }),
                        winston.format.printf((info: any) => {
                            const { timestamp, level, message, service, ...meta } = info

                            // 构建基础日志行
                            let log = `${timestamp} [${service}] ${level}: ${message}`

                            // 如果有额外的元数据，附加到日志后面
                            const metaKeys = Object.keys(meta)
                            if (metaKeys.length > 0) {
                                const metaStr = JSON.stringify(meta)
                                log += ` ${metaStr}`
                            }

                            return log
                        })
                    )
                })
            ]
        })
    }

    /**
     * 记录 INFO 级别日志
     */
    public info(message: string, meta?: LogMeta): void {
        this.logger.info(message, meta)
    }

    /**
     * 记录 WARN 级别日志
     */
    public warn(message: string, meta?: LogMeta): void {
        this.logger.warn(message, meta)
    }

    /**
     * 记录 ERROR 级别日志
     */
    public error(message: string, error?: Error | string, meta?: LogMeta): void {
        if (error instanceof Error) {
            this.logger.error(message, {
                error: {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                },
                ...meta
            })
        } else if (typeof error === 'string') {
            this.logger.error(message, { errorMessage: error, ...meta })
        } else {
            this.logger.error(message, meta)
        }
    }

    /**
     * 记录 DEBUG 级别日志
     */
    public debug(message: string, meta?: LogMeta): void {
        this.logger.debug(message, meta)
    }

    /**
     * 获取底层 Winston Logger（用于高级用法）
     */
    public getWinstonLogger(): winston.Logger {
        return this.logger
    }
}

/**
 * 创建 Logger 实例的工厂函数
 */
export function createLogger(serviceName: string): Logger {
    return new Logger(serviceName)
}

