/**
 * 日志工具类
 * 统一的日志管理，支持不同级别和输出格式
 */

import * as fs from 'fs'
import * as path from 'path'
import { ServerConfig } from '../types/index.js'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export interface LogEntry {
    level: LogLevel
    message: string
    timestamp: string
    context?: Record<string, any>
    error?: Error
}

export class Logger {
    private static instances = new Map<string, Logger>()
    private logLevel: LogLevel
    private logDir: string
    private maxFileSize: number
    private maxFiles: number

    private constructor(
        private name: string,
        config?: {
            level?: LogLevel
            logDir?: string
            maxFileSize?: number
            maxFiles?: number
        }
    ) {
        this.logLevel = config?.level || 'info'
        this.logDir = config?.logDir || 'logs'
        this.maxFileSize = config?.maxFileSize || 10 * 1024 * 1024 // 10MB
        this.maxFiles = config?.maxFiles || 10

        // 确保日志目录存在
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true })
        }
    }

    /**
     * 获取日志器实例（单例模式）
     */
    public static getInstance(name: string, config?: any): Logger {
        if (!Logger.instances.has(name)) {
            Logger.instances.set(name, new Logger(name, config))
        }
        return Logger.instances.get(name)!
    }

    /**
     * 从配置创建日志器
     */
    public static fromConfig(name: string, config: ServerConfig): Logger {
        return Logger.getInstance(name, {
            level: config.logging.level as LogLevel,
            maxFileSize: config.logging.maxFileSize,
            maxFiles: config.logging.maxFiles
        })
    }

    /**
     * 记录日志
     */
    private log(level: LogLevel, message: string, context?: Record<string, any>, error?: Error): void {
        const levels: Record<LogLevel, number> = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3
        }

        if (levels[level] > levels[this.logLevel]) {
            return
        }

        const entry: LogEntry = {
            level,
            message,
            timestamp: new Date().toISOString(),
            context,
            error
        }

        // 控制台输出
        this.logToConsole(entry)

        // 文件输出
        this.logToFile(entry)
    }

    /**
     * 控制台输出
     */
    private logToConsole(entry: LogEntry): void {
        const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${this.name}]`
        const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : ''
        const errorStr = entry.error ? `\n${entry.error.stack}` : ''

        console.log(`${prefix} ${entry.message}${contextStr}${errorStr}`)
    }

    /**
     * 文件输出
     */
    private logToFile(entry: LogEntry): void {
        const logFile = path.join(this.logDir, `${this.name}.log`)
        const combinedFile = path.join(this.logDir, 'combined.log')
        const errorFile = path.join(this.logDir, 'error.log')

        const logLine = JSON.stringify(entry) + '\n'

        try {
            // 写入模块日志
            fs.appendFileSync(logFile, logLine)

            // 写入综合日志
            fs.appendFileSync(combinedFile, logLine)

            // 错误日志单独记录
            if (entry.level === 'error') {
                fs.appendFileSync(errorFile, logLine)
            }

            // 检查文件大小，必要时轮转
            this.rotateLogFile(logFile)
            this.rotateLogFile(combinedFile)
            this.rotateLogFile(errorFile)
        } catch (error) {
            console.error('写入日志文件失败:', error)
        }
    }

    /**
     * 日志文件轮转
     */
    private rotateLogFile(filePath: string): void {
        try {
            const stats = fs.statSync(filePath)
            if (stats.size > this.maxFileSize) {
                // 重命名现有文件
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
                const rotatedFile = `${filePath}.${timestamp}`
                fs.renameSync(filePath, rotatedFile)

                // 清理旧文件
                this.cleanOldLogs(path.dirname(filePath))
            }
        } catch (error) {
            // 文件不存在或其他错误，忽略
        }
    }

    /**
     * 清理旧日志文件
     */
    private cleanOldLogs(logDir: string): void {
        try {
            const files = fs.readdirSync(logDir)
            const logFiles = files
                .filter(file => file.startsWith(path.basename(logDir)) && file.includes('.'))
                .map(file => ({
                    name: file,
                    path: path.join(logDir, file),
                    mtime: fs.statSync(path.join(logDir, file)).mtime
                }))
                .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

            // 删除超出数量限制的文件
            if (logFiles.length > this.maxFiles) {
                const filesToDelete = logFiles.slice(this.maxFiles)
                filesToDelete.forEach(file => {
                    try {
                        fs.unlinkSync(file.path)
                    } catch (error) {
                        // 忽略删除失败
                    }
                })
            }
        } catch (error) {
            // 忽略清理错误
        }
    }

    /**
     * 错误日志
     */
    public error(message: string, error?: Error, context?: Record<string, any>): void {
        this.log('error', message, context, error)
    }

    /**
     * 警告日志
     */
    public warn(message: string, context?: Record<string, any>): void {
        this.log('warn', message, context)
    }

    /**
     * 信息日志
     */
    public info(message: string, context?: Record<string, any>): void {
        this.log('info', message, context)
    }

    /**
     * 调试日志
     */
    public debug(message: string, context?: Record<string, any>): void {
        this.log('debug', message, context)
    }

    /**
     * 更新日志级别
     */
    public setLevel(level: LogLevel): void {
        this.logLevel = level
    }

    /**
     * 销毁日志器
     */
    public destroy(): void {
        Logger.instances.delete(this.name)
    }
}

/**
 * 创建日志器的便捷函数
 */
export function createLogger(name: string, config?: any): Logger {
    return Logger.getInstance(name, config)
}

/**
 * 从配置创建日志器
 */
export function createLoggerFromConfig(name: string, config: ServerConfig): Logger {
    return Logger.fromConfig(name, config)
}
