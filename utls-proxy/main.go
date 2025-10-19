package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

// 浏览器指纹配置（严格基于 uTLS v1.6.0 支持的 ClientHelloID）
type BrowserProfile struct {
	Name            string
	UserAgent       string
	SecChUa         string // Chrome/Edge 系列特有
	SecChUaPlatform string // Chrome/Edge 系列特有
	AcceptLanguage  string
	Accept          string
	ClientHello     utls.ClientHelloID
}

// Cookie 会话管理
type CookieSession struct {
	cookies        []*http.Cookie
	lastUpdate     time.Time
	earliestExpiry time.Time   // 最早过期的 Cookie 的过期时间
	lastAccess     time.Time   // 最后访问时间（用于清理）
	refreshing     atomic.Bool // 是否正在刷新（防止并发刷新）
	mu             sync.RWMutex
}

// IPv6 健康状态（用于熔断器）
type IPv6Health struct {
	totalRequests  atomic.Int64
	failedRequests atomic.Int64
	circuitOpen    atomic.Bool // 熔断器是否打开（true = 熔断中）
	circuitOpenAt  time.Time   // 熔断器打开时间
	mu             sync.RWMutex
}

// 统计信息（按错误类型分类）
type Stats struct {
	totalRequests       atomic.Int64
	successRequests     atomic.Int64
	failedRequests      atomic.Int64
	error403Count       atomic.Int64 // Forbidden
	error429Count       atomic.Int64 // Too Many Requests
	error503Count       atomic.Int64 // Service Unavailable
	error5xxCount       atomic.Int64 // 其他 5xx 错误
	timeoutCount        atomic.Int64 // 超时错误
	networkErrorCount   atomic.Int64 // 网络错误
	sessionRefreshCount atomic.Int64
	startTime           time.Time
	browserUsage        sync.Map // 记录每个浏览器的使用次数
}

var (
	stats                       = &Stats{startTime: time.Now()}
	clientPool                  sync.Pool     // 无 IPv6 绑定的客户端池
	ipv6ClientCache             sync.Map      // IPv6 地址 -> *http.Client 的缓存
	sessionManager              sync.Map      // IPv6 地址 -> *CookieSession 的缓存（每个 IPv6 独立 Session）
	browserProfileMap           sync.Map      // IPv6 地址 -> BrowserProfile 的缓存（每个 IPv6 固定浏览器指纹）
	ipv6HealthMap               sync.Map      // IPv6 地址 -> *IPv6Health 的健康状态（熔断器）
	sessionRefreshSem           chan struct{} // 并发刷新控制信号量（动态调整大小）
	currentMaxConcurrentRefresh atomic.Int32  // 当前最大并发刷新数（智能调整）
	activeRequests              atomic.Int64  // 当前正在处理的请求数
	shutdownFlag                atomic.Bool   // 关闭标志
	logFileHandle               *os.File      // 日志文件句柄（用于日志轮转）
	
	// DNS IP 池（新增）
	dnsIPPools = make(map[string]*DNSIPPool) // domain → DNS IP 池
	p2pSync    *P2PSync                       // P2P 同步管理器
	
	allowedDomains              = map[string]bool{
		"kh.google.com":    true,
		"earth.google.com": true,
		"www.google.com":   true,
	}

	// 浏览器指纹库（基于 uTLS v1.8.1 官方支持）
	browserProfiles = []BrowserProfile{
		// ========== Chrome 系列（Chromium 内核）==========
		{
			Name:            "Chrome 133 (Windows 11)",
			UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
			SecChUa:         `"Chromium";v="133", "Not(A:Brand";v="24", "Google Chrome";v="133"`,
			SecChUaPlatform: `"Windows"`,
			AcceptLanguage:  "zh-CN,zh;q=0.9,en;q=0.8",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
			ClientHello:     utls.HelloChrome_133,
		},
		{
			Name:            "Chrome 131 (Windows 10)",
			UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			SecChUa:         `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
			SecChUaPlatform: `"Windows"`,
			AcceptLanguage:  "zh-CN,zh;q=0.9,en;q=0.8",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
			ClientHello:     utls.HelloChrome_131,
		},
		{
			Name:            "Chrome 120 (Windows 10)",
			UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			SecChUa:         `"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`,
			SecChUaPlatform: `"Windows"`,
			AcceptLanguage:  "zh-CN,zh;q=0.9,en;q=0.8",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
			ClientHello:     utls.HelloChrome_120,
		},
		{
			Name:            "Chrome 102 (Windows 10)",
			UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36",
			SecChUa:         `" Not A;Brand";v="99", "Chromium";v="102", "Google Chrome";v="102"`,
			SecChUaPlatform: `"Windows"`,
			AcceptLanguage:  "en-US,en;q=0.9",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
			ClientHello:     utls.HelloChrome_102,
		},
		{
			Name:            "Chrome 106 (macOS)",
			UserAgent:       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36",
			SecChUa:         `"Chromium";v="106", "Google Chrome";v="106", "Not;A=Brand";v="99"`,
			SecChUaPlatform: `"macOS"`,
			AcceptLanguage:  "en-US,en;q=0.9",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
			ClientHello:     utls.HelloChrome_106_Shuffle,
		},
		{
			Name:            "Chrome 100 (Linux)",
			UserAgent:       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36",
			SecChUa:         `" Not A;Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"`,
			SecChUaPlatform: `"Linux"`,
			AcceptLanguage:  "en-US,en;q=0.9",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
			ClientHello:     utls.HelloChrome_100,
		},

		// ========== Firefox 系列 ==========
		{
			Name:            "Firefox 120 (Windows 10)",
			UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
			SecChUa:         "", // Firefox 不使用 Sec-Ch-Ua
			SecChUaPlatform: "",
			AcceptLanguage:  "en-US,en;q=0.5",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
			ClientHello:     utls.HelloFirefox_120,
		},
		{
			Name:            "Firefox 105 (macOS)",
			UserAgent:       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:105.0) Gecko/20100101 Firefox/105.0",
			SecChUa:         "",
			SecChUaPlatform: "",
			AcceptLanguage:  "en-US,en;q=0.5",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
			ClientHello:     utls.HelloFirefox_105,
		},
		{
			Name:            "Firefox 102 (Linux)",
			UserAgent:       "Mozilla/5.0 (X11; Linux x86_64; rv:102.0) Gecko/20100101 Firefox/102.0",
			SecChUa:         "",
			SecChUaPlatform: "",
			AcceptLanguage:  "en-US,en;q=0.5",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
			ClientHello:     utls.HelloFirefox_102,
		},

		// ========== Edge 系列 ==========
		{
			Name:            "Edge 106 (Windows 11)",
			UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36 Edg/106.0.1370.52",
			SecChUa:         `"Chromium";v="106", "Microsoft Edge";v="106", "Not;A=Brand";v="99"`,
			SecChUaPlatform: `"Windows"`,
			AcceptLanguage:  "en-US,en;q=0.9",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
			ClientHello:     utls.HelloEdge_106,
		},
		{
			Name:            "Edge 85 (Windows 10)",
			UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.102 Safari/537.36 Edg/85.0.564.51",
			SecChUa:         `"Chromium";v="85", "Microsoft Edge";v="85", ";Not A Brand";v="99"`,
			SecChUaPlatform: `"Windows"`,
			AcceptLanguage:  "en-US,en;q=0.9",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
			ClientHello:     utls.HelloEdge_85,
		},

		// ========== Safari 系列 ==========
		{
			Name:            "Safari 16.0 (macOS)",
			UserAgent:       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
			SecChUa:         "", // Safari 不使用 Sec-Ch-Ua
			SecChUaPlatform: "",
			AcceptLanguage:  "en-US,en;q=0.9",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			ClientHello:     utls.HelloSafari_16_0,
		},

		// ========== iOS Safari 系列 ==========
		{
			Name:            "iOS 14 Safari (iPhone)",
			UserAgent:       "Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1",
			SecChUa:         "",
			SecChUaPlatform: "",
			AcceptLanguage:  "en-US,en;q=0.9",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			ClientHello:     utls.HelloIOS_14,
		},
		{
			Name:            "iOS 13 Safari (iPad)",
			UserAgent:       "Mozilla/5.0 (iPad; CPU OS 13_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.2 Mobile/15E148 Safari/604.1",
			SecChUa:         "",
			SecChUaPlatform: "",
			AcceptLanguage:  "en-US,en;q=0.9",
			Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			ClientHello:     utls.HelloIOS_13,
		},
	}

	rng *rand.Rand // 全局随机数生成器

	// 可配置参数（从环境变量读取，带默认值）
	config struct {
		maxRetries              int           // 最大重试次数
		baseRetryDelay          time.Duration // 基础重试延迟
		requestTimeout          time.Duration // 请求超时时间
		sessionRefreshTimeout   time.Duration // 会话刷新超时
		minConcurrentRefresh    int           // 最小并发刷新数
		maxConcurrentRefresh    int           // 最大并发刷新数
		resourceCleanInterval   time.Duration // 资源清理间隔
		sessionInactiveTime     time.Duration // Session 不活跃清理时间
		circuitBreakerThreshold float64       // 熔断器失败率阈值
		circuitBreakerWindow    int64         // 熔断器最小请求数
		circuitRecoveryTime     time.Duration // 熔断恢复时间
		logFile                 string        // 日志文件路径
		logMaxSize              int           // 日志文件最大大小（MB）
		logMaxBackups           int           // 保留的旧日志文件数
		logMaxAge               int           // 日志文件保留天数
	}
)

