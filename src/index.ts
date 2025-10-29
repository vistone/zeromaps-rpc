/**
 * ZeroMaps RPC 主入口
 * 整合所有模块，提供统一的服务管理
 */

import { EventEmitter } from 'events'
import { createLogger } from '../server/logger.js'
import { ConfigManager, getConfig } from '../server/config-manager.js'
import { RpcServer } from '../server/rpc-server.js'
import { MonitorServer } from '../server/monitor-server.js'
import { NodeManager } from '../server/node-manager.js'
import { IPPoolSyncManager } from '../server/ip-pool-sync.js'

const logger = createLogger('ZeroMapsRPC')

export class ZeroMapsRPC extends EventEmitter {
    private configManager: ConfigManager
    private rpcServer: RpcServer
    private monitorServer: MonitorServer
    private nodeManager: NodeManager
    private ipPoolSyncManager: IPPoolSyncManager
    private isRunning = false

    constructor() {
        super()

        // 初始化配置管理器
        this.configManager = getConfig()

        // 获取配置（支持环境变量覆盖）
        const config = this.configManager.getAll()
        const rpcPort = parseInt(process.env.RPC_PORT || '') || config.server.rpc.port
        const monitorPort = parseInt(process.env.MONITOR_PORT || '') || config.server.monitor.port
        const ipv6Prefix = process.env.IPV6_PREFIX || config.ipv6.prefix

        // 初始化RPC服务器（使用既有实现，ipv6Count 从配置自动读取）
        this.rpcServer = new RpcServer(rpcPort, ipv6Prefix)

        // 初始化监控服务器（使用既有实现）
        this.monitorServer = new MonitorServer(monitorPort, this.rpcServer)

        // 初始化节点管理器
        this.nodeManager = new NodeManager()

        // 初始化IP池同步管理器
        this.ipPoolSyncManager = new IPPoolSyncManager()

        this.setupEventHandlers()
    }

    /**
     * 设置事件处理器
     */
    private setupEventHandlers(): void {
        // 监听配置变化（热更新）
        this.configManager.on('config-changed', (newConfig: any) => {
            logger.info('配置已更新，重新加载服务')
            // 通知 RpcServer 更新配置
            if (this.rpcServer && this.rpcServer.updateConfig) {
                this.rpcServer.updateConfig(newConfig)
            }
        })

        // 监听RPC服务器紧急停止事件
        this.rpcServer.on('emergency-stop', (reason: string) => {
            logger.error('RPC服务器紧急停止', new Error(reason), { reason })
            this.emit('emergency-stop', reason)
        })

        // 监听节点管理器事件
        this.nodeManager.on('nodeAdded', (node) => {
            logger.info('新节点已添加', { nodeId: node.id, domain: node.domain })
        })

        this.nodeManager.on('nodeRemoved', (node) => {
            logger.info('节点已删除', { nodeId: node.id, domain: node.domain })
        })

        this.nodeManager.on('nodeToggled', (node) => {
            logger.info('节点状态已切换', { nodeId: node.id, enabled: node.enabled })
        })

        // 监听IP池同步管理器事件
        this.ipPoolSyncManager.on('ipStatusChanged', (event) => {
            logger.info('IP状态已变化', { 
                ip: event.ip, 
                domain: event.domain, 
                status: event.status 
            })
        })
    }

    /**
     * 启动服务
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('服务已在运行')
            return
        }

        try {
            logger.info('正在启动ZeroMaps RPC服务...')

            // 启动RPC服务器
            await this.rpcServer.start()
            logger.info('RPC服务器启动完成')

            // 启动监控服务器
            await this.monitorServer.start()
            logger.info('监控服务器启动完成')

            // 节点管理器会自动启动健康检查
            logger.info('节点管理器启动完成')

            // 启动IP池同步管理器
            this.ipPoolSyncManager.startPeriodicSync()
            logger.info('IP池同步管理器启动完成')

            // 启动IP健康检查
            this.ipPoolSyncManager.startHealthCheck()
            logger.info('IP健康检查启动完成')

            this.isRunning = true
            logger.info('ZeroMaps RPC服务启动完成', {
                rpcPort: this.configManager.get('server.rpc.port'),
                monitorPort: this.configManager.get('server.monitor.port'),
                concurrency: this.configManager.get('utls.concurrency'),
                ipv6Count: this.configManager.get('ipv6.count')
            })

            this.emit('started')
        } catch (error) {
            logger.error('启动服务失败', error as Error)
            await this.stop()
            throw error
        }
    }

    /**
     * 停止服务
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            return
        }

        try {
            logger.info('正在停止ZeroMaps RPC服务...')

            // 停止监控服务器
            await this.monitorServer.stop()
            logger.info('监控服务器已停止')

            // 停止节点管理器
            if (this.nodeManager) {
                this.nodeManager.stop()
                logger.info('节点管理器已停止')
            }

            // 停止IP池同步管理器
            if (this.ipPoolSyncManager) {
                this.ipPoolSyncManager.stop()
                logger.info('IP池同步管理器已停止')
            }

            // 停止RPC服务器
            await this.rpcServer.stop()
            logger.info('RPC服务器已停止')

            this.isRunning = false
            logger.info('ZeroMaps RPC服务已停止')

            this.emit('stopped')
        } catch (error) {
            logger.error('停止服务失败', error as Error)
            throw error
        }
    }

    /**
     * 重启服务
     */
    public async restart(): Promise<void> {
        logger.info('正在重启ZeroMaps RPC服务...')
        await this.stop()
        await this.start()
        logger.info('ZeroMaps RPC服务重启完成')
    }

    /**
     * 获取服务状态
     */
    public getStatus(): {
        isRunning: boolean
        config: any
    } {
        return {
            isRunning: this.isRunning,
            config: this.configManager.getAll()
        }
    }

    /**
     * 获取节点管理器实例
     */
    public getNodeManager(): NodeManager {
        return this.nodeManager
    }

    /**
     * 获取IP池同步管理器实例
     */
    public getIPPoolSyncManager(): IPPoolSyncManager {
        return this.ipPoolSyncManager
    }

    /**
     * 获取统计信息
     */
    public getStats(): any {
        return this.rpcServer.getStats()
    }

    /**
     * 更新配置
     */
    public async updateConfig(path: string, value: any): Promise<void> {
        await this.configManager.set(path, value)
    }

    /**
     * 重新加载配置
     */
    public reloadConfig(): void {
        this.configManager.reload()
    }

    /**
     * 销毁服务
     */
    public async destroy(): Promise<void> {
        await this.stop()
        logger.info('ZeroMaps RPC服务已销毁')
    }
}

/**
 * 创建服务实例
 */
export function createZeroMapsRPC(): ZeroMapsRPC {
    return new ZeroMapsRPC()
}

/**
 * 默认导出
 */
export default ZeroMapsRPC
