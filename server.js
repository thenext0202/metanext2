require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const FacebookDownloader = require('./downloaders/facebook');
const InstagramDownloader = require('./downloaders/instagram');
const YouTubeDownloader = require('./downloaders/youtube');
const GoogleAdsDownloader = require('./downloaders/googleads');
const TranscribeService = require('./services/transcribe');
const apiKeyPool = require('./services/apiKeyPool');
const supabase = require('./services/supabase');

const app = express();
const PORT = process.env.PORT || 5000;

// 미들웨어
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 다운로드 폴더 생성
const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
}

// 다운로더 인스턴스
const facebookDownloader = new FacebookDownloader();
const instagramDownloader = new InstagramDownloader();
const youtubeDownloader = new YouTubeDownloader();
const googleAdsDownloader = new GoogleAdsDownloader();

// 메인 페이지
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 비밀번호 인증
const APP_PASSWORD = process.env.APP_PASSWORD || 'mincom0202';

app.post('/api/auth', (req, res) => {
    const { password } = req.body;
    if (password === APP_PASSWORD) {
        return res.json({ success: true });
    }
    return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
});

// 비디오 추출 API
app.post('/api/extract', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL이 필요합니다' });
    }

    const trimmedUrl = url.trim();

    try {
        let result = null;

        if (FacebookDownloader.isValidUrl(trimmedUrl)) {
            result = await facebookDownloader.extractVideoUrl(trimmedUrl);
        } else if (InstagramDownloader.isValidUrl(trimmedUrl)) {
            result = await instagramDownloader.extractVideoUrl(trimmedUrl);
        } else if (YouTubeDownloader.isValidUrl(trimmedUrl)) {
            result = await youtubeDownloader.extractVideoUrl(trimmedUrl);
        } else if (GoogleAdsDownloader.isValidUrl(trimmedUrl)) {
            // Google Ads에서 YouTube 비디오 추출
            const googleResult = await googleAdsDownloader.extractVideoUrl(trimmedUrl);
            if (googleResult && googleResult.isYouTube) {
                // YouTube 다운로더로 실제 비디오 URL 추출
                result = await youtubeDownloader.extractVideoUrl(googleResult.video_url);
                if (result) {
                    result.platform = 'googleads';
                }
            } else {
                result = googleResult;
            }
        } else {
            return res.status(400).json({
                error: '지원하지 않는 URL입니다. YouTube, Instagram, Facebook, Google Ads URL을 입력해주세요.'
            });
        }

        if (result) {
            return res.json({ success: true, data: result });
        } else {
            return res.status(404).json({
                error: '비디오를 추출할 수 없습니다. URL을 확인해주세요.'
            });
        }
    } catch (error) {
        console.error('추출 에러:', error);
        return res.status(500).json({ error: `서버 에러: ${error.message}` });
    }
});

// Instagram 쿠키 직접 저장 API
app.post('/api/instagram/cookie', async (req, res) => {
    const { sessionid } = req.body;

    if (!sessionid) {
        return res.status(400).json({ error: 'sessionid가 필요합니다' });
    }

    try {
        // Supabase에 저장 (Railway 배포용)
        if (supabase.enabled) {
            await supabase.setSession('instagram_sessionid', sessionid);
            console.log('[Server] Instagram sessionid Supabase에 저장 완료');
        }

        // 로컬 파일에도 저장 (로컬 개발용)
        const cookies = [
            {
                name: 'sessionid',
                value: sessionid,
                domain: '.instagram.com',
                path: '/',
                httpOnly: true,
                secure: true
            }
        ];
        const cookiesPath = path.join(__dirname, 'instagram_cookies.json');
        fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));

        console.log('[Server] Instagram sessionid 저장 완료');
        return res.json({ success: true, message: '쿠키가 저장되었습니다!' });
    } catch (error) {
        console.error('쿠키 저장 에러:', error);
        return res.status(500).json({ error: '쿠키 저장 실패' });
    }
});