// 从环境变量加载配置（带默认值）
func loadConfig() {
	// 读取环境变量，如果不存在使用默认值
	config.maxRetries = 3
	if val := os.Getenv("UTLS_MAX_RETRIES"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.maxRetries = v
		}
	}

	config.baseRetryDelay = 100 * time.Millisecond
	if val := os.Getenv("UTLS_BASE_RETRY_DELAY_MS"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.baseRetryDelay = time.Duration(v) * time.Millisecond
		}
	}

	config.requestTimeout = 30 * time.Second
	if val := os.Getenv("UTLS_REQUEST_TIMEOUT"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.requestTimeout = time.Duration(v) * time.Second
		}
	}

	config.sessionRefreshTimeout = 15 * time.Second
	if val := os.Getenv("UTLS_SESSION_TIMEOUT"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.sessionRefreshTimeout = time.Duration(v) * time.Second
		}
	}

	config.minConcurrentRefresh = 2
	if val := os.Getenv("UTLS_MIN_CONCURRENT_REFRESH"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.minConcurrentRefresh = v
		}
	}

	config.maxConcurrentRefresh = 50
	if val := os.Getenv("UTLS_MAX_CONCURRENT_REFRESH"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.maxConcurrentRefresh = v
		}
	}

	config.resourceCleanInterval = 5 * time.Minute
	if val := os.Getenv("UTLS_CLEAN_INTERVAL_MIN"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.resourceCleanInterval = time.Duration(v) * time.Minute
		}
	}

	config.sessionInactiveTime = 30 * time.Minute
	if val := os.Getenv("UTLS_SESSION_INACTIVE_MIN"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.sessionInactiveTime = time.Duration(v) * time.Minute
		}
	}

	config.circuitBreakerThreshold = 0.8
	if val := os.Getenv("UTLS_CIRCUIT_THRESHOLD"); val != "" {
		if v, err := strconv.ParseFloat(val, 64); err == nil && v > 0 && v < 1 {
			config.circuitBreakerThreshold = v
		}
	}

	config.circuitBreakerWindow = 20
	if val := os.Getenv("UTLS_CIRCUIT_MIN_REQUESTS"); val != "" {
		if v, err := strconv.ParseInt(val, 10, 64); err == nil && v > 0 {
			config.circuitBreakerWindow = v
		}
	}

	config.circuitRecoveryTime = 5 * time.Minute
	if val := os.Getenv("UTLS_CIRCUIT_RECOVERY_MIN"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.circuitRecoveryTime = time.Duration(v) * time.Minute
		}
	}

	config.logFile = "/opt/zeromaps-rpc/logs/utls-proxy.log"
	if val := os.Getenv("UTLS_LOG_FILE"); val != "" {
		config.logFile = val
	}

	config.logMaxSize = 100 // MB
	if val := os.Getenv("UTLS_LOG_MAX_SIZE_MB"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.logMaxSize = v
		}
	}

	config.logMaxBackups = 5
	if val := os.Getenv("UTLS_LOG_MAX_BACKUPS"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.logMaxBackups = v
		}
	}

	config.logMaxAge = 7 // 天
	if val := os.Getenv("UTLS_LOG_MAX_AGE_DAYS"); val != "" {
		if v, err := strconv.Atoi(val); err == nil && v > 0 {
			config.logMaxAge = v
		}
	}

	log.Printf("📝 配置已加载:")
	log.Printf("  - 最大重试次数: %d", config.maxRetries)
	log.Printf("  - 基础重试延迟: %v", config.baseRetryDelay)
	log.Printf("  - 请求超时: %v", config.requestTimeout)
	log.Printf("  - Session 刷新超时: %v", config.sessionRefreshTimeout)
	log.Printf("  - 并发刷新范围: %d ~ %d（智能调整）", config.minConcurrentRefresh, config.maxConcurrentRefresh)
	log.Printf("  - 资源清理间隔: %v", config.resourceCleanInterval)
	log.Printf("  - Session 不活跃时间: %v", config.sessionInactiveTime)
	log.Printf("  - 熔断器失败率阈值: %.0f%%", config.circuitBreakerThreshold*100)
	log.Printf("  - 熔断器最小请求数: %d", config.circuitBreakerWindow)
	log.Printf("  - 熔断恢复时间: %v", config.circuitRecoveryTime)
	log.Printf("  - 日志文件: %s", config.logFile)
	log.Printf("  - 日志最大大小: %d MB", config.logMaxSize)
	log.Printf("  - 日志保留文件数: %d", config.logMaxBackups)
	log.Printf("  - 日志保留天数: %d", config.logMaxAge)
}

// 初始化日志
func initLogger() {
	// 如果配置了日志文件，输出到文件；否则输出到 stdout
	if config.logFile != "" {
		// 创建日志目录
		logDir := filepath.Dir(config.logFile)
		if err := os.MkdirAll(logDir, 0755); err != nil {
			// ⚠️  日志目录创建失败，降级到 stdout，但不阻止程序启动
			log.Printf("⚠️  创建日志目录失败: %v，日志将输出到 stdout", err)
			log.Printf("⚠️  请手动创建目录: sudo mkdir -p %s", logDir)
			config.logFile = "" // 标记为 stdout 模式
			return
		}

		// 打开日志文件（追加模式）
		logFile, err := os.OpenFile(config.logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			// ⚠️  日志文件打开失败，降级到 stdout，但不阻止程序启动
			log.Printf("⚠️  打开日志文件失败: %v，日志将输出到 stdout", err)
			log.Printf("⚠️  请检查文件权限: sudo chmod 644 %s", config.logFile)
			config.logFile = "" // 标记为 stdout 模式
			return
		}

		logFileHandle = logFile // 保存句柄供后续轮转使用

		// 设置日志输出到文件
		log.SetOutput(logFile)
		log.Printf("📝 日志已配置: %s (最大 %d MB, 保留 %d 个文件, %d 天)",
			config.logFile, config.logMaxSize, config.logMaxBackups, config.logMaxAge)
	} else {
		log.Printf("📝 日志输出到 stdout（建议在生产环境配置 UTLS_LOG_FILE）")
	}
}

// 定期检查并轮转日志
func startLogRotation() {
	if config.logFile == "" {
		return // 未配置日志文件，不需要轮转
	}

	ticker := time.NewTicker(1 * time.Hour) // 每小时检查一次
	defer ticker.Stop()

	log.Printf("📝 日志轮转任务已启动（每 1 小时检查）")

	for range ticker.C {
		if shutdownFlag.Load() {
			break
		}

		rotateLogIfNeeded()
	}
}

