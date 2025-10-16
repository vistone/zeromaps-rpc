/**
 * 配置管理器
 * 支持多层配置、热加载、Web界面管理
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { EventEmitter } from 'events'
import { createLogger } from './logger.js'

const logger = createLogger('ConfigManager')

/**
 * 服务器配置接口
 */
export interface ServerConfig {
    server: {
        name: string
        domain: string
        rpc: {
            port: number
            timeout: number
        }
        monitor: {
            port: number
            statsInterval: number
        }
        webhook: {
            port: number
            secret: string
            updateScript: string
            forwardToOtherNodes: boolean
        }
    }
    utls: {
        proxyPort: number
        concurrency: number
        timeout: number
    }
    ipv6: {
        prefix: string
        start: number
        count: number
        healthCheck: {
            failureRateThreshold: number
            responseTimeThreshold: number
            minRequestsBeforeCheck: number
        }
    }
    logging: {
        level: string
        maxFileSize: number
        maxFiles: number
    }
    performance: {
        maxRequestLogs: number
        healthCheckInterval: number
    }
}

/**
 * 配置管理器类
 */
export class ConfigManager extends EventEmitter {
    private config: ServerConfig
    private configPath: string
    private nodeConfigPath: string
    private watchers: fs.FSWatcher[] = []  // 修复：使用数组保存所有 watcher
    private static instance: ConfigManager | null = null

    private constructor() {
        super()

        // 确定配置文件路径
        const configDir = path.join(process.cwd(), 'config')
        this.configPath = path.join(configDir, 'default.json')

        // 节点特定配置（基于主机名）
        const hostname = os.hostname()
        this.nodeConfigPath = path.join(configDir, `node-${hostname}.json`)

        // 加载配置
        this.config = this.loadConfig()

        logger.info('配置管理器初始化', {
            hostname,
            defaultConfig: this.configPath,
            nodeConfig: fs.existsSync(this.nodeConfigPath) ? this.nodeConfigPath : 'none'
        })

        // 启动配置文件监听（热加载）
        this.watchConfig()
    }

