const axios = require('axios');
const fs = require('fs');
const path = require('path');
const supabase = require('../services/supabase');

class InstagramDownloader {
    constructor() {
        this.cookiesPath = path.join(__dirname, '..', 'instagram_cookies.json');
    }

    extractShortcode(url) {
        const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
        return match ? match[1] : null;
    }

    async loadSessionId() {
        // 1. Supabase에서 먼저 확인
        if (supabase.enabled) {
            const session = await supabase.getSession('instagram_sessionid');
            if (session) {
                console.log('[Instagram] Supabase에서 sessionid 로드');
                try {
                    return decodeURIComponent(session);
                } catch {
                    return session;
                }
            }
        }

        // 2. 로컬 파일에서 확인
        try {
            if (fs.existsSync(this.cookiesPath)) {
                const data = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
                const session = data.find(c => c.name === 'sessionid');
                if (session?.value) {
                    try {
                        return decodeURIComponent(session.value);
                    } catch {
                        return session.value;
                    }
                }
            }
        } catch (e) {
            console.log('[Instagram] 쿠키 로드 실패:', e.message);
        }
        return null;
    }

    async extractVideoUrl(url) {
        console.log(`[Instagram] URL 처리 시작: ${url}`);

        const shortcode = this.extractShortcode(url);
        if (!shortcode) {
            console.log('[Instagram] shortcode 추출 실패');
            return null;
        }
        console.log(`[Instagram] Shortcode: ${shortcode}`);

        const sessionid = await this.loadSessionId();
        if (!sessionid) {
            console.log('[Instagram] sessionid 없음 - 쿠키를 먼저 저장해주세요');
            return null;
        }
        console.log('[Instagram] sessionid 로드 완료');

        // ds_user_id 추출 (sessionid의 첫 번째 부분)
        const dsUserId = sessionid.split(':')[0];

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cookie': `sessionid=${sessionid}; ds_user_id=${dsUserId}`,
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': '129477',
            'X-Requested-With': 'XMLHttpRequest',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Referer': `https://www.instagram.com/reel/${shortcode}/`,
        };

        // GraphQL API 시도
        try {
            const result = await this.tryGraphQL(shortcode, headers);
            if (result) return result;
        } catch (e) {
            console.log('[Instagram] GraphQL 실패:', e.message);
        }

        // 기존 API 시도
        const apiUrls = [
            `https://www.instagram.com/reel/${shortcode}/?__a=1&__d=dis`,
            `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`,
        ];

        for (const apiEndpoint of apiUrls) {
            try {
                console.log(`[Instagram] API 요청: ${apiEndpoint.substring(0, 60)}...`);

                const response = await axios.get(apiEndpoint, {
                    headers,
                    timeout: 15000,
                });

                const data = response.data;
                const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);

                console.log(`[Instagram] 응답 길이: ${jsonStr.length}`);

                const videoUrl = this.extractVideoFromResponse(jsonStr);

                if (videoUrl) {
                    console.log('[Instagram] 비디오 URL 발견!');
                    return {
                        video_url: videoUrl,
                        thumbnail_url: this.extractThumbnail(jsonStr),
                        title: this.extractTitle(jsonStr),
                        platform: 'instagram'
                    };
                }
            } catch (error) {
                console.log(`[Instagram] API 실패: ${error.response?.status || error.message}`);
            }
        }

        console.log('[Instagram] 모든 API 실패');
        return null;
    }

    async tryGraphQL(shortcode, headers) {
        // Instagram GraphQL doc_id for media info
        const docIds = [
            '8845758582119845',  // reel/post info
            '7153581528070080',  // alternative
        ];

        for (const docId of docIds) {
            try {
                const variables = JSON.stringify({ shortcode: shortcode });
                const url = `https://www.instagram.com/graphql/query/?doc_id=${docId}&variables=${encodeURIComponent(variables)}`;

                console.log(`[Instagram] GraphQL 요청 (doc_id: ${docId})...`);

                const response = await axios.get(url, {
                    headers,
                    timeout: 15000,
                });

                const jsonStr = JSON.stringify(response.data);
                console.log(`[Instagram] GraphQL 응답 길이: ${jsonStr.length}`);

                const videoUrl = this.extractVideoFromResponse(jsonStr);

                if (videoUrl) {
                    console.log('[Instagram] GraphQL에서 비디오 URL 발견!');
                    return {
                        video_url: videoUrl,
                        thumbnail_url: this.extractThumbnail(jsonStr),
                        title: this.extractTitle(jsonStr),
                        platform: 'instagram'
                    };
                }
            } catch (error) {
                console.log(`[Instagram] GraphQL 실패 (${docId}): ${error.response?.status || error.message}`);
            }
        }

        return null;
    }

    extractVideoFromResponse(jsonStr) {
        // video_url 직접
        const videoUrlMatch = jsonStr.match(/"video_url"\s*:\s*"([^"]+)"/);
        if (videoUrlMatch) {
            return this.cleanUrl(videoUrlMatch[1]);
        }

        // video_versions 배열에서 첫 번째 URL
        const versionsMatch = jsonStr.match(/"video_versions"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
        if (versionsMatch) {
            return this.cleanUrl(versionsMatch[1]);
        }

        // CDN URL 직접
        const cdnMatch = jsonStr.match(/(https?:\\\/\\\/[^"]*?cdninstagram\.com\\\/[^"]*?\.mp4[^"]*)/);
        if (cdnMatch) {
            return this.cleanUrl(cdnMatch[1]);
        }

        // o1/v/ 형식 CDN URL
        const cdnMatch2 = jsonStr.match(/(https?:\\\/\\\/[^"]*?cdninstagram\.com\\\/o1\\\/v\\\/[^"]+)/);
        if (cdnMatch2) {
            return this.cleanUrl(cdnMatch2[1]);
        }

        return null;
    }

    extractThumbnail(jsonStr) {
        const match = jsonStr.match(/"display_url"\s*:\s*"([^"]+)"/);
        if (match) return this.cleanUrl(match[1]);

        const match2 = jsonStr.match(/"thumbnail_url"\s*:\s*"([^"]+)"/);
        if (match2) return this.cleanUrl(match2[1]);

        const match3 = jsonStr.match(/"image_versions2"[^}]*"url"\s*:\s*"([^"]+)"/);
        if (match3) return this.cleanUrl(match3[1]);

        return null;
    }

    extractTitle(jsonStr) {
        const captionMatch = jsonStr.match(/"text"\s*:\s*"([^"]{1,100})"/);
        if (captionMatch) {
            return captionMatch[1].substring(0, 100);
        }
        return 'Instagram Reels Video';
    }

    cleanUrl(url) {
        if (!url) return '';
        return url
            .replace(/\\u0026/g, '&')
            .replace(/\\\//g, '/')
            .replace(/\\u0025/g, '%')
            .replace(/&amp;/g, '&')
            .replace(/\\"/g, '"')
            .trim();
    }

    static isValidUrl(url) {
        return /instagram\.com\/(reel|reels|p|tv)\//.test(url);
    }
}

module.exports = InstagramDownloader;