// 检查并轮转日志文件
func rotateLogIfNeeded() {
	if config.logFile == "" || logFileHandle == nil {
		return
	}

	// 检查文件大小
	fileInfo, err := os.Stat(config.logFile)
	if err != nil {
		log.Printf("⚠️  无法获取日志文件信息: %v", err)
		return
	}

	maxBytes := int64(config.logMaxSize) * 1024 * 1024 // MB 转 字节

	if fileInfo.Size() >= maxBytes {
		log.Printf("📝 日志文件达到 %d MB，开始轮转...", config.logMaxSize)

		// 关闭当前文件
		if logFileHandle != nil {
			logFileHandle.Close()
		}

		// 轮转日志文件（重命名为 .1, .2, .3...）
		for i := config.logMaxBackups - 1; i >= 1; i-- {
			oldName := fmt.Sprintf("%s.%d", config.logFile, i)
			newName := fmt.Sprintf("%s.%d", config.logFile, i+1)

			if _, err := os.Stat(oldName); err == nil {
				os.Rename(oldName, newName)
			}
		}

		// 当前日志文件重命名为 .1
		os.Rename(config.logFile, config.logFile+".1")

		// 创建新的日志文件
		newLogFile, err := os.OpenFile(config.logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			log.Printf("❌ 创建新日志文件失败: %v", err)
			// 回退到 stdout
			log.SetOutput(os.Stdout)
			logFileHandle = nil
			return
		}

		logFileHandle = newLogFile
		log.SetOutput(newLogFile)
		log.Printf("✓ 日志轮转完成")

		// 清理超过保留天数的旧日志
		cleanOldLogs()
	}
}

// 清理超过保留天数的旧日志
func cleanOldLogs() {
	if config.logMaxAge <= 0 {
		return
	}

	cutoffTime := time.Now().AddDate(0, 0, -config.logMaxAge)

	// 检查所有 .1, .2, .3... 文件
	for i := 1; i <= config.logMaxBackups+10; i++ {
		logPath := fmt.Sprintf("%s.%d", config.logFile, i)

		fileInfo, err := os.Stat(logPath)
		if err != nil {
			continue // 文件不存在
		}

		// 检查文件修改时间
		if fileInfo.ModTime().Before(cutoffTime) {
			if err := os.Remove(logPath); err == nil {
				log.Printf("🗑️  清理过期日志: %s (超过 %d 天)", filepath.Base(logPath), config.logMaxAge)
			}
		}
	}
}

// 初始化
func init() {
	rng = rand.New(rand.NewSource(time.Now().UnixNano()))

	// 加载配置
	loadConfig()

	// 初始化日志
	initLogger()

	clientPool = sync.Pool{
		New: func() interface{} {
			return createUTLSClient()
		},
	}

	// 初始化并发刷新控制信号量（初始值为最小值）
	sessionRefreshSem = make(chan struct{}, config.maxConcurrentRefresh)
	currentMaxConcurrentRefresh.Store(int32(config.minConcurrentRefresh))

	log.Printf("🎭 uTLS 浏览器指纹库已加载: %d 种配置（基于 uTLS v1.8.1）", len(browserProfiles))
	for i, profile := range browserProfiles {
		log.Printf("  [%d] %s", i+1, profile.Name)
	}
	log.Printf("🔒 并发刷新控制: 智能调整（%d ~ %d）", config.minConcurrentRefresh, config.maxConcurrentRefresh)
}

// 获取或分配 IPv6 的固定浏览器指纹
func getBrowserProfileForIPv6(ipv6 string) BrowserProfile {
	// 无 IPv6 时使用默认 key
	if ipv6 == "" {
		ipv6 = "default"
	}

	// 先查缓存：如果已经分配过，返回固定的指纹
	if cached, ok := browserProfileMap.Load(ipv6); ok {
		return cached.(BrowserProfile)
	}

	// 首次使用：随机选择一个浏览器指纹
	index := rng.Intn(len(browserProfiles))
	profile := browserProfiles[index]

	// 存入缓存，后续该 IPv6 一直使用这个指纹
	browserProfileMap.Store(ipv6, profile)

	log.Printf("✓ 为 IPv6 %s 分配浏览器指纹: %s",
		ipv6[:min(20, len(ipv6))], profile.Name)

	// 统计使用情况
	count, _ := stats.browserUsage.LoadOrStore(profile.Name, new(atomic.Int64))
	count.(*atomic.Int64).Add(1)

	return profile
}

// 随机选择浏览器指纹（仅用于无 IPv6 的场景）
func getRandomBrowserProfile() BrowserProfile {
	index := rng.Intn(len(browserProfiles))
	profile := browserProfiles[index]

	// 统计使用情况
	count, _ := stats.browserUsage.LoadOrStore(profile.Name, new(atomic.Int64))
	count.(*atomic.Int64).Add(1)

	return profile
}

// 创建可复用的 uTLS 客户端（使用随机浏览器指纹）
func createUTLSClient() *http.Client {
	profile := getRandomBrowserProfile()

	transport := &http2.Transport{
		AllowHTTP:         false,
		MaxHeaderListSize: 262144,
		ReadIdleTimeout:   60 * time.Second,
		PingTimeout:       15 * time.Second,

		DialTLS: func(network, addr string, cfg *tls.Config) (net.Conn, error) {
			dialer := &net.Dialer{
				Timeout:   10 * time.Second,
				KeepAlive: 30 * time.Second,
			}

			rawConn, err := dialer.Dial("tcp", addr)
			if err != nil {
				return nil, fmt.Errorf("TCP 连接失败: %w", err)
			}

			tlsConfig := &utls.Config{
				ServerName:         getHostFromAddr(addr),
				InsecureSkipVerify: false,
				MinVersion:         tls.VersionTLS12,
				NextProtos:         []string{"h2", "http/1.1"},
			}

			tlsConn := utls.UClient(rawConn, tlsConfig, profile.ClientHello)

			err = tlsConn.Handshake()
			if err != nil {
				rawConn.Close()
				return nil, fmt.Errorf("TLS 握手失败: %w", err)
			}

			return tlsConn, nil
		},
	}

	return &http.Client{
		Timeout:   config.requestTimeout,
		Transport: transport,
	}
}

// 获取或创建 IPv6 绑定的客户端（带缓存）
func getOrCreateIPv6Client(ipv6 string) (*http.Client, error) {
	// 先查缓存
	if cached, ok := ipv6ClientCache.Load(ipv6); ok {
		return cached.(*http.Client), nil
	}

	// 缓存未命中，创建新客户端
	client, err := createUTLSClientWithIPv6(ipv6)
	if err != nil {
		return nil, err
	}

	// 存入缓存
	ipv6ClientCache.Store(ipv6, client)
	log.Printf("✓ 为 IPv6 %s 创建并缓存新客户端", ipv6[:min(20, len(ipv6))])

	return client, nil
}

// 创建带 IPv6 绑定的客户端（使用该 IPv6 固定的浏览器指纹）
func createUTLSClientWithIPv6(ipv6 string) (*http.Client, error) {
	localAddr, err := net.ResolveIPAddr("ip6", ipv6)
	if err != nil {
		return nil, fmt.Errorf("无效的 IPv6 地址: %w", err)
	}

	// 获取该 IPv6 固定的浏览器指纹
	profile := getBrowserProfileForIPv6(ipv6)

	transport := &http2.Transport{
		AllowHTTP:         false,
		MaxHeaderListSize: 262144,
		ReadIdleTimeout:   60 * time.Second,
		PingTimeout:       15 * time.Second,

		DialTLS: func(network, addr string, cfg *tls.Config) (net.Conn, error) {
			dialer := &net.Dialer{
				Timeout:   10 * time.Second,
				KeepAlive: 30 * time.Second,
				LocalAddr: &net.TCPAddr{IP: localAddr.IP},
			}

			rawConn, err := dialer.Dial("tcp6", addr)
			if err != nil {
				return nil, fmt.Errorf("TCP6 连接失败: %w", err)
			}

			tlsConfig := &utls.Config{
				ServerName:         getHostFromAddr(addr),
				InsecureSkipVerify: false,
				MinVersion:         tls.VersionTLS12,
				NextProtos:         []string{"h2", "http/1.1"},
			}

			tlsConn := utls.UClient(rawConn, tlsConfig, profile.ClientHello)

			err = tlsConn.Handshake()
			if err != nil {
				rawConn.Close()
				return nil, fmt.Errorf("TLS 握手失败: %w", err)
			}

			return tlsConn, nil
		},
	}

	return &http.Client{
		Timeout:   config.requestTimeout,
		Transport: transport,
	}, nil
}

// min 辅助函数
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// 从 addr (host:port) 提取 host
func getHostFromAddr(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}

