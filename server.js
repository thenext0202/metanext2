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
const notionService = require('./services/notion');
const googleDriveService = require('./services/googleDrive');

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

// 브라우저 로그인 가능 여부 (Railway 등 headless 환경 체크)
const isBrowserLoginAvailable = !process.env.RAILWAY_ENVIRONMENT && !process.env.RENDER;

app.get('/api/instagram/browser-available', (req, res) => {
    return res.json({ available: isBrowserLoginAvailable });
});

// Instagram 브라우저 로그인
app.post('/api/instagram/login', async (req, res) => {
    // Railway/Render 환경에서는 브라우저 로그인 불가
    if (!isBrowserLoginAvailable) {
        return res.status(400).json({
            error: '서버 환경에서는 브라우저 로그인을 사용할 수 없습니다. 쿠키 직접 입력을 사용해주세요.'
        });
    }

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
    const { videoUrl, language = 'ko', prompt = '', uploadToGoogleDrive = false, videoTitle = 'video' } = req.body;

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
        console.log('[Server] Google Drive 업로드:', uploadToGoogleDrive);
        if (prompt) {
            console.log('[Server] Prompt 힌트:', prompt.substring(0, 100));
        }

        // Google Drive 업로드 옵션과 함께 전사
        const result = await transcribeService.transcribe(videoUrl, language, prompt, {
            uploadToGoogleDrive,
            videoTitle,
            googleDriveService: uploadToGoogleDrive ? googleDriveService : null
        });

        return res.json(result);
    } catch (error) {
        const errorMessage = error.message || error.error?.message || '알 수 없는 오류가 발생했습니다';
        console.error('[Server] 전사 에러:', errorMessage);
        return res.status(500).json({ error: `전사 실패: ${errorMessage}` });
    }
});

// GPT 텍스트 교정 API
app.post('/api/correct', async (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: '교정할 텍스트가 필요합니다' });
    }

    if (apiKeyPool.getKeyCount() === 0) {
        return res.status(400).json({ error: 'API 키가 등록되지 않았습니다' });
    }

    const apiKey = apiKeyPool.getAvailableKey();
    if (!apiKey) {
        return res.status(400).json({ error: '사용 가능한 API 키가 없습니다' });
    }

    apiKeyPool.markInUse(apiKey);

    try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey });

        console.log('[Server] GPT 교정 시작...');

        const response = await openai.chat.completions.create({
            model: 'gpt-5-mini',
            messages: [
                {
                    role: 'system',
                    content: `당신은 한국어 음성 인식(STT) 결과를 교정하는 전문가입니다.

음성 인식은 발음이 비슷한 단어를 잘못 인식하는 경우가 많습니다. 문맥을 파악하여 올바른 단어로 교정해주세요.

## 흔한 오인식 패턴 예시:
- "수분 맛집" → "숨은 맛집"
- "신라 면" → "신라면"
- "갤럭시 에스" → "갤럭시 S"
- "유투브" → "유튜브"
- "컨덴츠" → "콘텐츠"
- "어플" → "앱"
- "왠지" → "웬지" 또는 "왠지" (문맥에 따라)
- "됬다" → "됐다"
- "안되" → "안 돼"
- 띄어쓰기 오류 전반

## 교정 규칙:
1. 발음이 비슷하지만 문맥상 맞지 않는 단어를 올바른 단어로 교정
2. 브랜드명, 제품명, 고유명사는 공식 표기로 수정
3. 맞춤법, 띄어쓰기 오류 수정
4. 문장 부호 적절히 추가
5. 원본의 말투와 의미는 유지
6. 교정된 텍스트만 출력 (설명 없이)`
                },
                {
                    role: 'user',
                    content: text
                }
            ],
            max_completion_tokens: 4000
        });

        apiKeyPool.markAvailable(apiKey);

        const corrected = response.choices[0]?.message?.content || text;
        console.log('[Server] GPT 교정 완료');

        return res.json({ success: true, corrected });
    } catch (error) {
        apiKeyPool.markAvailable(apiKey);
        console.error('[Server] GPT 교정 에러:', error.message);
        return res.status(500).json({ error: `교정 실패: ${error.message}` });
    }
});

