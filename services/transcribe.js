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

    async transcribe(videoUrl, language = '', prompt = '', options = {}) {
        const { uploadToGoogleDrive = false, videoTitle = 'video', googleDriveService = null } = options;

        // UUID로 파일명 생성 (동시 요청 충돌 방지)
        const fileId = uuidv4();
        const videoPath = path.join(this.tempDir, `video_${fileId}.mp4`);
        const audioPath = path.join(this.tempDir, `audio_${fileId}.mp3`);
        const chunkPaths = [];
        let googleDriveUrl = null;

        try {
            // HLS 스트림(m3u8)인 경우 ffmpeg로 직접 처리
            const isHLS = videoUrl.includes('.m3u8') || videoUrl.includes('manifest');

            if (isHLS) {
                console.log('[Transcribe] HLS 스트림 감지 - ffmpeg로 직접 오디오 추출...');
                // HLS의 경우 Google Drive 업로드를 위해 비디오도 다운로드
                if (uploadToGoogleDrive && googleDriveService) {
                    console.log('[Transcribe] HLS 비디오 다운로드 (Google Drive용)...');
                    await this.downloadHLSVideo(videoUrl, videoPath);
                }
                await this.extractAudioFromStream(videoUrl, audioPath);
            } else {
                console.log('[Transcribe] 비디오 다운로드 중...');
                await this.downloadFile(videoUrl, videoPath);

                console.log('[Transcribe] 오디오 추출 중...');
                await this.extractAudio(videoPath, audioPath);
            }

            // Google Drive 업로드 (전사와 병렬로 처리하지 않고 먼저 업로드)
            if (uploadToGoogleDrive && googleDriveService && fs.existsSync(videoPath)) {
                try {
                    console.log('[Transcribe] Google Drive 업로드 중...');
                    const timestamp = new Date().toISOString().slice(0, 10);
                    const fileName = `${videoTitle}_${timestamp}.mp4`;
                    const uploadResult = await googleDriveService.uploadVideo(videoPath, fileName);
                    googleDriveUrl = uploadResult.directUrl;
                    console.log('[Transcribe] Google Drive 업로드 완료:', googleDriveUrl);
                } catch (uploadError) {
                    console.error('[Transcribe] Google Drive 업로드 실패:', uploadError.message);
                    // 업로드 실패해도 전사는 계속 진행
                }
            }

            // 파일 크기 확인 (24MB 제한, 여유 두기)
            const MAX_SIZE = 24 * 1024 * 1024; // 24MB
            const stats = fs.statSync(audioPath);
            console.log(`[Transcribe] 오디오 파일 크기: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

            let transcriptionText = '';

            if (stats.size > MAX_SIZE) {
                // 청크로 분할
                console.log('[Transcribe] 파일이 커서 청크로 분할합니다...');
                const chunkDuration = 600; // 10분 단위로 분할
                const audioDuration = await this.getAudioDuration(audioPath);
                const numChunks = Math.ceil(audioDuration / chunkDuration);
                console.log(`[Transcribe] 총 ${audioDuration}초, ${numChunks}개 청크로 분할`);

                for (let i = 0; i < numChunks; i++) {
                    const chunkPath = path.join(this.tempDir, `audio_${fileId}_chunk${i}.mp3`);
                    chunkPaths.push(chunkPath);
                    const startTime = i * chunkDuration;

                    await this.extractAudioChunk(audioPath, chunkPath, startTime, chunkDuration);

                    console.log(`[Transcribe] 청크 ${i + 1}/${numChunks} Whisper API 호출 중...`);
                    const chunkTranscription = await this.callWhisperWithRetry(chunkPath, language, prompt);
                    transcriptionText += chunkTranscription.text + ' ';
                }

                transcriptionText = transcriptionText.trim();
            } else {
                // 단일 파일 전사
                console.log('[Transcribe] Whisper API 호출 중...');
                if (prompt) {
                    console.log(`[Transcribe] Prompt 힌트: ${prompt.substring(0, 50)}...`);
                }
                const transcription = await this.callWhisperWithRetry(audioPath, language, prompt);
                transcriptionText = transcription.text;
            }

            return {
                success: true,
                text: transcriptionText,
                language: language,
                googleDriveUrl: googleDriveUrl
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
            // 청크 파일들 정리
            chunkPaths.forEach(chunkPath => this.cleanupFile(chunkPath));
        }
    }

    // 오디오 길이 확인 (초 단위)
    async getAudioDuration(audioPath) {
        return new Promise((resolve) => {
            const ffprobe = spawn(ffmpegPath, [
                '-i', audioPath,
                '-f', 'null', '-'
            ]);

            let output = '';
            ffprobe.stderr.on('data', (data) => {
                output += data.toString();
            });

            ffprobe.on('close', () => {
                const match = output.match(/Duration: (\d+):(\d+):(\d+)/);
                if (match) {
                    const hours = parseInt(match[1]);
                    const minutes = parseInt(match[2]);
                    const seconds = parseInt(match[3]);
                    resolve(hours * 3600 + minutes * 60 + seconds);
                } else {
                    resolve(600); // 기본 10분
                }
            });

            setTimeout(() => resolve(600), 10000);
        });
    }

    // 오디오 청크 추출
    async extractAudioChunk(inputPath, outputPath, startTime, duration) {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn(ffmpegPath, [
                '-i', inputPath,
                '-ss', startTime.toString(),
                '-t', duration.toString(),
                '-acodec', 'libmp3lame',
                '-ab', '48k',  // 청크는 더 낮은 비트레이트
                '-ar', '16000',
                '-y',
                outputPath
            ]);

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`청크 추출 실패: exit code ${code}`));
                }
            });

            ffmpeg.on('error', (err) => reject(err));
        });
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
                    response_format: 'json'
                };

                // language가 지정된 경우에만 추가 (없으면 자동 감지)
                if (language) {
                    options.language = language;
                }

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

                const errorStatus = error.status || error.response?.status;
                const errorMessage = error.message || error.error?.message || '알 수 없는 오류';

                console.log(`[Transcribe] API 키 ${apiKey.substring(0, 7)}... 실패: ${errorMessage} (status: ${errorStatus})`);

                // Rate limit 또는 일시적 오류면 다음 키로 재시도
                if (errorStatus === 429 || errorStatus === 500 || errorStatus === 503) {
                    console.log(`[Transcribe] 다음 키로 재시도...`);
                    continue;
                }

                // 다른 키가 있으면 재시도
                if (triedKeys.size < apiKeyPool.getKeyCount()) {
                    console.log(`[Transcribe] 다른 키로 재시도... (${triedKeys.size}/${apiKeyPool.getKeyCount()})`);
                    continue;
                }

                // 모든 키 시도 완료
                throw new Error(errorMessage);
            }
        }

        const finalError = lastError?.message || lastError?.error?.message || '모든 API 키로 시도 실패';
        throw new Error(finalError);
    }

    async downloadFile(url, filePath) {
        // YouTube URL인 경우 Referer 헤더 추가 (403 방지)
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        if (url.includes('googlevideo.com') || url.includes('youtube.com')) {
            headers['Referer'] = 'https://www.youtube.com/';
            headers['Origin'] = 'https://www.youtube.com';
        }

        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers,
            timeout: 600000  // 10분 타임아웃 (긴 영상 다운로드용)
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

            // HLS는 길이를 미리 알 수 없어서 64kbps 사용 (안전하게)
            const ffmpeg = spawn(ffmpegPath, [
                '-i', streamUrl,
                '-vn',
                '-acodec', 'libmp3lame',
                '-ab', '64k',       // HLS는 길이 미확인이라 낮은 비트레이트 사용
                '-ar', '16000',
                '-t', '3600',       // 최대 60분
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

    // HLS 스트림을 비디오 파일로 다운로드
    async downloadHLSVideo(streamUrl, videoPath) {
        return new Promise((resolve, reject) => {
            console.log(`[Transcribe] ffmpeg로 HLS 스트림을 비디오로 다운로드...`);

            const ffmpeg = spawn(ffmpegPath, [
                '-i', streamUrl,
                '-c', 'copy',           // 코덱 복사 (빠름)
                '-bsf:a', 'aac_adtstoasc',
                '-t', '3600',           // 최대 60분
                '-y',
                videoPath
            ]);

            let stderrData = '';
            ffmpeg.stderr.on('data', (data) => {
                stderrData += data.toString();
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    console.log('[Transcribe] HLS 비디오 다운로드 성공');
                    resolve();
                } else {
                    console.error('[Transcribe] HLS 비디오 다운로드 실패:', stderrData.slice(-500));
                    reject(new Error(`HLS 비디오 다운로드 실패: exit code ${code}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(new Error(`ffmpeg 실행 실패: ${err.message}`));
            });
        });
    }

    // 영상 길이 확인 (초 단위)
    async getVideoDuration(videoPath) {
        return new Promise((resolve) => {
            const ffprobe = spawn(ffmpegPath, [
                '-i', videoPath,
                '-show_entries', 'format=duration',
                '-v', 'quiet',
                '-of', 'csv=p=0'
            ]);

            let output = '';
            ffprobe.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffprobe.stderr.on('data', (data) => {
                // ffmpeg -i 로 duration 파싱
                const match = data.toString().match(/Duration: (\d+):(\d+):(\d+)/);
                if (match) {
                    const hours = parseInt(match[1]);
                    const minutes = parseInt(match[2]);
                    const seconds = parseInt(match[3]);
                    resolve(hours * 3600 + minutes * 60 + seconds);
                }
            });

            ffprobe.on('close', () => {
                const duration = parseFloat(output);
                resolve(isNaN(duration) ? 0 : duration);
            });

            // 5초 타임아웃
            setTimeout(() => resolve(0), 5000);
        });
    }

    async extractAudio(videoPath, audioPath) {
        // 영상 길이 확인
        const duration = await this.getVideoDuration(videoPath);
        const isLongVideo = duration > 600; // 10분 초과
        const bitrate = isLongVideo ? '64k' : '128k';

        console.log(`[Transcribe] 영상 길이: ${Math.round(duration)}초, 비트레이트: ${bitrate}`);

        return new Promise((resolve, reject) => {
            console.log(`[Transcribe] ffmpeg 경로: ${ffmpegPath}`);
            console.log(`[Transcribe] 입력 파일: ${videoPath}`);

            // ffmpeg를 사용해서 오디오 추출
            const ffmpeg = spawn(ffmpegPath, [
                '-i', videoPath,
                '-vn',
                '-acodec', 'libmp3lame',
                '-ab', bitrate,      // 10분 이하: 128k, 10분 초과: 64k
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