// 解压 gzip 响应
func decompressGzip(data []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

// 动态计算合适的并发刷新数
func calculateOptimalConcurrency() int32 {
	// 统计当前 Session 总数
	var sessionCount int32
	sessionManager.Range(func(key, value interface{}) bool {
		sessionCount++
		return true
	})

	// 策略：Session 数量 / 20，但限制在 min ~ max 之间
	// 10 个 Session → 2 个并发（最小值）
	// 100 个 Session → 5 个并发
	// 200 个 Session → 10 个并发
	// 1000 个 Session → 50 个并发（最大值）
	optimal := sessionCount / 20

	if optimal < int32(config.minConcurrentRefresh) {
		optimal = int32(config.minConcurrentRefresh)
	}
	if optimal > int32(config.maxConcurrentRefresh) {
		optimal = int32(config.maxConcurrentRefresh)
	}

	return optimal
}

// 获取或创建指定 IPv6 的 Session
func getOrCreateSession(ipv6 string) *CookieSession {
	// 无 IPv6 时使用默认 Session（key = ""）
	if ipv6 == "" {
		ipv6 = "default"
	}

	// 先查缓存
	if cached, ok := sessionManager.Load(ipv6); ok {
		return cached.(*CookieSession)
	}

	// 创建新 Session
	session := &CookieSession{
		lastAccess: time.Now(),
	}
	sessionManager.Store(ipv6, session)
	log.Printf("✓ 为 IPv6 %s 创建新 Session", ipv6[:min(20, len(ipv6))])

	return session
}

// 获取或创建 IPv6 的健康状态
func getOrCreateIPv6Health(ipv6 string) *IPv6Health {
	if ipv6 == "" {
		ipv6 = "default"
	}

	if cached, ok := ipv6HealthMap.Load(ipv6); ok {
		return cached.(*IPv6Health)
	}

	health := &IPv6Health{}
	ipv6HealthMap.Store(ipv6, health)
	return health
}

// 检查 IPv6 是否被熔断
func isCircuitOpen(ipv6 string) bool {
	health := getOrCreateIPv6Health(ipv6)

	// 检查熔断器是否打开
	if !health.circuitOpen.Load() {
		return false
	}

	// 检查是否可以尝试恢复（使用配置的恢复时间）
	health.mu.RLock()
	openAt := health.circuitOpenAt
	health.mu.RUnlock()

	if time.Since(openAt) > config.circuitRecoveryTime {
		log.Printf("🔄 [%s] 熔断器尝试恢复（已熔断 %v）", ipv6[:min(20, len(ipv6))], config.circuitRecoveryTime)

		// 重置计数器，给 IPv6 一个全新的机会
		health.totalRequests.Store(0)
		health.failedRequests.Store(0)
		health.circuitOpen.Store(false)

		log.Printf("✓ [%s] 熔断器已重置计数器，开始重新评估", ipv6[:min(20, len(ipv6))])
		return false
	}

	return true
}

// 记录请求结果并检查是否需要熔断
func recordRequestResult(ipv6 string, success bool) {
	health := getOrCreateIPv6Health(ipv6)

	health.totalRequests.Add(1)
	if !success {
		health.failedRequests.Add(1)
	}

	total := health.totalRequests.Load()
	failed := health.failedRequests.Load()

	// 使用配置的最小请求数
	if total < config.circuitBreakerWindow {
		return
	}

	// 计算失败率
	failureRate := float64(failed) / float64(total)

	// 使用配置的失败率阈值
	if failureRate > config.circuitBreakerThreshold && !health.circuitOpen.Load() {
		health.circuitOpen.Store(true)
		health.mu.Lock()
		health.circuitOpenAt = time.Now()
		health.mu.Unlock()

		log.Printf("⚠️  [%s] 触发熔断！失败率: %.2f%% (%d/%d)，暂停使用 %v",
			ipv6[:min(20, len(ipv6))], failureRate*100, failed, total, config.circuitRecoveryTime)
	}
}

// 检查指定 Session 的 Cookie 是否需要刷新
func needsRefresh(session *CookieSession) bool {
	session.mu.RLock()
	defer session.mu.RUnlock()

	// 1. 没有 Cookie，需要刷新
	if len(session.cookies) == 0 {
		return true
	}

	// 2. 检查是否有 Cookie 已经过期或即将过期（提前 5 分钟刷新）
	now := time.Now()
	if !session.earliestExpiry.IsZero() && now.Add(5*time.Minute).After(session.earliestExpiry) {
		return true
	}

	// 3. 兜底：如果 24 小时内没有刷新过，强制刷新（Google Cookie 有效期很长，不需要频繁刷新）
	if time.Since(session.lastUpdate) > 24*time.Hour {
		return true
	}

	return false
}

// 清理指定 Session 中已过期的 Cookie
func cleanExpiredCookies(session *CookieSession) {
	session.mu.Lock()
	defer session.mu.Unlock()

	now := time.Now()
	validCookies := make([]*http.Cookie, 0, len(session.cookies))

	for _, cookie := range session.cookies {
		// Cookie 没有设置过期时间，或者还未过期
		if cookie.Expires.IsZero() || cookie.Expires.After(now) {
			validCookies = append(validCookies, cookie)
		} else {
			log.Printf("🗑️  清理过期 Cookie: %s (过期时间: %s)",
				cookie.Name, cookie.Expires.Format(time.RFC3339))
		}
	}

	if len(validCookies) < len(session.cookies) {
		log.Printf("✓ Cookie 清理完成：%d 个有效，%d 个已过期",
			len(validCookies), len(session.cookies)-len(validCookies))
		session.cookies = validCookies
	}
}

// 初始化或刷新指定 IPv6 的会话（访问 earth.google.com 获取 Cookie）
func refreshSession(ipv6 string, force bool) error {
	// 获取或创建该 IPv6 的 Session
	session := getOrCreateSession(ipv6)

	// 先清理过期的 Cookie
	cleanExpiredCookies(session)

	// 检查是否需要刷新
	if !force && !needsRefresh(session) {
		session.mu.RLock()
		remaining := time.Until(session.earliestExpiry).Seconds()
		session.mu.RUnlock()

		if remaining > 0 {
			log.Printf("✓ [%s] Cookie 仍然有效（剩余 %.0f 秒）",
				ipv6[:min(20, len(ipv6))], remaining)
			return nil
		}
	}

	// 使用 CAS 操作防止同一 Session 并发刷新
	if !session.refreshing.CompareAndSwap(false, true) {
		log.Printf("⏳ [%s] 其他 goroutine 正在刷新会话，等待...", ipv6[:min(20, len(ipv6))])
		// 等待其他 goroutine 完成刷新
		for session.refreshing.Load() {
			time.Sleep(100 * time.Millisecond)
		}
		log.Printf("✓ [%s] 会话刷新完成，使用新 Cookie", ipv6[:min(20, len(ipv6))])
		return nil
	}
	defer session.refreshing.Store(false)

	// 获取全局并发刷新槽位（动态并发数）
	currentConcurrency := currentMaxConcurrentRefresh.Load()

	// 检查当前使用的槽位数
	currentUsed := int32(len(sessionRefreshSem))

	// 如果当前槽位使用数已经达到或超过动态计算的并发数，等待
	for currentUsed >= currentConcurrency {
		time.Sleep(50 * time.Millisecond)
		currentUsed = int32(len(sessionRefreshSem))
		currentConcurrency = currentMaxConcurrentRefresh.Load() // 重新读取，可能已调整
	}

	sessionRefreshSem <- struct{}{}
	defer func() { <-sessionRefreshSem }()

	log.Printf("🔄 [%s] 刷新会话：访问 earth.google.com... (槽位: %d/%d)",
		ipv6[:min(20, len(ipv6))], len(sessionRefreshSem), currentConcurrency)

	// 使用该 IPv6 固定的浏览器指纹
	profile := getBrowserProfileForIPv6(ipv6)
	log.Printf("🎭 使用浏览器指纹: %s", profile.Name)

	var client *http.Client
	var err error
	var shouldReturn bool

	if ipv6 != "" {
		// 使用缓存获取 IPv6 客户端
		client, err = getOrCreateIPv6Client(ipv6)
		if err != nil {
			log.Printf("⚠️  获取 IPv6 客户端失败，使用默认客户端: %v", err)
			client = clientPool.Get().(*http.Client)
			shouldReturn = true
		} else {
			shouldReturn = false
		}
	} else {
		client = clientPool.Get().(*http.Client)
		shouldReturn = true
	}

	if shouldReturn {
		defer clientPool.Put(client)
	}

	ctx, cancel := context.WithTimeout(context.Background(), config.sessionRefreshTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", "https://earth.google.com/web/", nil)
	if err != nil {
		return fmt.Errorf("创建会话请求失败: %w", err)
	}

	// 使用随机选择的浏览器指纹设置 Headers
	setHeaders(req, profile, true)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("会话请求失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("会话请求失败: HTTP %d", resp.StatusCode)
	}

	io.Copy(io.Discard, resp.Body)

	cookies := resp.Cookies()
	if len(cookies) == 0 {
		return fmt.Errorf("未获取到 Cookie")
	}

	// 验证必需的 Cookie（NID 和 1P_JAR 至少要有一个）
	hasNID := false
	has1PJAR := false
	for _, cookie := range cookies {
		if cookie.Name == "NID" {
			hasNID = true
		}
		if cookie.Name == "1P_JAR" {
			has1PJAR = true
		}
	}

	if !hasNID && !has1PJAR {
		log.Printf("⚠️  警告：未获取到关键 Cookie (NID 或 1P_JAR)，但有 %d 个其他 Cookie", len(cookies))
		// 不返回错误，只记录警告（因为可能有其他有效的 Cookie）
	}

	// 计算最早过期时间
	now := time.Now()
	earliestExpiry := time.Time{}

	for _, cookie := range cookies {
		// 如果 Cookie 没有设置过期时间，使用 MaxAge
		if cookie.Expires.IsZero() && cookie.MaxAge > 0 {
			cookie.Expires = now.Add(time.Duration(cookie.MaxAge) * time.Second)
		}

		// 记录最早过期时间（排除 session cookie）
		if !cookie.Expires.IsZero() {
			if earliestExpiry.IsZero() || cookie.Expires.Before(earliestExpiry) {
				earliestExpiry = cookie.Expires
			}
		}
	}

	// 如果所有 Cookie 都是 session cookie（没有过期时间），默认 1 小时后过期
	if earliestExpiry.IsZero() {
		earliestExpiry = now.Add(1 * time.Hour)
	}

	session.mu.Lock()
	session.cookies = cookies
	session.lastUpdate = now
	session.earliestExpiry = earliestExpiry
	session.mu.Unlock()

	stats.sessionRefreshCount.Add(1)

	log.Printf("✓ [%s] 会话已刷新，获得 %d 个 Cookie", ipv6[:min(20, len(ipv6))], len(cookies))
	for _, cookie := range cookies {
		expiryInfo := "Session"
		if !cookie.Expires.IsZero() {
			expiryInfo = fmt.Sprintf("过期: %s", cookie.Expires.Format("15:04:05"))
		}

		// 显示 Cookie 的 Domain，确认可以跨域使用
		domainInfo := cookie.Domain
		if domainInfo == "" {
			domainInfo = "earth.google.com" // 默认域
		}

		log.Printf("  - %s=%s... (Domain: %s, %s)",
			cookie.Name, safeSubstring(cookie.Value, 20), domainInfo, expiryInfo)
	}
	log.Printf("  ⏰ 最早过期时间: %s（%d 秒后）",
		earliestExpiry.Format("15:04:05"), int(time.Until(earliestExpiry).Seconds()))

	return nil
}

// 设置 HTTP Headers（根据浏览器指纹）
func setHeaders(req *http.Request, profile BrowserProfile, isSessionRequest bool) {
	// 基础 Headers
	req.Header.Set("User-Agent", profile.UserAgent)
	req.Header.Set("Accept-Language", profile.AcceptLanguage)

	// Chrome/Edge 特有的 Sec-Ch-Ua Headers
	if profile.SecChUa != "" {
		req.Header.Set("Sec-Ch-Ua", profile.SecChUa)
		req.Header.Set("Sec-Ch-Ua-Mobile", "?0")
		req.Header.Set("Sec-Ch-Ua-Platform", profile.SecChUaPlatform)
	}

	// Accept 头
	if isSessionRequest {
		req.Header.Set("Accept", profile.Accept)
		req.Header.Set("Sec-Fetch-Dest", "document")
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Sec-Fetch-Site", "none")
		req.Header.Set("Sec-Fetch-User", "?1")
		req.Header.Set("Upgrade-Insecure-Requests", "1")
	} else {
		req.Header.Set("Accept", "*/*")
		req.Header.Set("Accept-Encoding", "gzip, deflate, br")
		req.Header.Set("Sec-Fetch-Dest", "empty")
		req.Header.Set("Sec-Fetch-Mode", "cors")
		req.Header.Set("Sec-Fetch-Site", "same-site")
	}

	// 通用 Headers
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Pragma", "no-cache")

	// 随机添加一些可选 Headers（增加真实性）
	if rng.Float32() < 0.5 {
		req.Header.Set("DNT", "1") // Do Not Track
	}
}

// 安全的字符串截取
func safeSubstring(s string, length int) string {
	if len(s) <= length {
		return s
	}
	return s[:length]
}

// 验证 URL 是否允许访问
func isAllowedURL(targetURL string) error {
	parsedURL, err := url.Parse(targetURL)
	if err != nil {
		return fmt.Errorf("无效的 URL: %w", err)
	}

	if parsedURL.Scheme != "https" {
		return fmt.Errorf("只允许 HTTPS 协议")
	}

	if !allowedDomains[parsedURL.Host] {
		return fmt.Errorf("域名不在白名单中: %s", parsedURL.Host)
	}

	return nil
}

// HTTP 代理处理器
func proxyHandler(w http.ResponseWriter, r *http.Request) {
	// 检查是否正在关闭
	if shutdownFlag.Load() {
		http.Error(w, "Server is shutting down", http.StatusServiceUnavailable)
		return
	}

	activeRequests.Add(1)
	defer activeRequests.Add(-1)

	startTime := time.Now()
	stats.totalRequests.Add(1)

	targetURL := r.URL.Query().Get("url")
	ipv6 := r.URL.Query().Get("ipv6")

	if targetURL == "" {
		http.Error(w, "Missing 'url' parameter", http.StatusBadRequest)
		return
	}

	// 验证 URL
	if err := isAllowedURL(targetURL); err != nil {
		log.Printf("❌ URL 验证失败: %v", err)
		http.Error(w, "Invalid URL", http.StatusBadRequest)
		stats.failedRequests.Add(1)
		return
	}

	// 验证 IPv6 地址
	if ipv6 != "" {
		if _, err := net.ResolveIPAddr("ip6", ipv6); err != nil {
			log.Printf("❌ 无效的 IPv6 地址: %s", ipv6)
			http.Error(w, "Invalid IPv6 address", http.StatusBadRequest)
			stats.failedRequests.Add(1)
			return
		}

		// 检查熔断器状态
		if isCircuitOpen(ipv6) {
			log.Printf("⛔ [%s] 熔断器已打开，拒绝请求", ipv6[:min(20, len(ipv6))])
			http.Error(w, "IPv6 circuit breaker open", http.StatusServiceUnavailable)
			stats.failedRequests.Add(1)
			return
		}
	}

	// 使用该 IPv6 固定的浏览器指纹
	profile := getBrowserProfileForIPv6(ipv6)

	// 获取客户端（优先从缓存获取）
	var client *http.Client

	if ipv6 != "" {
		// 有 IPv6：从缓存获取或创建（会自动缓存）
		var err error
		client, err = getOrCreateIPv6Client(ipv6)
		if err != nil {
			log.Printf("❌ 获取 IPv6 客户端失败: %v", err)
			http.Error(w, "IPv6 client creation failed", http.StatusInternalServerError)
			stats.failedRequests.Add(1)
			return
		}
	} else {
		// 无 IPv6：使用通用连接池
		client = clientPool.Get().(*http.Client)
		defer clientPool.Put(client)
	}

	// 刷新会话（针对 kh.google.com）
	parsedURL, _ := url.Parse(targetURL)
	needsSession := parsedURL.Host == "kh.google.com"

	if needsSession {
		// 尝试刷新会话（内部会检查是否真的需要刷新）
		// 如果失败，使用旧 Cookie 继续（不重试，避免延迟）
		if err := refreshSession(ipv6, false); err != nil {
			// 只记录一次，不重试，使用旧 Cookie
			log.Printf("⚠️  会话刷新失败，使用旧 Cookie: %v", err)
		}
	}

	// 🎯 混合请求策略：95% 用 IP 池，5% 用域名刺探
	var finalURL string
	var usedIP string
	var useIPPool bool
	
	// 检查是否有该域名的 IP 池
	pool := dnsIPPools[parsedURL.Host]
	
	if pool != nil && pool.ShouldUseIPPool() {
		// 95% 情况：使用 IP 池（快速，无 DNS）
		ip := pool.GetRandomIP(pool.preferIPv6)
		if ip != "" {
			useIPPool = true
			usedIP = ip
			
			// 构建直接 IP 请求
			if strings.Contains(ip, ":") {
				// IPv6
				finalURL = fmt.Sprintf("https://[%s]:443%s?%s", ip, parsedURL.Path, parsedURL.RawQuery)
			} else {
				// IPv4
				finalURL = fmt.Sprintf("https://%s:443%s?%s", ip, parsedURL.Path, parsedURL.RawQuery)
			}
			
			log.Printf("🎯 [DNS-Pool] 使用 IP 池: %s", ip)
		} else {
			// IP 池空了，降级到域名
			finalURL = targetURL
			useIPPool = false
			log.Printf("⚠️  [DNS-Pool] IP 池为空，降级到域名")
		}
	} else {
		// 5% 情况或无 IP 池：使用域名（刺探新 IP）
		finalURL = targetURL
		useIPPool = false
		if pool != nil {
			log.Printf("🔍 [DNS-Pool] 刺探模式：使用域名请求")
		}
	}

	// 创建请求（使用配置的超时，并留出重试时间）
	requestContextTimeout := config.requestTimeout + time.Duration(config.maxRetries)*config.baseRetryDelay*8
	ctx, cancel := context.WithTimeout(context.Background(), requestContextTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", finalURL, nil)
	if err != nil {
		log.Printf("❌ 创建请求失败: %v", err)
		http.Error(w, "Request creation failed", http.StatusInternalServerError)
		stats.failedRequests.Add(1)
		return
	}
	
	// 关键：保持原域名作为 Host 头（即使使用了 IP）
	req.Host = parsedURL.Host

	// 使用随机浏览器指纹设置 Headers
	setHeaders(req, profile, false)

	// 关键：必须有 Referer 和 Origin
	if !strings.Contains(targetURL, "www.google.com") {
		req.Header.Set("Referer", "https://earth.google.com/")
		req.Header.Set("Origin", "https://earth.google.com")
	}

	// 获取该 IPv6 的 Session 并添加 Cookie
	session := getOrCreateSession(ipv6)

	// 更新最后访问时间
	session.mu.Lock()
	session.lastAccess = time.Now()
	cookies := session.cookies
	session.mu.Unlock()

	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}

	// 发送请求（支持多种错误的自动重试和指数退避）
	var resp *http.Response
	maxRetries := config.maxRetries
	baseDelay := config.baseRetryDelay
	hasRefreshedCookie := false // 标记是否已经刷新过 Cookie（403 时）

	for attempt := 0; attempt <= maxRetries; attempt++ {
		resp, err = client.Do(req)

		// 网络错误处理
		if err != nil {
			// 检查是否超时
			if strings.Contains(err.Error(), "timeout") ||
				strings.Contains(err.Error(), "deadline exceeded") {
				stats.timeoutCount.Add(1)
				log.Printf("⏱️  请求超时 (尝试 %d/%d): %v", attempt+1, maxRetries+1, err)
			} else {
				stats.networkErrorCount.Add(1)
				log.Printf("❌ 网络错误 (尝试 %d/%d): %v", attempt+1, maxRetries+1, err)
			}

			// 如果还有重试机会，等待后重试
			if attempt < maxRetries {
				delay := baseDelay * time.Duration(1<<uint(attempt)) // 指数退避: 100ms, 200ms, 400ms
				log.Printf("⏳ 等待 %v 后重试...", delay)
				time.Sleep(delay)

				// 重新创建请求
				req, _ = http.NewRequestWithContext(ctx, "GET", targetURL, nil)
				setHeaders(req, profile, false)
				if !strings.Contains(targetURL, "www.google.com") {
					req.Header.Set("Referer", "https://earth.google.com/")
					req.Header.Set("Origin", "https://earth.google.com")
				}
				session.mu.RLock()
				for _, cookie := range session.cookies {
					req.AddCookie(cookie)
				}
				session.mu.RUnlock()
				continue
			}

			// 重试次数用尽
			http.Error(w, "Request failed after retries", http.StatusBadGateway)
			stats.failedRequests.Add(1)
			recordRequestResult(ipv6, false) // 记录失败到熔断器
			return
		}

		// HTTP 错误码处理
		statusCode := resp.StatusCode

		// 403 Forbidden - 刷新 Cookie 重试（只刷新一次，避免死循环）
		if statusCode == 403 && needsSession {
			stats.error403Count.Add(1)
			resp.Body.Close()

			// 如果还没刷新过 Cookie，尝试刷新
			if !hasRefreshedCookie && attempt < maxRetries {
				log.Printf("⚠️  收到 403 (尝试 %d/%d)，Cookie 可能失效，立即刷新并重试...", attempt+1, maxRetries+1)

				if err := refreshSession(ipv6, true); err != nil {
					log.Printf("❌ 强制刷新会话失败: %v", err)
					http.Error(w, "Session refresh failed", http.StatusServiceUnavailable)
					stats.failedRequests.Add(1)
					recordRequestResult(ipv6, false) // 记录失败到熔断器
					return
				}

				hasRefreshedCookie = true // 标记已刷新

				// 重新创建请求
				req, _ = http.NewRequestWithContext(ctx, "GET", targetURL, nil)
				setHeaders(req, profile, false)
				if !strings.Contains(targetURL, "www.google.com") {
					req.Header.Set("Referer", "https://earth.google.com/")
					req.Header.Set("Origin", "https://earth.google.com")
				}
				session.mu.RLock()
				for _, cookie := range session.cookies {
					req.AddCookie(cookie)
				}
				session.mu.RUnlock()

				log.Printf("🔄 使用新 Cookie 重试请求...")
				continue
			}

			// 已刷新过或无重试机会
			log.Printf("❌ 403 错误，Cookie 刷新后仍然失败")
			http.Error(w, "Forbidden after refresh", http.StatusForbidden)
			stats.failedRequests.Add(1)
			recordRequestResult(ipv6, false)
			return
		}

		// 429 Too Many Requests - 指数退避重试
		if statusCode == 429 {
			stats.error429Count.Add(1)
			resp.Body.Close()

			if attempt < maxRetries {
				// 检查 Retry-After 头
				retryAfter := resp.Header.Get("Retry-After")
				var delay time.Duration
				if retryAfter != "" {
					// 尝试解析 Retry-After（秒数）
					if seconds, err := strconv.Atoi(retryAfter); err == nil {
						delay = time.Duration(seconds) * time.Second
					} else {
						delay = baseDelay * time.Duration(1<<uint(attempt))
					}
				} else {
					delay = baseDelay * time.Duration(1<<uint(attempt+2)) // 429 使用更长的退避: 400ms, 800ms, 1600ms
				}

				log.Printf("⚠️  收到 429 (Too Many Requests)，等待 %v 后重试 (尝试 %d/%d)...", delay, attempt+1, maxRetries+1)
				time.Sleep(delay)

				// 重新创建请求
				req, _ = http.NewRequestWithContext(ctx, "GET", targetURL, nil)
				setHeaders(req, profile, false)
				if !strings.Contains(targetURL, "www.google.com") {
					req.Header.Set("Referer", "https://earth.google.com/")
					req.Header.Set("Origin", "https://earth.google.com")
				}
				session.mu.RLock()
				for _, cookie := range session.cookies {
					req.AddCookie(cookie)
				}
				session.mu.RUnlock()
				continue
			}

			log.Printf("❌ 429 错误，重试次数用尽")
			http.Error(w, "Too many requests", http.StatusTooManyRequests)
			stats.failedRequests.Add(1)
			recordRequestResult(ipv6, false) // 记录失败到熔断器
			return
		}

		// 503 Service Unavailable - 短暂等待重试
		if statusCode == 503 {
			stats.error503Count.Add(1)
			resp.Body.Close()

			if attempt < maxRetries {
				delay := baseDelay * time.Duration(1<<uint(attempt+1)) // 200ms, 400ms, 800ms
				log.Printf("⚠️  收到 503 (Service Unavailable)，等待 %v 后重试 (尝试 %d/%d)...", delay, attempt+1, maxRetries+1)
				time.Sleep(delay)

				// 重新创建请求
				req, _ = http.NewRequestWithContext(ctx, "GET", targetURL, nil)
				setHeaders(req, profile, false)
				if !strings.Contains(targetURL, "www.google.com") {
					req.Header.Set("Referer", "https://earth.google.com/")
					req.Header.Set("Origin", "https://earth.google.com")
				}
				session.mu.RLock()
				for _, cookie := range session.cookies {
					req.AddCookie(cookie)
				}
				session.mu.RUnlock()
				continue
			}

			log.Printf("❌ 503 错误，重试次数用尽")
			http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
			stats.failedRequests.Add(1)
			recordRequestResult(ipv6, false) // 记录失败到熔断器
			return
		}

		// 其他 5xx 错误 - 短暂等待重试
		if statusCode >= 500 && statusCode < 600 {
			stats.error5xxCount.Add(1)
			resp.Body.Close()

			if attempt < maxRetries {
				delay := baseDelay * time.Duration(1<<uint(attempt)) // 100ms, 200ms, 400ms
				log.Printf("⚠️  收到 %d 错误，等待 %v 后重试 (尝试 %d/%d)...", statusCode, delay, attempt+1, maxRetries+1)
				time.Sleep(delay)

				// 重新创建请求
				req, _ = http.NewRequestWithContext(ctx, "GET", targetURL, nil)
				setHeaders(req, profile, false)
				if !strings.Contains(targetURL, "www.google.com") {
					req.Header.Set("Referer", "https://earth.google.com/")
					req.Header.Set("Origin", "https://earth.google.com")
				}
				session.mu.RLock()
				for _, cookie := range session.cookies {
					req.AddCookie(cookie)
				}
				session.mu.RUnlock()
				continue
			}

			log.Printf("❌ %d 错误，重试次数用尽", statusCode)
			http.Error(w, fmt.Sprintf("Server error: %d", statusCode), statusCode)
			stats.failedRequests.Add(1)
			recordRequestResult(ipv6, false) // 记录失败到熔断器
			return
		}

		// 成功或其他错误码（2xx, 3xx, 4xx 除了 403/429），跳出循环
		break
	}
	defer resp.Body.Close()

	// 读取响应体
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("❌ 读取响应失败: %v", err)
		http.Error(w, "Failed to read response", http.StatusInternalServerError)
		stats.failedRequests.Add(1)
		recordRequestResult(ipv6, false) // 记录失败到熔断器
		return
	}

	// 解压 gzip
	if resp.Header.Get("Content-Encoding") == "gzip" {
		body, err = decompressGzip(body)
		if err != nil {
			log.Printf("❌ 解压失败: %v", err)
			http.Error(w, "Failed to decompress response", http.StatusInternalServerError)
			stats.failedRequests.Add(1)
			recordRequestResult(ipv6, false) // 记录失败到熔断器
			return
		}
	}

	duration := time.Since(startTime)
	stats.successRequests.Add(1)

	// 记录成功结果到熔断器
	recordRequestResult(ipv6, true)

	// 🎯 记录 IP 池请求结果
	if useIPPool && usedIP != "" && pool != nil {
		pool.RecordResult(usedIP, resp.StatusCode, duration)
	}
	
	// 🔍 域名请求：提取实际连接的 IP（新发现的 IP）
	if !useIPPool && pool != nil && resp != nil {
		// TODO: 从连接信息中提取实际 IP（Go 标准库不容易获取）
		// 可以通过 resp.Request.RemoteAddr 或其他方式
	}

	ipv6Display := safeSubstring(ipv6, 20)
	if ipv6Display == "" {
		ipv6Display = "default"
	}
	urlDisplay := safeSubstring(targetURL, 60)

	if useIPPool {
		log.Printf("✅ [%s] [%s] [IP池:%s] %d - %s (%dms, %d bytes)",
			ipv6Display, profile.Name, usedIP, resp.StatusCode, urlDisplay,
			duration.Milliseconds(), len(body))
	} else {
		log.Printf("✅ [%s] [%s] %d - %s (%dms, %d bytes)",
			ipv6Display, profile.Name, resp.StatusCode, urlDisplay,
			duration.Milliseconds(), len(body))
	}

	// 返回响应
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Status-Code", strconv.Itoa(resp.StatusCode))
	w.Header().Set("X-Duration-Ms", strconv.FormatInt(duration.Milliseconds(), 10))
	w.Header().Set("X-Browser-Profile", profile.Name)

	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add("X-Origin-"+key, value)
		}
	}

	w.WriteHeader(http.StatusOK)
	w.Write(body)
}

