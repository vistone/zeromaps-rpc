# ZeroMaps RPC 开发指南

> **文档版本**: v2.3.x  
> **更新日期**: 2025-10-20  
> **维护者**: Stone (vistone)

## 📋 目录

- [1. 开发环境设置](#1-开发环境设置)
- [2. 项目结构](#2-项目结构)
- [3. 编码规范](#3-编码规范)
- [4. 核心模块开发](#4-核心模块开发)
- [5. 测试](#5-测试)
- [6. 调试](#6-调试)
- [7. Git 工作流](#7-git-工作流)
- [8. 贡献指南](#8-贡献指南)

---

## 1. 开发环境设置

### 1.1 前置要求

**必需软件**:
- Node.js 18.x+
- npm 8.x+
- Go 1.24.9
- Git 2.x+
- TypeScript 5.6+
- VS Code 或其他 IDE

**推荐工具**:
- PM2 (进程管理)
- Postman (API 测试)
- Wireshark (网络调试)

### 1.2 克隆项目

```bash
# 克隆仓库
git clone https://github.com/vistone/zeromaps-rpc.git
cd zeromaps-rpc

# 查看分支
git branch -a
```

### 1.3 安装依赖

```bash
# 安装 Node.js 依赖
npm install

# 安装 Go 依赖（自动）
cd utls-proxy
go mod download
cd ..

# 安装 Git hooks
npm run prepare  # 自动执行
```

### 1.4 编译项目

```bash
# 编译 TypeScript
npm run build

# 编译 Go uTLS Proxy
cd utls-proxy
bash build.sh
cd ..

# 验证编译产物
ls -lh dist/server/index.js
ls -lh utls-proxy/utls-proxy
```

### 1.5 配置开发环境

#### 1.5.1 创建本地配置

```bash
# 复制默认配置
cp config/default.json config/node-$(hostname).json

# 编辑本地配置
vim config/node-$(hostname).json
```

**示例配置 (开发环境)**:
```json
{
    "server": {
        "rpc": {
            "port": 9527
        },
        "monitor": {
            "port": 9528
        },
        "webhook": {
            "port": 9530,
            "secret": "dev-secret"
        }
    },
    "utls": {
        "proxyPort": 8765,
        "concurrency": 5  // 开发环境降低并发
    },
    "ipv6": {
        "prefix": "",  // 开发环境可能没有 IPv6
        "start": 1001,
        "count": 10  // 开发环境减少地址池
    },
    "logging": {
        "level": "debug"  // 开发环境启用 debug 日志
    }
}
```

#### 1.5.2 创建 VPS 配置（可选）

```bash
# 如果有 IPv6 测试环境
cat > configs/vps-$(curl -s ifconfig.me).conf <<EOF
SERVER_NAME="dev"
SERVER_DOMAIN="localhost"
IPV6_PREFIX="2607:8700:5500:2943"
INTERFACE="he-ipv6"
REMOTE_IP="$(curl -s ifconfig.me)"
EOF
```

### 1.6 启动开发服务器

```bash
# 方法 1: 使用 PM2（推荐）
pm2 start ecosystem.config.example.cjs --name zeromaps-dev

# 方法 2: 直接运行（方便调试）
# 终端 1: 启动 Go 代理
cd utls-proxy
./utls-proxy

# 终端 2: 启动 Node.js 服务
npm run server

# 或使用 tsx 实时重载
npx tsx watch server/index.ts
```

### 1.7 验证开发环境

```bash
# 检查服务状态
curl http://localhost:9528/api/stats
curl http://localhost:8765/health

# 运行测试
npm run test  # 如果有测试脚本
```

---

## 2. 项目结构

### 2.1 目录结构

```
zeromaps-rpc/
├── server/                 # Node.js 服务器（TypeScript）
│   ├── index.ts           # 主入口
│   ├── rpc-server.ts      # RPC 服务器
│   ├── ipv6-pool.ts       # IPv6 池管理
│   ├── utls-fetcher.ts    # uTLS Fetcher
│   ├── monitor-server.ts  # 监控服务器
│   ├── webhook-server.ts  # Webhook 服务器
│   ├── config-manager.ts  # 配置管理
│   ├── system-monitor.ts  # 系统监控
│   ├── stats-exporter.ts  # 统计导出
│   └── logger.ts          # 日志工具
│
├── client/                 # 客户端 SDK（TypeScript）
│   ├── index.ts           # 导出
│   ├── rpc-client.ts      # RPC 客户端
│   └── ws-client.ts       # WebSocket 客户端
│
├── utls-proxy/             # Go uTLS 代理
│   ├── main.go            # 主程序
│   ├── dns_pool.go        # DNS IP 池
│   ├── go.mod             # Go 依赖
│   └── build.sh           # 编译脚本
│
├── proto/                  # Protobuf 定义
│   ├── zeromaps-rpc.proto # 协议定义
│   └── proto/             # 生成的代码
│
├── config/                 # 运行时配置
│   ├── default.json       # 默认配置
│   ├── node-example.json  # 节点配置示例
│   └── nodes.json         # 节点列表
│
├── configs/                # VPS 物理配置
│   ├── vps-example.conf   # 配置示例
│   └── vps-*.conf         # 各节点配置（不提交）
│
├── public/                 # Web 前端
│   └── index.html         # 管理面板
│
├── hooks/                  # Git hooks
│   ├── pre-commit         # 提交前检查
│   ├── commit-msg         # 提交消息检查
│   └── post-commit        # 提交后处理
│
├── docs/                   # 技术文档
│   ├── ARCHITECTURE.md    # 架构设计
│   ├── API_REFERENCE.md   # API 参考
│   ├── DEPLOYMENT.md      # 部署指南
│   ├── DEVELOPMENT.md     # 开发指南
│   └── PERFORMANCE.md     # 性能分析
│
├── logs/                   # 日志目录
├── dist/                   # 编译输出（不提交）
├── node_modules/           # NPM 依赖（不提交）
│
├── package.json            # NPM 配置
├── tsconfig.json           # TypeScript 配置
├── README.md               # 项目文档
├── deploy.sh               # 部署脚本
├── auto-update.sh          # 自动更新脚本
├── update.sh               # 简化更新脚本
└── ecosystem.config.cjs    # PM2 配置（动态生成）
```

### 2.2 核心模块说明

| 模块 | 语言 | 职责 |
|------|------|------|
| **RpcServer** | TypeScript | RPC 服务器，处理客户端连接和请求 |
| **IPv6Pool** | TypeScript | IPv6 地址池管理和健康检查 |
| **UTLSFetcher** | TypeScript | 请求队列管理，调用 Go 代理 |
| **MonitorServer** | TypeScript | 监控服务器，HTTP API + WebSocket |
| **WebhookServer** | TypeScript | Webhook 服务器，自动更新 |
| **ConfigManager** | TypeScript | 配置管理，支持热加载 |
| **uTLS Proxy** | Go | TLS 指纹模拟，Session 管理 |
| **DNS IP Pool** | Go | DNS 优化，IP 池管理 |

---

## 3. 编码规范

### 3.1 TypeScript 规范

**严格遵循 TypeScript 规范**:
- ✅ 使用严格类型检查
- ✅ 避免使用 `any` 类型
- ✅ 为所有函数定义参数和返回类型
- ✅ 使用接口定义对象结构

**面向对象编程**:
- ✅ 必须使用类 (Class) 组织代码
- ✅ 使用访问修饰符: `private`, `public`, `protected`
- ✅ 单一职责原则：每个类只负责一件事

**代码风格**:
- ✅ 使用分号结束语句
- ✅ 使用 2 空格缩进
- ✅ 类名使用 PascalCase
- ✅ 方法名使用 camelCase
- ✅ 常量使用 UPPER_SNAKE_CASE

**示例**:
```typescript
export class IPv6Pool {
  private addresses: string[]
  private currentIndex: number = 0
  
  constructor(basePrefix: string, start: number, count: number) {
    this.addresses = []
    // 初始化逻辑
  }
  
  public getNext(): string {
    // 方法实现
  }
  
  private validateAddress(addr: string): boolean {
    // 私有方法
  }
}
```

### 3.2 Go 规范

**遵循 Go 官方规范**:
- ✅ 使用 `gofmt` 格式化代码
- ✅ 使用 `golint` 检查代码质量
- ✅ 遵循 Effective Go 指南

**命名规范**:
- ✅ 导出函数/变量使用 PascalCase
- ✅ 私有函数/变量使用 camelCase
- ✅ 包名使用小写字母

**示例**:
```go
// 导出函数
func RefreshSession(ipv6 string) error {
    // ...
}

// 私有函数
func getOrCreateSession(ipv6 string) *CookieSession {
    // ...
}

// 结构体
type CookieSession struct {
    cookies    []*http.Cookie
    lastUpdate time.Time
    mu         sync.RWMutex
}
```

### 3.3 注释规范

**TypeScript 注释**:
```typescript
/**
 * IPv6 地址池管理器
 * 管理和轮换 IPv6 地址，避免单个地址请求过多
 */
export class IPv6Pool {
  /**
   * 获取健康的 IPv6 地址（排除失败率高的IP）
   * @returns IPv6 地址，如果没有健康地址返回 null
   */
  public getHealthyNext(): string | null {
    // ...
  }
}
```

**Go 注释**:
```go
// RefreshSession 刷新指定 IPv6 的会话
// 如果 force=true，强制刷新；否则检查是否需要刷新
func RefreshSession(ipv6 string, force bool) error {
    // ...
}
```

### 3.4 错误处理

**TypeScript**:
```typescript
try {
    const result = await this.fetch(options)
    return result
} catch (error) {
    logger.error('请求失败', error as Error, {
        url: options.url,
        ipv6: options.ipv6
    })
    throw error
}
```

**Go**:
```go
resp, err := client.Do(req)
if err != nil {
    return nil, fmt.Errorf("请求失败: %w", err)
}
defer resp.Body.Close()
```

---

## 4. 核心模块开发

### 4.1 添加新的 RPC 方法

#### 4.1.1 定义 Protobuf

```protobuf
// proto/zeromaps-rpc.proto
message CustomRequest {
    uint32 clientID = 1;
    string customField = 2;
}

message CustomResponse {
    bool success = 1;
    string data = 2;
}
```

#### 4.1.2 生成代码

```bash
npm run proto:build
```

#### 4.1.3 实现服务端

```typescript
// server/rpc-server.ts
private async handleCustomRequest(socket: net.Socket, payload: Buffer): Promise<void> {
    try {
        const request = CustomRequest.decode(payload)
        
        // 业务逻辑
        const result = await this.processCustomRequest(request)
        
        // 构建响应
        const response = CustomResponse.encode({
            success: true,
            data: result
        }).finish()
        
        this.sendFrame(socket, FrameType.CUSTOM_RESPONSE, Buffer.from(response))
    } catch (error) {
        logger.error('处理自定义请求失败', error as Error)
    }
}
```

#### 4.1.4 实现客户端

```typescript
// client/rpc-client.ts
public async sendCustomRequest(customField: string): Promise<CustomResponse> {
    const request = CustomRequest.encode({
        clientID: this.clientID,
        customField
    }).finish()
    
    this.sendFrame(FrameType.CUSTOM_REQUEST, request)
    
    // 等待响应
    return this.waitForResponse('CUSTOM_RESPONSE')
}
```

### 4.2 添加新的浏览器指纹

```go
// utls-proxy/main.go
browserProfiles = append(browserProfiles, BrowserProfile{
    Name:            "Chrome 140 (Windows 11)",
    UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    SecChUa:         `"Chromium";v="140", "Not(A:Brand";v="24", "Google Chrome";v="140"`,
    SecChUaPlatform: `"Windows"`,
    AcceptLanguage:  "zh-CN,zh;q=0.9,en;q=0.8",
    Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    ClientHello:     utls.HelloChrome_140,  // 需要 uTLS 库支持
})
```

### 4.3 添加新的监控指标

```typescript
// server/monitor-server.ts
private async serveCustomMetrics(res: http.ServerResponse): Promise<void> {
    const customMetrics = {
        metric1: this.calculateMetric1(),
        metric2: this.calculateMetric2()
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(customMetrics))
}

// 注册路由
private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/'
    
    if (url === '/api/custom-metrics') {
        await this.serveCustomMetrics(res)
    }
    // ...
}
```

### 4.4 添加新的配置项

#### 4.4.1 更新配置接口

```typescript
// server/config-manager.ts
export interface ServerConfig {
    // ... 现有配置
    
    custom: {
        newFeature: boolean
        maxValue: number
    }
}
```

#### 4.4.2 更新默认配置

```json
// config/default.json
{
    "custom": {
        "newFeature": false,
        "maxValue": 100
    }
}
```

#### 4.4.3 使用配置

```typescript
const config = getConfig()
const newFeature = config.get<boolean>('custom.newFeature')

if (newFeature) {
    // 新功能逻辑
}
```

---

## 5. 测试

### 5.1 单元测试

**创建测试文件**:
```typescript
// tests/ipv6-pool.test.ts
import { IPv6Pool } from '../server/ipv6-pool'

describe('IPv6Pool', () => {
    let pool: IPv6Pool
    
    beforeEach(() => {
        pool = new IPv6Pool('2607:8700:5500:2943', 1001, 10)
    })
    
    test('应该返回正确数量的地址', () => {
        const addresses = pool.getAllAddresses()
        expect(addresses.length).toBe(10)
    })
    
    test('应该轮询返回地址', () => {
        const addr1 = pool.getNext()
        const addr2 = pool.getNext()
        expect(addr1).not.toBe(addr2)
    })
    
    test('应该记录请求统计', () => {
        const addr = pool.getNext()!
        pool.recordRequest(addr, 200, 100)
        
        const stats = pool.getDetailedStats()
        expect(stats.totalRequests).toBe(1)
        expect(stats.totalSuccess).toBe(1)
    })
})
```

**运行测试**:
```bash
npm test
```

### 5.2 集成测试

**测试 RPC 连接**:
```typescript
// tests/test-connection.ts
import { RpcClient } from '../client/rpc-client'

async function testConnection() {
    const client = new RpcClient('localhost', 9527)
    
    try {
        await client.connect()
        console.log('✓ 连接成功')
        
        const response = await client.fetchData('BulkMetadata/pb=!1m2!1s04!2u2699')
        console.log(`✓ 请求成功: ${response.statusCode}, ${response.data.length} bytes`)
        
        await client.disconnect()
        console.log('✓ 断开连接')
    } catch (error) {
        console.error('✗ 测试失败:', error)
    }
}

testConnection()
```

**运行集成测试**:
```bash
npx tsx tests/test-connection.ts
```

### 5.3 性能测试

**压力测试脚本**:
```typescript
// stress-test.ts
import { RpcClient } from './client/rpc-client'

async function stressTest() {
    const client = new RpcClient('localhost', 9527)
    await client.connect()
    
    const startTime = Date.now()
    const promises: Promise<any>[] = []
    
    // 发送 1000 个并发请求
    for (let i = 0; i < 1000; i++) {
        promises.push(client.fetchData('BulkMetadata/pb=!1m2!1s04!2u2699'))
    }
    
    const results = await Promise.allSettled(promises)
    
    const duration = Date.now() - startTime
    const success = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length
    
    console.log(`总耗时: ${duration}ms`)
    console.log(`成功: ${success}, 失败: ${failed}`)
    console.log(`QPS: ${(1000 / duration * 1000).toFixed(2)}`)
    
    await client.disconnect()
}

stressTest()
```

---

## 6. 调试

### 6.1 VS Code 调试配置

创建 `.vscode/launch.json`:
```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "node",
            "request": "launch",
            "name": "Debug Server",
            "runtimeExecutable": "npx",
            "runtimeArgs": ["tsx", "server/index.ts"],
            "cwd": "${workspaceFolder}",
            "env": {
                "NODE_ENV": "development",
                "LOG_LEVEL": "debug"
            },
            "console": "integratedTerminal"
        },
        {
            "type": "node",
            "request": "launch",
            "name": "Debug Test",
            "runtimeExecutable": "npx",
            "runtimeArgs": ["tsx", "tests/test-connection.ts"],
            "cwd": "${workspaceFolder}",
            "console": "integratedTerminal"
        }
    ]
}
```

### 6.2 日志调试

**启用 debug 日志**:
```json
// config/node-dev.json
{
    "logging": {
        "level": "debug"
    }
}
```

**日志输出**:
```typescript
// 使用 logger
import { createLogger } from './logger'
const logger = createLogger('ModuleName')

logger.debug('调试信息', { key: 'value' })
logger.info('普通信息', { key: 'value' })
logger.warn('警告信息', { key: 'value' })
logger.error('错误信息', error, { key: 'value' })
```

### 6.3 网络调试

**使用 Wireshark**:
```bash
# 捕获 RPC 流量
sudo tcpdump -i any port 9527 -w rpc.pcap

# 使用 Wireshark 打开
wireshark rpc.pcap
```

**使用 curl 测试 HTTP API**:
```bash
# 测试监控 API
curl http://localhost:9528/api/stats | jq .

# 测试 uTLS 代理
curl http://localhost:8765/health | jq .

# 测试 IP 池
curl http://localhost:8765/ip-pool | jq .
```

### 6.4 Go 调试

**使用 Delve**:
```bash
# 安装 Delve
go install github.com/go-delve/delve/cmd/dlv@latest

# 调试 Go 代理
cd utls-proxy
dlv debug main.go

# 在 Delve 中设置断点
(dlv) break main.proxyHandler
(dlv) continue
```

---

## 7. Git 工作流

### 7.1 Git Hooks

**pre-commit hook** (提交前检查):
```bash
#!/bin/bash
# hooks/pre-commit

# 检查是否修改了 package.json
if git diff --cached --name-only | grep -q "package.json"; then
    # 检查版本号是否递增
    OLD_VERSION=$(git show HEAD:package.json | grep '"version"' | cut -d'"' -f4)
    NEW_VERSION=$(grep '"version"' package.json | cut -d'"' -f4)
    
    if [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
        echo "❌ 错误：package.json 版本号未更新"
        echo "   当前版本: $OLD_VERSION"
        echo "   请更新 version 字段后再提交"
        exit 1
    fi
fi

# 检查 TypeScript 编译
npm run build
if [ $? -ne 0 ]; then
    echo "❌ TypeScript 编译失败，请修复错误后再提交"
    exit 1
fi

echo "✅ pre-commit 检查通过"
```

**commit-msg hook** (检查提交消息):
```bash
#!/bin/bash
# hooks/commit-msg

COMMIT_MSG_FILE=$1
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# 检查提交消息格式: type: description (vX.X.X)
if ! echo "$COMMIT_MSG" | grep -qE '^(feat|fix|perf|refactor|docs|chore|style): .+ \(v[0-9]+\.[0-9]+\.[0-9]+\)'; then
    echo "❌ 错误：提交消息格式不正确"
    echo "   格式: type: description (vX.X.X)"
    echo "   示例: feat: 添加新功能 (v2.3.27)"
    exit 1
fi

echo "✅ commit-msg 检查通过"
```

**post-commit hook** (自动创建 tag):
```bash
#!/bin/bash
# hooks/post-commit

# 从 package.json 读取版本号
VERSION=$(grep '"version"' package.json | cut -d'"' -f4)

# 创建 tag
git tag -a "v$VERSION" -m "Release v$VERSION"

echo "✅ 已创建 tag: v$VERSION"
echo "   推送 tag: git push --tags"
```

### 7.2 提交流程

```bash
# 1. 修改代码
vim server/rpc-server.ts

# 2. 编译测试
npm run build
npm test

# 3. 更新版本号
# 编辑 package.json，version 字段 +1

# 4. 提交代码
git add -A
git commit -m "feat: 添加新功能 (v2.3.28)"

# 5. 推送（Git hooks 会自动创建 tag）
git push && git push --tags
```

### 7.3 分支策略

- `master` - 生产分支（稳定版本）
- `develop` - 开发分支（最新开发）
- `feature/*` - 功能分支
- `hotfix/*` - 紧急修复分支

**创建功能分支**:
```bash
git checkout -b feature/new-feature develop
# 开发...
git commit -m "feat: 实现新功能 (v2.3.28)"
git push origin feature/new-feature
# 创建 Pull Request
```

---

## 8. 贡献指南

### 8.1 代码审查清单

- [ ] 代码遵循编码规范
- [ ] 添加了必要的注释
- [ ] 更新了相关文档
- [ ] 通过了所有测试
- [ ] 没有引入新的 lint 错误
- [ ] 提交消息格式正确
- [ ] 版本号已更新

### 8.2 Pull Request 流程

1. Fork 仓库
2. 创建功能分支
3. 提交代码
4. 创建 Pull Request
5. 等待代码审查
6. 合并到主分支

### 8.3 Issue 报告

**Bug 报告模板**:
```markdown
## 问题描述
简要描述遇到的问题

## 复现步骤
1. 步骤 1
2. 步骤 2
3. 步骤 3

## 预期行为
描述预期的正常行为

## 实际行为
描述实际发生的情况

## 环境信息
- OS: Ubuntu 20.04
- Node.js: v18.0.0
- 版本: v2.3.27

## 日志输出
```附上相关日志```
```

---

## 附录

### A. 常用命令

**开发**:
```bash
npm run build       # 编译 TypeScript
npm run server      # 启动服务器
npm run proto:build # 生成 Protobuf 代码
npm test            # 运行测试
```

**调试**:
```bash
npx tsx server/index.ts     # 直接运行
npx tsx watch server/index.ts  # 监听文件变化
pm2 logs zeromaps-rpc --lines 50  # 查看日志
```

**Git**:
```bash
git status          # 查看状态
git add -A          # 添加所有更改
git commit -m "..."  # 提交
git push && git push --tags  # 推送
```

### B. 开发工具推荐

| 工具 | 用途 |
|------|------|
| **VS Code** | IDE |
| **Postman** | API 测试 |
| **Wireshark** | 网络调试 |
| **PM2** | 进程管理 |
| **Git** | 版本控制 |

### C. 参考资源

- [TypeScript 官方文档](https://www.typescriptlang.org/docs/)
- [Go 官方文档](https://go.dev/doc/)
- [uTLS 库](https://github.com/refraction-networking/utls)
- [Protocol Buffers](https://developers.google.com/protocol-buffers)
- [PM2 文档](https://pm2.keymetrics.io/docs/)

---

**文档维护**: 本文档随代码更新，请保持同步。  
**最后更新**: 2025-10-20  
**版本**: v2.3.x