// GPT 요약 API
app.post('/api/summarize', async (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: '요약할 텍스트가 필요합니다' });
    }

    if (apiKeyPool.getKeyCount() === 0) {
        return res.status(400).json({ error: 'API 키가 등록되지 않았습니다' });
    }

    const apiKey = apiKeyPool.getAvailableKey();
    if (!apiKey) {
        return res.status(400).json({ error: '사용 가능한 API 키가 없습니다' });
    }

    apiKeyPool.markInUse(apiKey);

    try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey });

        console.log('[Server] GPT 요약 시작...');

        const response = await openai.chat.completions.create({
            model: 'gpt-5-mini',
            messages: [
                {
                    role: 'system',
                    content: `당신은 영상 콘텐츠 요약 전문가입니다. 주어진 음성 전사 텍스트를 적절한 길이로 요약해주세요.

## 요약 형식:
1. **핵심 주제** (1-2문장)
2. **주요 내용** (5-7개 bullet point)
3. **핵심 키워드** (중요한 이름, 수치, 용어)

## 요약 규칙:
- 원본 길이의 20-30% 정도로 요약
- 핵심 내용 위주로 정리
- 구체적인 수치, 이름, 브랜드명 포함
- 요약 결과만 출력 (설명 없이)`
                },
                {
                    role: 'user',
                    content: text
                }
            ],
            max_completion_tokens: 2000
        });

        apiKeyPool.markAvailable(apiKey);

        const summarized = response.choices[0]?.message?.content || text;
        console.log('[Server] GPT 요약 완료');

        return res.json({ success: true, summarized });
    } catch (error) {
        apiKeyPool.markAvailable(apiKey);
        console.error('[Server] GPT 요약 에러:', error.message);
        return res.status(500).json({ error: `요약 실패: ${error.message}` });
    }
});

// GPT 번역 API
app.post('/api/translate', async (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: '번역할 텍스트가 필요합니다' });
    }

    if (apiKeyPool.getKeyCount() === 0) {
        return res.status(400).json({ error: 'API 키가 등록되지 않았습니다' });
    }

    const apiKey = apiKeyPool.getAvailableKey();
    if (!apiKey) {
        return res.status(400).json({ error: '사용 가능한 API 키가 없습니다' });
    }

    apiKeyPool.markInUse(apiKey);

    try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey });

        console.log('[Server] GPT 번역 시작...');

        const response = await openai.chat.completions.create({
            model: 'gpt-5-mini',
            messages: [
                {
                    role: 'system',
                    content: `당신은 전문 번역가입니다. 주어진 텍스트를 자연스러운 한국어로 번역해주세요.

## 번역 규칙:
1. 원문의 의미와 뉘앙스를 최대한 살려 번역
2. 자연스러운 한국어 표현 사용
3. 고유명사, 브랜드명은 원어 유지 또는 널리 쓰이는 한국어 표기 사용
4. 구어체는 구어체로, 문어체는 문어체로 유지
5. 번역된 텍스트만 출력 (설명 없이)
6. 이미 한국어인 경우 맞춤법만 교정하여 그대로 출력`
                },
                {
                    role: 'user',
                    content: text
                }
            ],
            max_completion_tokens: 4000
        });

        apiKeyPool.markAvailable(apiKey);

        const translated = response.choices[0]?.message?.content || text;
        console.log('[Server] GPT 번역 완료');

        return res.json({ success: true, translated });
    } catch (error) {
        apiKeyPool.markAvailable(apiKey);
        console.error('[Server] GPT 번역 에러:', error.message);
        return res.status(500).json({ error: `번역 실패: ${error.message}` });
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

// ===== Google Drive API =====

// Google Drive 상태 확인
app.get('/api/google/status', (req, res) => {
    const status = googleDriveService.getStatus();
    return res.json(status);
});

// Google OAuth 인증 URL 가져오기
app.get('/api/google/auth-url', (req, res) => {
    const url = googleDriveService.getAuthUrl();
    if (!url) {
        return res.status(400).json({ error: 'Google OAuth 설정이 필요합니다.' });
    }
    return res.json({ url });
});

// Google OAuth 콜백
app.get('/api/google/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.status(400).send('인증 코드가 없습니다.');
    }

    try {
        await googleDriveService.handleCallback(code);
        // 인증 성공 후 메인 페이지로 리다이렉트
        res.redirect('/?google_auth=success');
    } catch (error) {
        console.error('[GoogleDrive] OAuth 에러:', error.message);
        res.redirect('/?google_auth=error');
    }
});