// 健康检查处理器
// 初始化 DNS IP 池
func initializeDNSIPPools() {
	log.Printf("🔍 [DNS-Pool] 初始化 DNS IP 池...")

	// kh.google.com IP 池
	khPool := NewDNSIPPool(
		"kh.google.com",
		[]string{
			"142.250.105.93",
			"142.250.105.190",
			"142.250.105.136",
			"142.250.105.91",
		},
		[]string{
			"2607:f8b0:4002:c1b::be",
			"2607:f8b0:4002:c1b::5b",
			"2607:f8b0:4002:c1b::88",
			"2607:f8b0:4002:c1b::5d",
		},
		true, // 优先 IPv6
	)

	// earth.google.com IP 池
	earthPool := NewDNSIPPool(
		"earth.google.com",
		[]string{}, // 启动时通过 DNS 解析
		[]string{},
		false, // 优先 IPv4
	)

	dnsIPPools["kh.google.com"] = khPool
	dnsIPPools["earth.google.com"] = earthPool

	// 并发初始化所有池子（刺探 IP）
	var wg sync.WaitGroup
	for domain, pool := range dnsIPPools {
		wg.Add(1)
		go func(d string, p *DNSIPPool) {
			defer wg.Done()
			if err := p.InitializeOnStartup(); err != nil {
				log.Printf("⚠️  [DNS-Pool] %s 初始化失败: %v", d, err)
			}
			// 启动后台任务
			p.StartBackgroundTasks()
		}(domain, pool)
	}

	wg.Wait()
	log.Printf("✅ [DNS-Pool] DNS IP 池初始化完成")
}