// Instagram 로그인 상태 확인
app.get('/api/instagram/status', async (req, res) => {
    let isLoggedIn = false;

    // Supabase 확인
    if (supabase.enabled) {
        const session = await supabase.getSession('instagram_sessionid');
        if (session) isLoggedIn = true;
    }

    // 로컬 파일 확인
    if (!isLoggedIn) {
        const cookiesPath = path.join(__dirname, 'instagram_cookies.json');
        isLoggedIn = fs.existsSync(cookiesPath);
    }

    return res.json({
        loggedIn: isLoggedIn,
        message: isLoggedIn ? '로그인 상태입니다' : '로그인이 필요합니다'
    });
});

// Instagram 브라우저 로그인
app.post('/api/instagram/login', async (req, res) => {
    let browser = null;

    try {
        console.log('[Server] Instagram 로그인 창 열기...');

        browser = await puppeteer.launch({
            headless: false,  // 브라우저 창 보이게
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--lang=ko-KR'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 800 });

        // Instagram 로그인 페이지로 이동
        await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2' });

        console.log('[Server] 로그인 대기 중... (최대 5분)');

        // 로그인 완료 대기 (URL이 바뀌거나 sessionid 쿠키가 생길 때까지)
        let loggedIn = false;
        const maxWait = 300000; // 5분
        const startTime = Date.now();

        while (!loggedIn && (Date.now() - startTime) < maxWait) {
            await new Promise(r => setTimeout(r, 2000));

            // 현재 URL 확인
            const currentUrl = page.url();

            // 쿠키 확인
            const cookies = await page.cookies();
            const sessionCookie = cookies.find(c => c.name === 'sessionid');

            if (sessionCookie && sessionCookie.value) {
                console.log('[Server] sessionid 쿠키 발견!');
                loggedIn = true;

                // Supabase에 저장
                if (supabase.enabled) {
                    await supabase.setSession('instagram_sessionid', sessionCookie.value);
                }

                // 로컬 파일에도 저장
                const cookiesPath = path.join(__dirname, 'instagram_cookies.json');
                const cookieData = [
                    {
                        name: 'sessionid',
                        value: sessionCookie.value,
                        domain: '.instagram.com',
                        path: '/',
                        httpOnly: true,
                        secure: true
                    }
                ];
                fs.writeFileSync(cookiesPath, JSON.stringify(cookieData, null, 2));
                console.log('[Server] 쿠키 저장 완료');
            }

            // 로그인 페이지를 벗어났는지 확인
            if (!currentUrl.includes('/accounts/login') && !currentUrl.includes('/challenge')) {
                // 다시 쿠키 확인
                const cookies2 = await page.cookies();
                const sessionCookie2 = cookies2.find(c => c.name === 'sessionid');
                if (sessionCookie2 && sessionCookie2.value) {
                    loggedIn = true;

                    // Supabase에 저장
                    if (supabase.enabled) {
                        await supabase.setSession('instagram_sessionid', sessionCookie2.value);
                    }

                    // 로컬 파일에도 저장
                    const cookiesPath = path.join(__dirname, 'instagram_cookies.json');
                    const cookieData = [
                        {
                            name: 'sessionid',
                            value: sessionCookie2.value,
                            domain: '.instagram.com',
                            path: '/',
                            httpOnly: true,
                            secure: true
                        }
                    ];
                    fs.writeFileSync(cookiesPath, JSON.stringify(cookieData, null, 2));
                    console.log('[Server] 쿠키 저장 완료');
                }
            }
        }

        await browser.close();

        if (loggedIn) {
            return res.json({ success: true, message: '로그인 성공!' });
        } else {
            return res.json({ success: false, error: '로그인 시간 초과 또는 취소됨' });
        }

    } catch (error) {
        console.error('[Server] 로그인 에러:', error.message);
        if (browser) await browser.close();
        return res.status(500).json({ error: `로그인 실패: ${error.message}` });
    }
});

// 프록시 다운로드 API
app.get('/api/proxy-download', async (req, res) => {
    const { url, filename = 'video.mp4' } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL이 필요합니다' });
    }

    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 60000
        });

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        response.data.pipe(res);
    } catch (error) {
        console.error('다운로드 에러:', error.message);
        return res.status(500).json({ error: `다운로드 실패: ${error.message}` });
    }
});

// OpenAI API 키 풀 및 전사 서비스 초기화
const transcribeService = new TranscribeService();