// 동영상 업로드 (수동)
app.post('/api/google/upload', async (req, res) => {
    const { filePath, fileName } = req.body;

    if (!filePath) {
        return res.status(400).json({ error: '파일 경로가 필요합니다.' });
    }

    try {
        const result = await googleDriveService.uploadVideo(filePath, fileName || 'video.mp4');
        return res.json({ success: true, ...result });
    } catch (error) {
        console.error('[GoogleDrive] 업로드 에러:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

// ===== 강사 관리 API =====

// 강사 목록 조회
app.get('/api/instructors', async (req, res) => {
    try {
        const instructors = await supabase.getInstructors();
        return res.json({ success: true, instructors });
    } catch (error) {
        console.error('[Server] 강사 목록 조회 에러:', error.message);
        return res.status(500).json({ error: '강사 목록 조회 실패' });
    }
});

// 강사 추가
app.post('/api/instructors', async (req, res) => {
    const { name, info } = req.body;

    if (!name || !info) {
        return res.status(400).json({ error: '강사 이름과 정보가 필요합니다' });
    }

    try {
        const instructor = await supabase.addInstructor(name, info);
        if (instructor) {
            return res.json({ success: true, instructor });
        } else {
            return res.status(500).json({ error: '강사 추가 실패' });
        }
    } catch (error) {
        console.error('[Server] 강사 추가 에러:', error.message);
        return res.status(500).json({ error: '강사 추가 실패' });
    }
});

// 강사 수정
app.put('/api/instructors/:id', async (req, res) => {
    const { id } = req.params;
    const { name, info } = req.body;

    if (!name || !info) {
        return res.status(400).json({ error: '강사 이름과 정보가 필요합니다' });
    }

    try {
        const success = await supabase.updateInstructor(id, name, info);
        if (success) {
            return res.json({ success: true });
        } else {
            return res.status(500).json({ error: '강사 수정 실패' });
        }
    } catch (error) {
        console.error('[Server] 강사 수정 에러:', error.message);
        return res.status(500).json({ error: '강사 수정 실패' });
    }
});

// 강사 삭제
app.delete('/api/instructors/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const success = await supabase.deleteInstructor(id);
        if (success) {
            return res.json({ success: true });
        } else {
            return res.status(500).json({ error: '강사 삭제 실패' });
        }
    } catch (error) {
        console.error('[Server] 강사 삭제 에러:', error.message);
        return res.status(500).json({ error: '강사 삭제 실패' });
    }
});

// ===== 지침(프롬프트) 관리 API =====

// 지침 조회
app.get('/api/prompt', async (req, res) => {
    try {
        const prompt = await supabase.getPrompt();
        return res.json({ success: true, prompt: prompt || '' });
    } catch (error) {
        console.error('[Server] 지침 조회 에러:', error.message);
        return res.status(500).json({ error: '지침 조회 실패' });
    }
});

// 지침 저장
app.post('/api/prompt', async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: '지침 내용이 필요합니다' });
    }

    try {
        const success = await supabase.setPrompt(prompt);
        if (success) {
            return res.json({ success: true });
        } else {
            return res.status(500).json({ error: '지침 저장 실패' });
        }
    } catch (error) {
        console.error('[Server] 지침 저장 에러:', error.message);
        return res.status(500).json({ error: '지침 저장 실패' });
    }
});

// ===== Notion URL 관리 =====

// Notion URL 조회
app.get('/api/notion-url', async (req, res) => {
    try {
        const url = await supabase.getNotionUrl();
        return res.json({ success: true, url: url || '' });
    } catch (error) {
        console.error('[Server] Notion URL 조회 에러:', error.message);
        return res.status(500).json({ error: 'Notion URL 조회 실패' });
    }
});

// Notion URL 저장
app.post('/api/notion-url', async (req, res) => {
    const { url } = req.body;

    try {
        const success = await supabase.setNotionUrl(url || '');
        if (success) {
            return res.json({ success: true });
        } else {
            return res.status(500).json({ error: 'Notion URL 저장 실패' });
        }
    } catch (error) {
        console.error('[Server] Notion URL 저장 에러:', error.message);
        return res.status(500).json({ error: 'Notion URL 저장 실패' });
    }
});

// ===== 선택된 강사 관리 =====

// 선택된 강사 조회
app.get('/api/selected-instructor', async (req, res) => {
    try {
        const instructorId = await supabase.getSelectedInstructor();
        return res.json({ success: true, instructorId: instructorId || '' });
    } catch (error) {
        console.error('[Server] 선택된 강사 조회 에러:', error.message);
        return res.status(500).json({ error: '선택된 강사 조회 실패' });
    }
});

// 선택된 강사 저장
app.post('/api/selected-instructor', async (req, res) => {
    const { instructorId } = req.body;

    try {
        const success = await supabase.setSelectedInstructor(instructorId || '');
        if (success) {
            return res.json({ success: true });
        } else {
            return res.status(500).json({ error: '선택된 강사 저장 실패' });
        }
    } catch (error) {
        console.error('[Server] 선택된 강사 저장 에러:', error.message);
        return res.status(500).json({ error: '선택된 강사 저장 실패' });
    }
});

