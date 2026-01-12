const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const supabase = require('./supabase');

class GoogleDriveService {
    constructor() {
        this.oauth2Client = null;
        this.enabled = false;
        this.init();
    }

    init() {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/google/callback';

        if (clientId && clientSecret) {
            this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
            this.enabled = true;
            console.log('[GoogleDrive] 서비스 초기화됨');
            this.loadTokens();
        } else {
            console.log('[GoogleDrive] 클라이언트 ID/Secret 없음 - 비활성화');
        }
    }

    async loadTokens() {
        try {
            const tokensJson = await supabase.getSession('google_drive_tokens');
            if (tokensJson) {
                const tokens = JSON.parse(tokensJson);
                this.oauth2Client.setCredentials(tokens);
                console.log('[GoogleDrive] 토큰 로드됨');
            }
        } catch (e) {
            console.log('[GoogleDrive] 토큰 로드 실패:', e.message);
        }
    }

    async saveTokens(tokens) {
        try {
            await supabase.setSession('google_drive_tokens', JSON.stringify(tokens));
            console.log('[GoogleDrive] 토큰 저장됨');
        } catch (e) {
            console.log('[GoogleDrive] 토큰 저장 실패:', e.message);
        }
    }

    // OAuth 인증 URL 생성
    getAuthUrl() {
        if (!this.oauth2Client) return null;

        const scopes = [
            'https://www.googleapis.com/auth/drive.file'
        ];

        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent'
        });
    }

    // OAuth 콜백 처리
    async handleCallback(code) {
        if (!this.oauth2Client) throw new Error('OAuth 클라이언트 미설정');

        const { tokens } = await this.oauth2Client.getToken(code);
        this.oauth2Client.setCredentials(tokens);
        await this.saveTokens(tokens);

        return tokens;
    }

    // 인증 상태 확인
    isAuthenticated() {
        if (!this.oauth2Client) return false;
        const credentials = this.oauth2Client.credentials;
        return !!(credentials && credentials.access_token);
    }

    // 동영상 업로드
    async uploadVideo(filePath, fileName) {
        if (!this.isAuthenticated()) {
            throw new Error('Google Drive 인증이 필요합니다.');
        }

        const drive = google.drive({ version: 'v3', auth: this.oauth2Client });

        console.log('[GoogleDrive] 업로드 시작:', fileName);

        // 폴더 ID 가져오기 (MetaGrabber 폴더)
        let folderId = await this.getOrCreateFolder(drive, 'MetaGrabber');

        const fileMetadata = {
            name: fileName,
            parents: [folderId]
        };

        const media = {
            mimeType: 'video/mp4',
            body: fs.createReadStream(filePath)
        };

        try {
            const response = await drive.files.create({
                requestBody: fileMetadata,
                media: media,
                fields: 'id, webViewLink, webContentLink'
            });

            console.log('[GoogleDrive] 업로드 완료:', response.data.id);

            // 공개 링크 설정
            await drive.permissions.create({
                fileId: response.data.id,
                requestBody: {
                    role: 'reader',
                    type: 'anyone'
                }
            });

            // 직접 재생 가능한 URL 반환
            const fileId = response.data.id;
            const directUrl = `https://drive.google.com/file/d/${fileId}/preview`;

            return {
                fileId: fileId,
                webViewLink: response.data.webViewLink,
                directUrl: directUrl
            };
        } catch (error) {
            console.error('[GoogleDrive] 업로드 실패:', error.message);
            throw error;
        }
    }

    // MetaGrabber 폴더 생성 또는 가져오기
    async getOrCreateFolder(drive, folderName) {
        try {
            // 기존 폴더 검색
            const response = await drive.files.list({
                q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: 'files(id, name)'
            });

            if (response.data.files.length > 0) {
                return response.data.files[0].id;
            }

            // 폴더 생성
            const folderMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder'
            };

            const folder = await drive.files.create({
                requestBody: folderMetadata,
                fields: 'id'
            });

            console.log('[GoogleDrive] 폴더 생성됨:', folderName);
            return folder.data.id;
        } catch (error) {
            console.error('[GoogleDrive] 폴더 생성 실패:', error.message);
            throw error;
        }
    }

    getStatus() {
        return {
            enabled: this.enabled,
            authenticated: this.isAuthenticated()
        };
    }
}

module.exports = new GoogleDriveService();
