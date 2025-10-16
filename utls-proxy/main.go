package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

// Cookie 会话管理
type CookieSession struct {
	cookies    []*http.Cookie
	lastUpdate time.Time
	mu         sync.RWMutex
}

// 统计信息
type Stats struct {
	totalRequests   atomic.Int64
	successRequests atomic.Int64
	failedRequests  atomic.Int64
	sessionRefreshCount atomic.Int64
	startTime       time.Time
}

var (
	globalSession = &CookieSession{}
	stats         = &Stats{startTime: time.Now()}
	clientPool    sync.Pool  // 客户端连接池
	allowedDomains = map[string]bool{
		"kh.google.com":    true,
		"earth.google.com": true,
		"www.google.com":   true,
	}
)

// 初始化客户端池
func init() {
	clientPool = sync.Pool{
		New: func() interface{} {
			return createUTLSClient()
		},
	}
}

// 创建可复用的 uTLS 客户端（无 IPv6 绑定）
func createUTLSClient() *http.Client {
	// 创建 HTTP/2 Transport（支持连接复用）
	transport := &http2.Transport{
		AllowHTTP: false,
		// 连接池配置
		MaxHeaderListSize: 262144,
		ReadIdleTimeout:   60 * time.Second,
		PingTimeout:       15 * time.Second,
		
		DialTLS: func(network, addr string, cfg *tls.Config) (net.Conn, error) {
			// 使用默认 dialer（不绑定 IPv6）
			dialer := &net.Dialer{
				Timeout:   10 * time.Second,
				KeepAlive: 30 * time.Second,
			}

			// 建立 TCP 连接
			rawConn, err := dialer.Dial("tcp", addr)
			if err != nil {
				return nil, fmt.Errorf("TCP 连接失败: %w", err)
			}

			// 使用 uTLS 模拟 Chrome 120 的 TLS 指纹
			tlsConfig := &utls.Config{
				ServerName:         getHostFromAddr(addr),
				InsecureSkipVerify: false,  // 修复：验证证书
				MinVersion:         tls.VersionTLS12,
				NextProtos:         []string{"h2", "http/1.1"},
			}

			tlsConn := utls.UClient(rawConn, tlsConfig, utls.HelloChrome_120)

			// 执行 TLS 握手
			err = tlsConn.Handshake()
			if err != nil {
				rawConn.Close()
				return nil, fmt.Errorf("TLS 握手失败: %w", err)
			}

			return tlsConn, nil
		},
	}

	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: transport,
	}
}

// 创建带 IPv6 绑定的客户端（用于特定请求）
func createUTLSClientWithIPv6(ipv6 string) (*http.Client, error) {
	// 验证 IPv6 地址
	localAddr, err := net.ResolveIPAddr("ip6", ipv6)
	if err != nil {
		return nil, fmt.Errorf("无效的 IPv6 地址: %w", err)
	}

	transport := &http2.Transport{
		AllowHTTP: false,
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

			tlsConn := utls.UClient(rawConn, tlsConfig, utls.HelloChrome_120)

			err = tlsConn.Handshake()
			if err != nil {
				rawConn.Close()
				return nil, fmt.Errorf("TLS 握手失败: %w", err)
			}

			return tlsConn, nil
		},
	}

	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: transport,
	}, nil
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