// IP 池状态端点
func ipPoolHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	poolsData := make(map[string]interface{})
	for domain, pool := range dnsIPPools {
		poolsData[domain] = pool.GetStats()
	}

	data, _ := json.Marshal(poolsData)
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

// 健康检查处理器
func healthHandler(w http.ResponseWriter, r *http.Request) {
	uptime := time.Since(stats.startTime)
	total := stats.totalRequests.Load()
	success := stats.successRequests.Load()
	failed := stats.failedRequests.Load()
	error403 := stats.error403Count.Load()
	error429 := stats.error429Count.Load()
	error503 := stats.error503Count.Load()
	error5xx := stats.error5xxCount.Load()
	timeoutErr := stats.timeoutCount.Load()
	networkErr := stats.networkErrorCount.Load()
	sessionRefresh := stats.sessionRefreshCount.Load()

	var successRate float64
	if total > 0 {
		successRate = float64(success) / float64(total) * 100
	}

	// 统计所有 Session 的信息
	var totalCookies int64
	var totalSessions int64
	var oldestRefresh time.Time
	var earliestExpiry time.Time

	sessionManager.Range(func(key, value interface{}) bool {
		session := value.(*CookieSession)
		session.mu.RLock()
		totalCookies += int64(len(session.cookies))

		// 记录最旧的刷新时间
		if oldestRefresh.IsZero() || session.lastUpdate.Before(oldestRefresh) {
			oldestRefresh = session.lastUpdate
		}

		// 记录最早的过期时间
		if !session.earliestExpiry.IsZero() {
			if earliestExpiry.IsZero() || session.earliestExpiry.Before(earliestExpiry) {
				earliestExpiry = session.earliestExpiry
			}
		}
		session.mu.RUnlock()

		totalSessions++
		return true
	})

	// 计算 Cookie 剩余有效时间
	var cookieValidSeconds int64
	if !earliestExpiry.IsZero() {
		remaining := time.Until(earliestExpiry).Seconds()
		if remaining > 0 {
			cookieValidSeconds = int64(remaining)
		}
	}

	// 统计浏览器使用情况
	browserUsage := make(map[string]int64)
	stats.browserUsage.Range(func(key, value interface{}) bool {
		browserUsage[key.(string)] = value.(*atomic.Int64).Load()
		return true
	})

	// 统计 IPv6 客户端缓存数量
	var ipv6ClientCount int64
	ipv6ClientCache.Range(func(key, value interface{}) bool {
		ipv6ClientCount++
		return true
	})

	// 当前并发刷新数（智能调整的值）
	currentConcurrency := currentMaxConcurrentRefresh.Load()
	activeRefreshCount := int32(len(sessionRefreshSem))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	// 构建浏览器使用统计
	browserStats := "{"
	first := true
	for name, count := range browserUsage {
		if !first {
			browserStats += ", "
		}
		browserStats += fmt.Sprintf(`"%s": %d`, name, count)
		first = false
	}
	browserStats += "}"

	fmt.Fprintf(w, `{
	"status": "ok",
	"uptime": %.0f,
	"totalRequests": %d,
	"successRequests": %d,
	"failedRequests": %d,
	"successRate": "%.2f%%",
	"errors": {
		"error403": %d,
		"error429": %d,
		"error503": %d,
		"error5xx": %d,
		"timeout": %d,
		"network": %d
	},
	"session": {
		"totalSessions": %d,
		"totalCookies": %d,
		"oldestRefresh": "%s",
		"earliestExpiry": "%s",
		"cookieValidSeconds": %d,
		"sessionRefreshCount": %d
	},
	"clientPool": {
		"ipv6ClientsCached": %d
	},
	"concurrencyControl": {
		"currentMaxConcurrent": %d,
		"activeRefreshCount": %d,
		"minConcurrent": %d,
		"maxConcurrent": %d
	},
	"browserProfiles": {
		"available": %d,
		"usage": %s
	}
}`,
		uptime.Seconds(),
		total,
		success,
		failed,
		successRate,
		error403,
		error429,
		error503,
		error5xx,
		timeoutErr,
		networkErr,
		totalSessions,
		totalCookies,
		oldestRefresh.Format(time.RFC3339),
		earliestExpiry.Format(time.RFC3339),
		cookieValidSeconds,
		sessionRefresh,
		ipv6ClientCount,
		currentConcurrency,
		activeRefreshCount,
		config.minConcurrentRefresh,
		config.maxConcurrentRefresh,
		len(browserProfiles),
		browserStats,
	)
}

