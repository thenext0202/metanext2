const puppeteer = require('puppeteer');

class FacebookDownloader {
    constructor() {
        this.videoUrls = [];
    }

    async extractVideoUrl(url) {
        let browser = null;

        try {
            console.log(`[Facebook] URL 처리 시작: ${url}`);
            this.videoUrls = [];

            browser = await puppeteer.launch({
                headless: 'new',
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
            await page.setViewport({ width: 1920, height: 1080 });

            // 네트워크 요청 가로채기
            await page.setRequestInterception(true);

            page.on('request', (request) => {
                request.continue();
            });

            page.on('response', async (response) => {
                const reqUrl = response.url();
                const contentType = response.headers()['content-type'] || '';

                if (reqUrl.includes('.mp4') || reqUrl.includes('video') ||
                    reqUrl.includes('fbcdn.net/v/') || contentType.includes('video')) {
                    if (reqUrl.includes('.mp4') || contentType.includes('video')) {
                        console.log(`[Facebook] 비디오 URL 발견: ${reqUrl.substring(0, 100)}...`);
                        this.videoUrls.push(reqUrl);
                    }
                }
            });

            // 페이지 로드
            console.log('[Facebook] 페이지 로드 중...');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

            // 페이지 로드 후 대기
            await page.waitForTimeout(3000);

            // 비디오 요소 찾기 및 클릭 시도
            try {
                // 비디오 재생 버튼 클릭 시도
                const playButton = await page.$('[aria-label="Play"]') ||
                                   await page.$('[data-testid="video-player-play-button"]') ||
                                   await page.$('video');
                if (playButton) {
                    console.log('[Facebook] 비디오 재생 버튼 클릭 시도...');
                    await playButton.click();
                    await page.waitForTimeout(3000);
                }
            } catch (e) {
                console.log('[Facebook] 비디오 클릭 실패 (무시)');
            }

            // 스크롤해서 추가 컨텐츠 로드
            await page.evaluate(() => window.scrollBy(0, 500));
            await page.waitForTimeout(2000);

            // HTML에서 추가 URL 추출
            const htmlContent = await page.content();
            const htmlUrls = this.extractFromHtml(htmlContent);
            const allUrls = [...this.videoUrls, ...htmlUrls];

            console.log(`[Facebook] 수집된 URL 수: ${allUrls.length}`);

            // 최적 URL 선택
            const videoUrl = this.selectBestVideoUrl(allUrls);

            if (videoUrl) {
                const thumbnail = this.extractThumbnail(htmlContent);
                const title = this.extractTitle(htmlContent);

                console.log(`[Facebook] 최종 비디오 URL: ${videoUrl.substring(0, 100)}...`);

                return {
                    video_url: videoUrl,
                    thumbnail_url: thumbnail,
                    title: title,
                    platform: 'facebook'
                };
            }

            console.log('[Facebook] 비디오 URL을 찾을 수 없습니다');
            return null;

        } catch (error) {
            console.error(`[Facebook] 비디오 추출 실패:`, error.message);
            return null;
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }

    extractFromHtml(html) {
        const urls = [];

        // video 태그 src
        const videoSrcRegex = /<video[^>]*src=["']([^"']+)["']/g;
        let match;
        while ((match = videoSrcRegex.exec(html)) !== null) {
            urls.push(match[1]);
        }

        // Facebook CDN 비디오 URL 패턴
        const patterns = [
            /https:\/\/video[^"'\s]*\.fbcdn\.net[^"'\s]*/g,
            /https:\/\/[^"'\s]*fbcdn\.net\/v\/[^"'\s]+/g,
            /https:\/\/[^"'\s]*fbcdn\.net\/o1\/v\/[^"'\s]+/g,
            /"playable_url"\s*:\s*"([^"]+)"/g,
            /"playable_url_quality_hd"\s*:\s*"([^"]+)"/g,
            /"browser_native_hd_url"\s*:\s*"([^"]+)"/g,
            /"browser_native_sd_url"\s*:\s*"([^"]+)"/g,
            /"video_url"\s*:\s*"([^"]+)"/g,
            /"hd_src"\s*:\s*"([^"]+)"/g,
            /"sd_src"\s*:\s*"([^"]+)"/g,
            /"progressive"\s*:\s*\[.*?"url"\s*:\s*"([^"]+)"/g,
        ];

        for (const pattern of patterns) {
            const regex = new RegExp(pattern.source, 'g');
            while ((match = regex.exec(html)) !== null) {
                let url = match[1] || match[0];
                // 이스케이프 문자 처리
                url = url.replace(/\\u0025/g, '%')
                         .replace(/\\\//g, '/')
                         .replace(/\\u0026/g, '&');
                if (url.startsWith('http')) {
                    urls.push(url);
                }
            }
        }

        return urls;
    }

    extractThumbnail(html) {
        // poster 속성
        const posterMatch = html.match(/<video[^>]*poster=["']([^"']+)["']/);
        if (posterMatch) return posterMatch[1];

        // og:image
        const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/);
        if (ogMatch) return ogMatch[1];

        return null;
    }

    extractTitle(html) {
        // white-space: pre-wrap 스타일의 div에서 텍스트 추출
        const adTextMatch = html.match(/style=["'][^"']*white-space[^"']*pre-wrap[^"']*["'][^>]*>([^<]+)/);
        if (adTextMatch) {
            const text = adTextMatch[1].trim();
            return text.substring(0, 50) || 'Facebook Ad Video';
        }

        return 'Facebook Ad Video';
    }

    selectBestVideoUrl(urls) {
        if (!urls.length) return null;

        // 중복 제거
        const uniqueUrls = [...new Set(urls)];

        // 이미지 URL 제외 (jpg, png, gif, webp 등)
        const videoUrls = uniqueUrls.filter(u => {
            const lower = u.toLowerCase();
            // 이미지 확장자 제외
            if (lower.includes('.jpg') || lower.includes('.jpeg') ||
                lower.includes('.png') || lower.includes('.gif') ||
                lower.includes('.webp') || lower.includes('.svg')) {
                return false;
            }
            // scontent는 보통 이미지, video-로 시작하는건 비디오
            if (lower.includes('scontent') && !lower.includes('.mp4')) {
                return false;
            }
            return true;
        });

        console.log(`[Facebook] 필터링 후 비디오 URL 수: ${videoUrls.length}`);

        if (!videoUrls.length) {
            console.log('[Facebook] 비디오 URL을 찾을 수 없습니다 (이미지만 발견)');
            return null;
        }

        // HD 우선
        const hdUrls = videoUrls.filter(u =>
            u.toLowerCase().includes('hd') || u.includes('quality_hd')
        );
        if (hdUrls.length) return hdUrls[0];

        // .mp4 포함 URL 우선
        const mp4Urls = videoUrls.filter(u => u.includes('.mp4'));
        if (mp4Urls.length) {
            return mp4Urls.reduce((a, b) => a.length > b.length ? a : b);
        }

        // video- 로 시작하는 CDN URL 우선
        const videoCdnUrls = videoUrls.filter(u => u.includes('video-') || u.includes('video.'));
        if (videoCdnUrls.length) return videoCdnUrls[0];

        return videoUrls[0];
    }

    static isValidUrl(url) {
        return url.includes('facebook.com/ads/library');
    }
}

module.exports = FacebookDownloader;
