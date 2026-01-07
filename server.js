const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const FacebookDownloader = require('./downloaders/facebook');
const InstagramDownloader = require('./downloaders/instagram');
const YouTubeDownloader = require('./downloaders/youtube');

const app = express();
const PORT = 5000;

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

// 메인 페이지
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
        } else {
            return res.status(400).json({
                error: '지원하지 않는 URL입니다. YouTube, Instagram, Facebook URL을 입력해주세요.'
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
app.post('/api/instagram/cookie', (req, res) => {
    const { sessionid } = req.body;

    if (!sessionid) {
        return res.status(400).json({ error: 'sessionid가 필요합니다' });
    }

    try {
        // 쿠키 형식으로 저장
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
app.get('/api/instagram/status', (req, res) => {
    const cookiesPath = path.join(__dirname, 'instagram_cookies.json');
    const isLoggedIn = fs.existsSync(cookiesPath);

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
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
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

                // 쿠키 저장
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

// 서버 시작
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('MetaGrabber2 - 비디오 다운로더 (Node.js)');
    console.log('='.repeat(50));
    console.log(`\n서버 시작: http://localhost:${PORT}`);
    console.log('\n지원 플랫폼:');
    console.log('  - Facebook Ads Library');
    console.log('  - Instagram Reels');
    console.log('\n종료하려면 Ctrl+C를 누르세요.');
    console.log('='.repeat(50));
});