// 初始化或刷新会话（访问 earth.google.com 获取 Cookie）
func refreshSession(ipv6 string) error {
	// 单一锁保护（修复死锁问题）
	globalSession.mu.Lock()
	defer globalSession.mu.Unlock()

	// 检查会话是否有效（5分钟内不重复刷新）
	if time.Since(globalSession.lastUpdate) < 5*time.Minute && len(globalSession.cookies) > 0 {
		log.Printf("✓ 使用缓存的会话 Cookie（%d 个，剩余 %.0f 秒）", 
			len(globalSession.cookies), 
			(5*time.Minute - time.Since(globalSession.lastUpdate)).Seconds())
		return nil
	}

	log.Printf("🔄 刷新会话：访问 earth.google.com...")

	// 获取或创建客户端
	var client *http.Client
	var err error
	
	if ipv6 != "" {
		client, err = createUTLSClientWithIPv6(ipv6)
		if err != nil {
			log.Printf("⚠️  创建 IPv6 客户端失败，使用默认客户端: %v", err)
			client = clientPool.Get().(*http.Client)
			defer clientPool.Put(client)
		}
	} else {
		client = clientPool.Get().(*http.Client)
		defer clientPool.Put(client)
	}

	// 创建带超时的上下文
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// 访问 Google Earth 主页建立会话
	req, err := http.NewRequestWithContext(ctx, "GET", "https://earth.google.com/web/", nil)
	if err != nil {
		return fmt.Errorf("创建会话请求失败: %w", err)
	}

	// 设置基本 Headers
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Sec-Ch-Ua", `"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`)
	req.Header.Set("Sec-Ch-Ua-Mobile", "?0")
	req.Header.Set("Sec-Ch-Ua-Platform", `"Windows"`)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("会话请求失败: %w", err)
	}
	defer resp.Body.Close()

	// 检查响应状态
	if resp.StatusCode != 200 {
		return fmt.Errorf("会话请求失败: HTTP %d", resp.StatusCode)
	}

	// 读取并丢弃响应体（我们只要 Cookie）
	io.Copy(io.Discard, resp.Body)

	// 保存 Cookie
	cookies := resp.Cookies()
	if len(cookies) == 0 {
		return fmt.Errorf("未获取到 Cookie")
	}

	globalSession.cookies = cookies
	globalSession.lastUpdate = time.Now()
	stats.sessionRefreshCount.Add(1)

	log.Printf("✓ 会话已刷新，获得 %d 个 Cookie", len(cookies))
	for _, cookie := range cookies {
		log.Printf("  - %s=%s...", cookie.Name, safeSubstring(cookie.Value, 20))
	}

	return nil
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

	// 必须是 HTTPS
	if parsedURL.Scheme != "https" {
		return fmt.Errorf("只允许 HTTPS 协议，当前: %s", parsedURL.Scheme)
	}

	// 检查域名白名单
	if !allowedDomains[parsedURL.Host] {
		return fmt.Errorf("域名不在白名单中: %s", parsedURL.Host)
	}

	return nil
}

// HTTP 代理处理器
func proxyHandler(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	stats.totalRequests.Add(1)

	// 获取参数
	targetURL := r.URL.Query().Get("url")
	ipv6 := r.URL.Query().Get("ipv6")

	if targetURL == "" {
		http.Error(w, "Missing 'url' parameter", http.StatusBadRequest)
		return
	}

	// 验证 URL（增强安全性）
	if err := isAllowedURL(targetURL); err != nil {
		log.Printf("❌ URL 验证失败: %v", err)
		http.Error(w, "Invalid URL", http.StatusBadRequest)
		stats.failedRequests.Add(1)
		return
	}

	// 验证 IPv6 地址格式（如果提供）
	if ipv6 != "" {
		if _, err := net.ResolveIPAddr("ip6", ipv6); err != nil {
			log.Printf("❌ 无效的 IPv6 地址: %s", ipv6)
			http.Error(w, "Invalid IPv6 address", http.StatusBadRequest)
			stats.failedRequests.Add(1)
			return
		}
	}

	// 获取客户端（从池中获取或创建新的）
	var client *http.Client
	var shouldReturn bool
	
	if ipv6 != "" {
		// 需要 IPv6 绑定，创建专用客户端
		var err error
		client, err = createUTLSClientWithIPv6(ipv6)
		if err != nil {
			log.Printf("❌ 创建 IPv6 客户端失败: %v", err)
			http.Error(w, "IPv6 client creation failed", http.StatusInternalServerError)
			stats.failedRequests.Add(1)
			return
		}
		shouldReturn = false  // IPv6 客户端不返回池
	} else {
		// 使用连接池
		client = clientPool.Get().(*http.Client)
		shouldReturn = true
		defer func() {
			if shouldReturn {
				clientPool.Put(client)
			}
		}()
	}

	// 检查是否需要刷新会话（针对 kh.google.com 的请求）
	parsedURL, _ := url.Parse(targetURL)
	if parsedURL.Host == "kh.google.com" {
		// 修复：带重试的会话刷新
		for attempt := 1; attempt <= 3; attempt++ {
			if err := refreshSession(ipv6); err != nil {
				log.Printf("⚠️  会话刷新失败（尝试 %d/3）: %v", attempt, err)
				if attempt == 3 {
					// 3次都失败，继续请求但记录警告
					log.Printf("⚠️  会话刷新连续失败，使用旧 Cookie（可能导致 403）")
				} else {
					time.Sleep(time.Duration(attempt) * time.Second)
					continue
				}
			}
			break
		}
	}

	// 创建带超时的请求
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
	if err != nil {
		log.Printf("❌ 创建请求失败: %v", err)
		http.Error(w, "Request creation failed", http.StatusInternalServerError)
		stats.failedRequests.Add(1)
		return
	}

	// 设置完整的 Google Earth Web 客户端 Headers
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")

	// 关键：必须有 Referer 和 Origin，否则会被识别为爬虫
	if !strings.Contains(targetURL, "www.google.com") {
		req.Header.Set("Referer", "https://earth.google.com/")
		req.Header.Set("Origin", "https://earth.google.com")
	}

	req.Header.Set("Sec-Fetch-Dest", "empty")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "same-site")
	req.Header.Set("Sec-Ch-Ua", `"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`)
	req.Header.Set("Sec-Ch-Ua-Mobile", "?0")
	req.Header.Set("Sec-Ch-Ua-Platform", `"Windows"`)
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Pragma", "no-cache")

	// 添加从 earth.google.com 获取的会话 Cookie
	globalSession.mu.RLock()
	for _, cookie := range globalSession.cookies {
		req.AddCookie(cookie)
	}
	globalSession.mu.RUnlock()

	// 发送请求
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("❌ 请求失败: %v", err)
		http.Error(w, "Request failed", http.StatusBadGateway)
		stats.failedRequests.Add(1)
		return
	}
	defer resp.Body.Close()

	// 检查是否需要刷新会话（403 表示 Cookie 失效）
	if resp.StatusCode == 403 {
		log.Printf("⚠️  收到 403，Cookie 可能失效，强制刷新会话")
		globalSession.mu.Lock()
		globalSession.lastUpdate = time.Time{}  // 清空时间，下次必定刷新
		globalSession.mu.Unlock()
	}

	// 读取响应体
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("❌ 读取响应失败: %v", err)
		http.Error(w, "Failed to read response", http.StatusInternalServerError)
		stats.failedRequests.Add(1)
		return
	}

	// 如果是 gzip 编码，解压
	if resp.Header.Get("Content-Encoding") == "gzip" {
		body, err = decompressGzip(body)
		if err != nil {
			log.Printf("❌ 解压失败: %v", err)
			http.Error(w, "Failed to decompress response", http.StatusInternalServerError)
			stats.failedRequests.Add(1)
			return
		}
	}

	duration := time.Since(startTime)
	stats.successRequests.Add(1)

	// 安全的日志输出
	ipv6Display := safeSubstring(ipv6, 20)
	if ipv6Display == "" {
		ipv6Display = "default"
	}
	urlDisplay := safeSubstring(targetURL, 60)

	log.Printf("✅ [%s] %d - %s (%dms, %d bytes)",
		ipv6Display, resp.StatusCode, urlDisplay, duration.Milliseconds(), len(body))

	// 返回响应
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Status-Code", strconv.Itoa(resp.StatusCode))
	w.Header().Set("X-Duration-Ms", strconv.FormatInt(duration.Milliseconds(), 10))

	// 复制原始响应头
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add("X-Origin-"+key, value)
		}
	}

	w.WriteHeader(http.StatusOK)
	w.Write(body)
}

