const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const apiKeyPool = require('./apiKeyPool');

// Docker 환경에서는 시스템 ffmpeg 사용, 로컬에서는 ffmpeg-static 사용
const getFFmpegPath = () => {
    // Docker/Linux 환경 체크
    if (fs.existsSync('/usr/bin/ffmpeg')) {
        return '/usr/bin/ffmpeg';
    }
    // 로컬 개발 환경 (ffmpeg-static)
    return require('ffmpeg-static');
};
const ffmpegPath = getFFmpegPath();

class TranscribeService {
    constructor() {
        this.tempDir = path.join(__dirname, '..', 'temp');

        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async transcribe(videoUrl, language = 'ko', prompt = '') {
        // UUID로 파일명 생성 (동시 요청 충돌 방지)
        const fileId = uuidv4();
        const videoPath = path.join(this.tempDir, `video_${fileId}.mp4`);
        const audioPath = path.join(this.tempDir, `audio_${fileId}.mp3`);

        try {
            // HLS 스트림(m3u8)인 경우 ffmpeg로 직접 처리
            const isHLS = videoUrl.includes('.m3u8') || videoUrl.includes('manifest');

            if (isHLS) {
                console.log('[Transcribe] HLS 스트림 감지 - ffmpeg로 직접 오디오 추출...');
                await this.extractAudioFromStream(videoUrl, audioPath);
            } else {
                console.log('[Transcribe] 비디오 다운로드 중...');
                await this.downloadFile(videoUrl, videoPath);

                console.log('[Transcribe] 오디오 추출 중...');
                await this.extractAudio(videoPath, audioPath);
            }

            // API 키 풀에서 재시도 로직으로 Whisper 호출
            console.log('[Transcribe] Whisper API 호출 중...');
            if (prompt) {
                console.log(`[Transcribe] Prompt 힌트: ${prompt.substring(0, 50)}...`);
            }
            const transcription = await this.callWhisperWithRetry(audioPath, language, prompt);

            return {
                success: true,
                text: transcription.text,
                language: language
            };

        } catch (error) {
            console.error('[Transcribe] 에러:', error.message);
            throw error;
        } finally {
            // 임시 파일 정리 (HLS는 videoPath 생성 안함)
            if (!videoUrl.includes('.m3u8') && !videoUrl.includes('manifest')) {
                this.cleanupFile(videoPath);
            }
            this.cleanupFile(audioPath);
        }
    }

    async callWhisperWithRetry(audioPath, language, prompt = '', maxRetries = 3) {
        const triedKeys = new Set();
        let lastError = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const apiKey = apiKeyPool.getAvailableKey();

            if (!apiKey) {
                throw new Error('사용 가능한 API 키가 없습니다. API 키를 등록해주세요.');
            }

            // 이미 시도한 키는 스킵 (다른 키가 있는 경우에만)
            if (triedKeys.has(apiKey) && triedKeys.size < apiKeyPool.getKeyCount()) {
                continue;
            }

            triedKeys.add(apiKey);
            apiKeyPool.markInUse(apiKey);

            try {
                console.log(`[Transcribe] API 키 시도 ${attempt + 1}/${maxRetries} (${apiKey.substring(0, 7)}...)`);

                const openai = new OpenAI({ apiKey });
                const audioFile = fs.createReadStream(audioPath);

                const options = {
                    file: audioFile,
                    model: 'whisper-1',
                    language: language,
                    response_format: 'json'
                };

                // prompt 힌트가 있으면 추가 (발음 인식 정확도 향상)
                if (prompt) {
                    options.prompt = prompt;
                }

                const response = await openai.audio.transcriptions.create(options);

                apiKeyPool.markAvailable(apiKey);
                console.log(`[Transcribe] API 호출 성공`);
                return response;

            } catch (error) {
                apiKeyPool.markAvailable(apiKey);
                lastError = error;

                // Rate limit 또는 일시적 오류면 다음 키로 재시도
                if (error.status === 429 || error.status === 500 || error.status === 503) {
                    console.log(`[Transcribe] API 키 ${apiKey.substring(0, 7)}... 실패 (${error.status}), 다음 키로 재시도...`);
                    continue;
                }

                // 인증 오류 등은 바로 throw
                throw error;
            }
        }

        throw lastError || new Error('모든 API 키로 시도 실패');
    }

    async downloadFile(url, filePath) {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 120000
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                const stats = fs.statSync(filePath);
                console.log(`[Transcribe] 다운로드 완료: ${stats.size} bytes`);
                if (stats.size < 1000) {
                    reject(new Error('다운로드된 파일이 너무 작습니다. 비디오 URL이 유효한지 확인하세요.'));
                } else {
                    resolve();
                }
            });
            writer.on('error', reject);
        });
    }

    async extractAudioFromStream(streamUrl, audioPath) {
        return new Promise((resolve, reject) => {
            console.log(`[Transcribe] ffmpeg로 HLS 스트림에서 오디오 추출...`);

            const ffmpeg = spawn(ffmpegPath, [
                '-i', streamUrl,
                '-vn',
                '-acodec', 'libmp3lame',
                '-ab', '128k',
                '-ar', '16000',
                '-t', '600',  // 최대 10분
                '-y',
                audioPath
            ]);

            let stderrData = '';
            ffmpeg.stderr.on('data', (data) => {
                stderrData += data.toString();
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    console.log('[Transcribe] HLS 오디오 추출 성공');
                    resolve();
                } else {
                    console.error('[Transcribe] HLS ffmpeg stderr:', stderrData.slice(-500));
                    reject(new Error(`HLS 오디오 추출 실패: exit code ${code}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(new Error(`ffmpeg 실행 실패: ${err.message}`));
            });
        });
    }

    async extractAudio(videoPath, audioPath) {
        return new Promise((resolve, reject) => {
            console.log(`[Transcribe] ffmpeg 경로: ${ffmpegPath}`);
            console.log(`[Transcribe] 입력 파일: ${videoPath}`);

            // ffmpeg를 사용해서 오디오 추출
            const ffmpeg = spawn(ffmpegPath, [
                '-i', videoPath,
                '-vn',
                '-acodec', 'libmp3lame',
                '-ab', '128k',
                '-ar', '16000',
                '-y',
                audioPath
            ]);

            let stderrData = '';
            ffmpeg.stderr.on('data', (data) => {
                stderrData += data.toString();
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    console.log('[Transcribe] ffmpeg 성공');
                    resolve();
                } else {
                    console.error('[Transcribe] ffmpeg stderr:', stderrData.slice(-500));
                    reject(new Error(`ffmpeg 실패: exit code ${code}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(new Error(`ffmpeg 실행 실패: ${err.message}. ffmpeg가 설치되어 있는지 확인하세요.`));
            });
        });
    }

    cleanupFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            console.log('[Transcribe] 파일 정리 실패:', e.message);
        }
    }
}

module.exports = TranscribeService;