async function initAPIKeyPool() {
    await apiKeyPool.loadKeys();
    const count = apiKeyPool.getKeyCount();
    if (count > 0) {
        console.log(`[Server] OpenAI Whisper 활성화됨 (${count}개의 API 키)`);
    } else {
        console.log('[Server] OpenAI API 키가 없습니다. 웹에서 등록하세요.');
    }
}
initAPIKeyPool();

// 음성 전사 API
app.post('/api/transcribe', async (req, res) => {
    const { videoUrl, language = 'ko', prompt = '' } = req.body;

    if (!videoUrl) {
        return res.status(400).json({ error: '비디오 URL이 필요합니다' });
    }

    if (apiKeyPool.getKeyCount() === 0) {
        return res.status(400).json({
            error: 'OpenAI API 키가 등록되지 않았습니다. API 키를 추가해주세요.'
        });
    }

    try {
        console.log('[Server] 전사 시작:', videoUrl.substring(0, 50) + '...');
        console.log('[Server] API 키 풀 상태:', apiKeyPool.getStatus());
        if (prompt) {
            console.log('[Server] Prompt 힌트:', prompt.substring(0, 100));
        }
        const result = await transcribeService.transcribe(videoUrl, language, prompt);
        return res.json(result);
    } catch (error) {
        console.error('[Server] 전사 에러:', error.message);
        return res.status(500).json({ error: `전사 실패: ${error.message}` });
    }
});

// API 키 상태 확인
app.get('/api/transcribe/status', (req, res) => {
    const status = apiKeyPool.getStatus();
    return res.json({
        available: status.total > 0,
        keyCount: status.total,
        inUse: status.inUse,
        message: status.total > 0
            ? `전사 기능 사용 가능 (API 키 ${status.total}개)`
            : 'OpenAI API 키를 등록하세요'
    });
});

// OpenAI API 키 추가
app.post('/api/openai/key', async (req, res) => {
    const { apiKey } = req.body;

    if (!apiKey) {
        return res.status(400).json({ error: 'API 키가 필요합니다' });
    }

    try {
        const count = await apiKeyPool.addKey(apiKey);
        console.log(`[Server] OpenAI API 키 추가됨 (총 ${count}개)`);
        return res.json({
            success: true,
            message: `API 키가 추가되었습니다! (총 ${count}개)`,
            keyCount: count
        });
    } catch (error) {
        console.error('API 키 추가 에러:', error.message);
        return res.status(400).json({ error: error.message });
    }
});

// API 키 목록 조회
app.get('/api/openai/keys', (req, res) => {
    return res.json({
        keys: apiKeyPool.getMaskedKeys(),
        status: apiKeyPool.getStatus()
    });
});

// API 키 삭제
app.delete('/api/openai/key/:index', async (req, res) => {
    const index = parseInt(req.params.index);

    try {
        const count = await apiKeyPool.removeKey(index);
        console.log(`[Server] OpenAI API 키 삭제됨 (남은 ${count}개)`);
        return res.json({
            success: true,
            message: `API 키가 삭제되었습니다. (남은 ${count}개)`,
            keyCount: count
        });
    } catch (error) {
        console.error('API 키 삭제 에러:', error.message);
        return res.status(400).json({ error: error.message });
    }
});

// 서버 시작
app.listen(PORT, '0.0.0.0', async () => {
    console.log('='.repeat(50));
    console.log('MetaGrabber - Video Downloader');
    console.log('='.repeat(50));
    console.log(`\n서버 시작: http://localhost:${PORT}`);
    console.log('\n지원 플랫폼:');
    console.log('  - YouTube');
    console.log('  - Instagram');
    console.log('  - Facebook Ads Library');
    console.log('  - Google Ads Transparency');
    console.log('\n기능:');
    console.log('  - 비디오 다운로드');
    const keyCount = apiKeyPool.getKeyCount();
    console.log(`  - 음성 전사: ${keyCount > 0 ? `활성화 (API 키 ${keyCount}개)` : '비활성화 (API 키 필요)'}`);
    console.log('\n종료: Ctrl+C');
    console.log('='.repeat(50));
});