func main() {
	port := os.Getenv("UTLS_PROXY_PORT")
	if port == "" {
		port = "8765"
	}

	http.HandleFunc("/proxy", proxyHandler)
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/ip-pool", ipPoolHandler)

	server := &http.Server{
		Addr:         ":" + port,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// 启动信号监听（优雅关闭）
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// 初始化 DNS IP 池
	initializeDNSIPPools()

	// 启动定期资源清理任务
	go startResourceCleanup()

	// 启动并发数动态调整任务
	go startConcurrencyAdjustment()

	// 启动日志轮转任务
	go startLogRotation()

	// 在 goroutine 中启动服务器
	go func() {
		log.Printf("🚀 uTLS Proxy Server starting on :%s", port)
		log.Printf("📦 uTLS 版本: v1.8.1 (github.com/refraction-networking/utls)")
		log.Printf("🎭 浏览器指纹库: %d 种官方支持的配置", len(browserProfiles))
		log.Printf("🌐 代理端点: http://localhost:%s/proxy?url=<URL>&ipv6=<IPv6>", port)
		log.Printf("💚 健康检查: http://localhost:%s/health", port)
		log.Printf("📡 IP 池状态: http://localhost:%s/ip-pool", port)

		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("❌ Server failed: %v", err)
		}
	}()

	// 等待关闭信号
	sig := <-sigChan
	log.Printf("🛑 收到信号: %v，开始优雅关闭...", sig)

	// 设置关闭标志，拒绝新请求
	shutdownFlag.Store(true)
	log.Printf("✓ 已停止接受新请求")

	// 等待现有请求完成（最多等待 30 秒）
	log.Printf("⏳ 等待 %d 个活跃请求完成...", activeRequests.Load())
	shutdownTimeout := 30 * time.Second
	deadline := time.Now().Add(shutdownTimeout)

	for activeRequests.Load() > 0 && time.Now().Before(deadline) {
		remaining := activeRequests.Load()
		log.Printf("⏳ 还有 %d 个请求正在处理...", remaining)
		time.Sleep(500 * time.Millisecond)
	}

	if activeRequests.Load() > 0 {
		log.Printf("⚠️  超时，仍有 %d 个请求未完成，强制关闭", activeRequests.Load())
	} else {
		log.Printf("✓ 所有请求已完成")
	}

	// 关闭 HTTP 服务器
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("❌ 服务器关闭失败: %v", err)
	}

	log.Printf("✓ 服务器已优雅关闭")
	log.Printf("📊 最终统计:")
	log.Printf("  - 总请求数: %d", stats.totalRequests.Load())
	log.Printf("  - 成功: %d", stats.successRequests.Load())
	log.Printf("  - 失败: %d", stats.failedRequests.Load())
	log.Printf("  - Session 刷新次数: %d", stats.sessionRefreshCount.Load())

	// 关闭日志文件
	if logFileHandle != nil {
		logFileHandle.Close()
	}
}

