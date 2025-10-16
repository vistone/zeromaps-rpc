package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"math/rand"
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
	cookies    []*http.Cookie
	lastUpdate time.Time
	mu         sync.RWMutex
}

// 统计信息
type Stats struct {
	totalRequests       atomic.Int64
	successRequests     atomic.Int64
	failedRequests      atomic.Int64
	sessionRefreshCount atomic.Int64
	startTime           time.Time
	browserUsage        sync.Map // 记录每个浏览器的使用次数
}

var (
	globalSession  = &CookieSession{}
	stats          = &Stats{startTime: time.Now()}
	clientPool     sync.Pool
	allowedDomains = map[string]bool{
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
)

// 初始化
func init() {
	rng = rand.New(rand.NewSource(time.Now().UnixNano()))

	clientPool = sync.Pool{
		New: func() interface{} {
			return createUTLSClient()
		},
	}

	log.Printf("🎭 uTLS 浏览器指纹库已加载: %d 种配置（基于 uTLS v1.8.1）", len(browserProfiles))
	for i, profile := range browserProfiles {
		log.Printf("  [%d] %s", i+1, profile.Name)
	}
}

// 随机选择浏览器指纹
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
		Timeout:   30 * time.Second,
		Transport: transport,
	}
}

// 创建带 IPv6 绑定的客户端（使用随机浏览器指纹）
func createUTLSClientWithIPv6(ipv6 string) (*http.Client, error) {
	localAddr, err := net.ResolveIPAddr("ip6", ipv6)
	if err != nil {
		return nil, fmt.Errorf("无效的 IPv6 地址: %w", err)
	}

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
	globalSession.mu.Lock()
	defer globalSession.mu.Unlock()

	// 检查会话是否有效（5分钟内不重复刷新）
	if time.Since(globalSession.lastUpdate) < 5*time.Minute && len(globalSession.cookies) > 0 {
		remaining := (5*time.Minute - time.Since(globalSession.lastUpdate)).Seconds()
		log.Printf("✓ 使用缓存的会话 Cookie（%d 个，剩余 %.0f 秒）",
			len(globalSession.cookies), remaining)
		return nil
	}

	log.Printf("🔄 刷新会话：访问 earth.google.com...")

	// 随机选择浏览器指纹用于会话刷新
	profile := getRandomBrowserProfile()
	log.Printf("🎭 使用浏览器指纹: %s", profile.Name)

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

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
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

	globalSession.cookies = cookies
	globalSession.lastUpdate = time.Now()
	stats.sessionRefreshCount.Add(1)

	log.Printf("✓ 会话已刷新，获得 %d 个 Cookie", len(cookies))
	for _, cookie := range cookies {
		log.Printf("  - %s=%s...", cookie.Name, safeSubstring(cookie.Value, 20))
	}

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
	}

	// 随机选择浏览器指纹
	profile := getRandomBrowserProfile()

	// 获取客户端
	var client *http.Client
	var shouldReturn bool

	if ipv6 != "" {
		var err error
		client, err = createUTLSClientWithIPv6(ipv6)
		if err != nil {
			log.Printf("❌ 创建 IPv6 客户端失败: %v", err)
			http.Error(w, "IPv6 client creation failed", http.StatusInternalServerError)
			stats.failedRequests.Add(1)
			return
		}
		shouldReturn = false
	} else {
		client = clientPool.Get().(*http.Client)
		shouldReturn = true
		defer func() {
			if shouldReturn {
				clientPool.Put(client)
			}
		}()
	}

	// 刷新会话（针对 kh.google.com）
	parsedURL, _ := url.Parse(targetURL)
	if parsedURL.Host == "kh.google.com" {
		for attempt := 1; attempt <= 3; attempt++ {
			if err := refreshSession(ipv6); err != nil {
				log.Printf("⚠️  会话刷新失败（尝试 %d/3）: %v", attempt, err)
				if attempt < 3 {
					time.Sleep(time.Duration(attempt) * time.Second)
					continue
				}
				log.Printf("⚠️  会话刷新连续失败，使用旧 Cookie")
			}
			break
		}
	}

	// 创建请求
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
	if err != nil {
		log.Printf("❌ 创建请求失败: %v", err)
		http.Error(w, "Request creation failed", http.StatusInternalServerError)
		stats.failedRequests.Add(1)
		return
	}

	// 使用随机浏览器指纹设置 Headers
	setHeaders(req, profile, false)

	// 关键：必须有 Referer 和 Origin
	if !strings.Contains(targetURL, "www.google.com") {
		req.Header.Set("Referer", "https://earth.google.com/")
		req.Header.Set("Origin", "https://earth.google.com")
	}

	// 添加会话 Cookie
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

	// 检测 403 自动清空会话
	if resp.StatusCode == 403 {
		log.Printf("⚠️  收到 403，Cookie 可能失效，强制刷新会话")
		globalSession.mu.Lock()
		globalSession.lastUpdate = time.Time{}
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

	// 解压 gzip
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

	ipv6Display := safeSubstring(ipv6, 20)
	if ipv6Display == "" {
		ipv6Display = "default"
	}
	urlDisplay := safeSubstring(targetURL, 60)

	log.Printf("✅ [%s] [%s] %d - %s (%dms, %d bytes)",
		ipv6Display, profile.Name, resp.StatusCode, urlDisplay,
		duration.Milliseconds(), len(body))

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

	// 统计浏览器使用情况
	browserUsage := make(map[string]int64)
	stats.browserUsage.Range(func(key, value interface{}) bool {
		browserUsage[key.(string)] = value.(*atomic.Int64).Load()
		return true
	})

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
	"session": {
		"cookieCount": %d,
		"lastRefresh": "%s",
		"sessionRefreshCount": %d
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
		cookieCount,
		lastRefresh.Format(time.RFC3339),
		sessionRefresh,
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

	log.Printf("🚀 uTLS Proxy Server starting on :%s", port)
	log.Printf("📦 uTLS 版本: v1.8.1 (github.com/refraction-networking/utls)")
	log.Printf("🎭 浏览器指纹库: %d 种官方支持的配置", len(browserProfiles))
	log.Printf("🌐 代理端点: http://localhost:%s/proxy?url=<URL>&ipv6=<IPv6>", port)
	log.Printf("💚 健康检查: http://localhost:%s/health", port)

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("❌ Server failed: %v", err)
	}
}