// ===== 스크립트 생성 API =====

// 전사 텍스트 + 지침 + 강사 정보로 새 스크립트 생성
app.post('/api/generate-script', async (req, res) => {
    const { transcript, instructorId } = req.body;

    if (!transcript) {
        return res.status(400).json({ error: '전사 텍스트가 필요합니다' });
    }

    if (!instructorId) {
        return res.status(400).json({ error: '강사를 선택해주세요' });
    }

    if (apiKeyPool.getKeyCount() === 0) {
        return res.status(400).json({ error: 'API 키가 등록되지 않았습니다' });
    }

    const apiKey = apiKeyPool.getAvailableKey();
    if (!apiKey) {
        return res.status(400).json({ error: '사용 가능한 API 키가 없습니다' });
    }

    apiKeyPool.markInUse(apiKey);

    try {
        // 지침 가져오기
        const prompt = await supabase.getPrompt();
        if (!prompt) {
            apiKeyPool.markAvailable(apiKey);
            return res.status(400).json({ error: '지침이 설정되지 않았습니다. 먼저 지침을 설정해주세요.' });
        }

        // 강사 정보 가져오기
        const instructors = await supabase.getInstructors();
        const instructor = instructors.find(i => i.id === instructorId);
        if (!instructor) {
            apiKeyPool.markAvailable(apiKey);
            return res.status(400).json({ error: '선택한 강사를 찾을 수 없습니다' });
        }

        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey });

        console.log('[Server] 스크립트 생성 시작...');
        console.log('[Server] 강사:', instructor.name);

        const systemPrompt = `${prompt}

## 강사 정보
- 이름: ${instructor.name}
- 정보: ${instructor.info}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-5-mini',
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content: `다음 스크립트를 위 강사 정보에 맞게 변환해주세요:\n\n${transcript}`
                }
            ],
            max_completion_tokens: 4000
        });

        apiKeyPool.markAvailable(apiKey);

        const generatedScript = response.choices[0]?.message?.content || '';
        console.log('[Server] 스크립트 생성 완료');

        return res.json({ success: true, script: generatedScript, instructor: instructor.name });
    } catch (error) {
        apiKeyPool.markAvailable(apiKey);
        console.error('[Server] 스크립트 생성 에러:', error.message);
        return res.status(500).json({ error: `스크립트 생성 실패: ${error.message}` });
    }
});

// Notion 상태 확인
app.get('/api/notion/status', (req, res) => {
    const status = notionService.getStatus();
    return res.json({
        enabled: status.enabled,
        message: status.enabled
            ? 'Notion 연동이 활성화되어 있습니다'
            : 'Notion API 설정이 필요합니다'
    });
});

// Notion에 저장
app.post('/api/notion/save', async (req, res) => {
    const { databaseId, videoUrl, videoTitle, platform, transcript, correctedText, summary, translatedText, instructorName } = req.body;

    if (!databaseId) {
        return res.status(400).json({ error: 'Notion 데이터베이스 ID가 필요합니다.' });
    }

    if (!transcript && !correctedText && !summary && !translatedText) {
        return res.status(400).json({ error: '저장할 내용이 없습니다.' });
    }

    try {
        console.log('[Server] Notion 저장 시작... DB:', databaseId);
        const result = await notionService.saveToNotion({
            databaseId,
            videoUrl,
            videoTitle,
            platform,
            transcript,
            correctedText,
            summary,
            translatedText,
            instructorName
        });

        console.log('[Server] Notion 저장 완료:', result.url);
        return res.json({
            success: true,
            message: 'Notion에 저장되었습니다!',
            pageUrl: result.url
        });
    } catch (error) {
        console.error('[Server] Notion 저장 에러:', error.message);
        console.error('[Server] 상세:', error);

        // 더 구체적인 에러 메시지
        let errorMsg = error.message;
        if (error.code === 'unauthorized') {
            errorMsg = 'API 토큰이 유효하지 않습니다. Railway 환경변수에 NOTION_API_TOKEN을 확인해주세요.';
        } else if (error.code === 'object_not_found') {
            errorMsg = '데이터베이스를 찾을 수 없습니다. Integration이 데이터베이스에 연결되어 있는지 확인해주세요.';
        } else if (error.message.includes('API 토큰')) {
            errorMsg = 'NOTION_API_TOKEN 환경변수가 설정되지 않았습니다.';
        }

        return res.status(500).json({ error: errorMsg });
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