    /**
     * 获取单例实例
     */
    public static getInstance(): ConfigManager {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager()
        }
        return ConfigManager.instance
    }

    /**
     * 加载配置文件（支持多层合并）
     */
    private loadConfig(): ServerConfig {
        try {
            // 1. 检查默认配置文件是否存在
            if (!fs.existsSync(this.configPath)) {
                throw new Error(`默认配置文件不存在: ${this.configPath}`)
            }

            // 2. 加载默认配置
            const configContent = fs.readFileSync(this.configPath, 'utf-8')
            let config: ServerConfig

            try {
                config = JSON.parse(configContent)
            } catch (parseError) {
                throw new Error(`默认配置文件 JSON 格式错误: ${(parseError as Error).message}`)
            }

            logger.debug('加载默认配置', { path: this.configPath })

            // 3. 如果存在节点特定配置，合并覆盖
            if (fs.existsSync(this.nodeConfigPath)) {
                try {
                    const nodeConfigContent = fs.readFileSync(this.nodeConfigPath, 'utf-8')
                    const nodeConfig = JSON.parse(nodeConfigContent)

                    logger.info('加载节点特定配置', { path: this.nodeConfigPath })

                    // 深度合并
                    config = this.deepMerge(config, nodeConfig)
                } catch (nodeError) {
                    logger.warn('节点配置文件加载失败，使用默认配置', {
                        error: (nodeError as Error).message
                    })
                }
            }

            // 4. 环境变量覆盖（最高优先级）
            this.applyEnvironmentOverrides(config)

            // 5. 验证配置
            this.validateConfig(config)

            return config
        } catch (error) {
            logger.error('加载配置失败', error as Error)
            throw error
        }
    }

    /**
     * 应用环境变量覆盖
     */
    private applyEnvironmentOverrides(config: ServerConfig): void {
        if (process.env.IPV6_PREFIX) {
            config.ipv6.prefix = process.env.IPV6_PREFIX
        }
        if (process.env.UTLS_PROXY_PORT) {
            config.utls.proxyPort = parseInt(process.env.UTLS_PROXY_PORT)
        }
        if (process.env.UTLS_CONCURRENCY) {
            config.utls.concurrency = parseInt(process.env.UTLS_CONCURRENCY)
        }
        if (process.env.WEBHOOK_SECRET) {
            config.server.webhook.secret = process.env.WEBHOOK_SECRET
        }
        if (process.env.LOG_LEVEL) {
            config.logging.level = process.env.LOG_LEVEL
        }

        if (Object.keys(process.env).some(key => key.startsWith('IPV6_') || key.startsWith('UTLS_') || key === 'WEBHOOK_SECRET' || key === 'LOG_LEVEL')) {
            logger.info('应用环境变量覆盖')
        }
    }

    /**
     * 深度合并对象
     */
    private deepMerge(target: any, source: any): any {
        const output = { ...target }

        for (const key in source) {
            const sourceValue = source[key]
            const targetValue = target[key]

            // 修复：正确处理 null、数组、对象
            if (sourceValue === null || sourceValue === undefined) {
                output[key] = sourceValue
            } else if (Array.isArray(sourceValue)) {
                // 数组直接覆盖，不进行深度合并
                output[key] = [...sourceValue]
            } else if (typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
                // 只有纯对象才深度合并
                if (key in target && typeof targetValue === 'object' && !Array.isArray(targetValue) && targetValue !== null) {
                    output[key] = this.deepMerge(targetValue, sourceValue)
                } else {
                    output[key] = sourceValue
                }
            } else {
                // 基本类型直接覆盖
                output[key] = sourceValue
            }
        }

        return output
    }

    /**
     * 验证配置
     */
    private validateConfig(config: ServerConfig): void {
        // 端口验证（修复：1024 是系统保留端口）
        const portMap = {
            'RPC端口': config.server.rpc.port,
            '监控端口': config.server.monitor.port,
            'Webhook端口': config.server.webhook.port,
            'uTLS代理端口': config.utls.proxyPort
        }

        for (const [name, port] of Object.entries(portMap)) {
            if (!Number.isInteger(port) || port <= 1024 || port > 65535) {
                throw new Error(`${name}无效: ${port}（必须在 1025-65535 之间）`)
            }
        }

        // 并发数验证
        if (!Number.isInteger(config.utls.concurrency) || config.utls.concurrency < 1 || config.utls.concurrency > 100) {
            throw new Error(`并发数无效: ${config.utls.concurrency}（必须在 1-100 之间）`)
        }

        // 超时验证
        if (config.utls.timeout < 1000 || config.utls.timeout > 60000) {
            throw new Error(`uTLS 超时无效: ${config.utls.timeout}（必须在 1000-60000ms 之间）`)
        }

        // IPv6 池验证
        if (!Number.isInteger(config.ipv6.count) || config.ipv6.count < 0 || config.ipv6.count > 1000) {
            throw new Error(`IPv6 池大小无效: ${config.ipv6.count}（必须在 0-1000 之间）`)
        }

        // IPv6 起始编号验证
        if (!Number.isInteger(config.ipv6.start) || config.ipv6.start < 1) {
            throw new Error(`IPv6 起始编号无效: ${config.ipv6.start}（必须 >= 1）`)
        }

        // 健康检查参数验证
        const hc = config.ipv6.healthCheck
        if (hc.failureRateThreshold < 0 || hc.failureRateThreshold > 1) {
            throw new Error(`失败率阈值无效: ${hc.failureRateThreshold}（必须在 0-1 之间）`)
        }
        if (hc.responseTimeThreshold < 100 || hc.responseTimeThreshold > 10000) {
            throw new Error(`响应时间阈值无效: ${hc.responseTimeThreshold}（必须在 100-10000ms 之间）`)
        }

        // 日志级别验证
        const validLogLevels = ['error', 'warn', 'info', 'debug']
        if (!validLogLevels.includes(config.logging.level)) {
            throw new Error(`日志级别无效: ${config.logging.level}（必须是 ${validLogLevels.join(', ')} 之一）`)
        }

        logger.debug('配置验证通过')
    }

    /**
     * 监听配置文件变化（热加载）
     */
    private watchConfig(): void {
        const filesToWatch = [this.configPath]
        if (fs.existsSync(this.nodeConfigPath)) {
            filesToWatch.push(this.nodeConfigPath)
        }

        // 修复：保存所有 watcher 到数组，避免资源泄漏
        for (const file of filesToWatch) {
            try {
                const watcher = fs.watch(file, (eventType) => {
                    if (eventType === 'change') {
                        logger.info('配置文件变化，重新加载', { file })

                        try {
                            const oldConfig = JSON.stringify(this.config)
                            this.config = this.loadConfig()
                            const newConfig = JSON.stringify(this.config)

                            if (oldConfig !== newConfig) {
                                logger.info('配置已更新')
                                this.emit('config-changed', this.config)
                            }
                        } catch (error) {
                            logger.error('重新加载配置失败', error as Error)
                        }
                    }
                })

                this.watchers.push(watcher)
            } catch (error) {
                logger.warn('无法监听配置文件', {
                    file,
                    error: (error as Error).message
                })
            }
        }

        logger.debug('配置文件监听已启动', { files: filesToWatch })
    }

    /**
     * 获取配置
     */
    public get<T = any>(path: string): T {
        const keys = path.split('.')
        let value: any = this.config

        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key]
            } else {
                throw new Error(`配置路径不存在: ${path}`)
            }
        }

        return value as T
    }

    /**
     * 获取配置（带默认值）
     */
    public getOrDefault<T = any>(path: string, defaultValue: T): T {
        try {
            return this.get<T>(path)
        } catch (error) {
            logger.warn('配置路径不存在，使用默认值', {
                path,
                defaultValue
            })
            return defaultValue
        }
    }

    /**
     * 设置配置（并保存到节点配置文件）
     */
    public async set(path: string, value: any): Promise<void> {
        const keys = path.split('.')

        // 更新内存中的配置
        let target: any = this.config
        for (let i = 0; i < keys.length - 1; i++) {
            if (!(keys[i] in target)) {
                target[keys[i]] = {}
            }
            target = target[keys[i]]
        }
        target[keys[keys.length - 1]] = value

        // 验证配置
        this.validateConfig(this.config)

        // 保存到节点配置文件
        await this.saveNodeConfig()

        logger.info('配置已更新', { path, value })
        this.emit('config-changed', this.config)
    }

    /**
     * 保存节点配置
     */
    private async saveNodeConfig(): Promise<void> {
        try {
            // 加载默认配置
            const defaultConfig: ServerConfig = JSON.parse(
                fs.readFileSync(this.configPath, 'utf-8')
            )

            // 计算差异（只保存与默认配置不同的部分）
            const diff = this.getDiff(defaultConfig, this.config)

            // 如果没有差异，删除节点配置文件
            if (Object.keys(diff).length === 0) {
                if (fs.existsSync(this.nodeConfigPath)) {
                    fs.unlinkSync(this.nodeConfigPath)
                    logger.debug('节点配置与默认配置相同，已删除节点配置文件')
                }
                return
            }

            // 保存到节点配置文件（添加说明注释）
            const configWithMeta = {
                '$schema': './schema.json',
                '_comment': `节点特定配置 - 主机名: ${os.hostname()}`,
                '_lastUpdated': new Date().toISOString(),
                ...diff
            }

            fs.writeFileSync(
                this.nodeConfigPath,
                JSON.stringify(configWithMeta, null, 2),
                'utf-8'
            )

            logger.debug('节点配置已保存', { path: this.nodeConfigPath })
        } catch (error) {
            logger.error('保存配置失败', error as Error)
            throw error
        }
    }

    /**
     * 计算两个配置的差异
     */
    private getDiff(base: any, current: any): any {
        const diff: any = {}

        // 跳过元数据字段
        const metaFields = ['$schema', '_comment', '_lastUpdated', 'comment']

        for (const key in current) {
            // 跳过元数据
            if (metaFields.includes(key)) {
                continue
            }

            if (!(key in base)) {
                // 新增的键
                diff[key] = current[key]
            } else if (typeof current[key] === 'object' && current[key] !== null && !Array.isArray(current[key])) {
                // 对象：递归比较
                const nestedDiff = this.getDiff(base[key], current[key])
                if (Object.keys(nestedDiff).length > 0) {
                    diff[key] = nestedDiff
                }
            } else if (current[key] !== base[key]) {
                // 值不同
                diff[key] = current[key]
            }
        }

        return diff
    }

    /**
     * 获取完整配置
     */
    public getAll(): ServerConfig {
        return JSON.parse(JSON.stringify(this.config))
    }

    /**
     * 重新加载配置
     */
    public reload(): void {
        logger.info('手动重新加载配置')
        const oldConfig = JSON.stringify(this.config)
        this.config = this.loadConfig()
        const newConfig = JSON.stringify(this.config)

        if (oldConfig !== newConfig) {
            logger.info('配置已更新')
            this.emit('config-changed', this.config)
        }
    }

    /**
     * 停止配置文件监听
     */
    public destroy(): void {
        // 修复：关闭所有 watcher
        for (const watcher of this.watchers) {
            try {
                watcher.close()
            } catch (error) {
                logger.warn('关闭 watcher 失败', {
                    error: (error as Error).message
                })
            }
        }
        this.watchers = []
        logger.debug('配置文件监听已停止')
    }
}

/**
 * 获取配置管理器实例（单例）
 */
export function getConfig(): ConfigManager {
    return ConfigManager.getInstance()
}