// 健康检查处理器
func healthHandler(w http.ResponseWriter, r *http.Request) {
	uptime := time.Since(stats.startTime)
	total := stats.totalRequests.Load()
	success := stats.successRequests.Load()
	failed := stats.failedRequests.Load()
	sessionRefresh := stats.sessionRefreshCount.Load()
	
	var successRate float64
	if total > 0 {
		successRate = float64(success) / float64(total) * 100
	}

	globalSession.mu.RLock()
	cookieCount := len(globalSession.cookies)
	lastRefresh := globalSession.lastUpdate
	globalSession.mu.RUnlock()

	status := map[string]interface{}{
		"status":       "ok",
		"uptime":       uptime.Seconds(),
		"totalRequests": total,
		"successRequests": success,
		"failedRequests": failed,
		"successRate":  fmt.Sprintf("%.2f%%", successRate),
		"session": map[string]interface{}{
			"cookieCount":     cookieCount,
			"lastRefresh":     lastRefresh,
			"sessionRefreshCount": sessionRefresh,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{
		"status": "%s",
		"uptime": %.0f,
		"totalRequests": %d,
		"successRequests": %d,
		"failedRequests": %d,
		"successRate": "%.2f%%",
		"session": {
			"cookieCount": %d,
			"lastRefresh": "%s",
			"sessionRefreshCount": %d
		}
	}`,
		status["status"],
		uptime.Seconds(),
		total,
		success,
		failed,
		successRate,
		cookieCount,
		lastRefresh.Format(time.RFC3339),
		sessionRefresh,
	)
}

func main() {
	port := os.Getenv("UTLS_PROXY_PORT")
	if port == "" {
		port = "8765"
	}

	// 路由配置
	http.HandleFunc("/proxy", proxyHandler)
	http.HandleFunc("/health", healthHandler)

	log.Printf("🚀 uTLS Proxy Server starting on :%s", port)
	log.Printf("📋 模拟浏览器: Chrome 120")
	log.Printf("🌐 代理端点: http://localhost:%s/proxy?url=<URL>&ipv6=<IPv6>", port)
	log.Printf("💚 健康检查: http://localhost:%s/health", port)

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("❌ Server failed: %v", err)
	}
}