// 定期调整并发刷新数
func startConcurrencyAdjustment() {
	ticker := time.NewTicker(1 * time.Minute) // 每分钟调整一次
	defer ticker.Stop()

	log.Printf("🎚️  并发数自动调整任务已启动（每 1 分钟）")

	for range ticker.C {
		if shutdownFlag.Load() {
			break
		}

		oldConcurrency := currentMaxConcurrentRefresh.Load()
		newConcurrency := calculateOptimalConcurrency()

		if oldConcurrency != newConcurrency {
			currentMaxConcurrentRefresh.Store(newConcurrency)
			log.Printf("🎚️  并发数已调整: %d → %d", oldConcurrency, newConcurrency)
		}
	}
}

// 定期资源清理任务
func startResourceCleanup() {
	ticker := time.NewTicker(config.resourceCleanInterval)
	defer ticker.Stop()

	log.Printf("🗑️  资源清理任务已启动（每 %v）", config.resourceCleanInterval)

	for range ticker.C {
		if shutdownFlag.Load() {
			break
		}

		cleanupExpiredResources()
	}
}

// 清理过期的 Session 和 Client
func cleanupExpiredResources() {
	now := time.Now()
	inactiveThreshold := config.sessionInactiveTime

	var cleanedSessions int
	var cleanedClients int
	var toDelete []string

	// 1. 清理过期的 Session
	sessionManager.Range(func(key, value interface{}) bool {
		ipv6 := key.(string)
		session := value.(*CookieSession)

		session.mu.RLock()
		lastAccess := session.lastAccess
		session.mu.RUnlock()

		// 超过 30 分钟未访问，标记删除
		if now.Sub(lastAccess) > inactiveThreshold {
			toDelete = append(toDelete, ipv6)
		}

		return true
	})

	// 执行删除
	for _, ipv6 := range toDelete {
		sessionManager.Delete(ipv6)
		cleanedSessions++
		log.Printf("🗑️  清理过期 Session: %s (%v 未使用)", ipv6[:min(20, len(ipv6))], config.sessionInactiveTime)
	}

	// 2. 清理对应的 Client（Session 已删除的）
	toDelete = toDelete[:0] // 重置切片

	ipv6ClientCache.Range(func(key, value interface{}) bool {
		ipv6 := key.(string)

		// 如果 Session 已被删除，也删除对应的 Client
		if _, exists := sessionManager.Load(ipv6); !exists {
			toDelete = append(toDelete, ipv6)
		}

		return true
	})

	for _, ipv6 := range toDelete {
		ipv6ClientCache.Delete(ipv6)
		cleanedClients++
		log.Printf("🗑️  清理过期 Client: %s", ipv6[:min(20, len(ipv6))])
	}

	// 3. 清理浏览器指纹映射（Session 已删除的）
	toDelete = toDelete[:0]

	browserProfileMap.Range(func(key, value interface{}) bool {
		ipv6 := key.(string)

		if _, exists := sessionManager.Load(ipv6); !exists {
			toDelete = append(toDelete, ipv6)
		}

		return true
	})

	for _, ipv6 := range toDelete {
		browserProfileMap.Delete(ipv6)
	}

	if cleanedSessions > 0 || cleanedClients > 0 {
		log.Printf("✓ 资源清理完成：%d 个 Session，%d 个 Client", cleanedSessions, cleanedClients)
	}
}
