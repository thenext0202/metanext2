const { Client } = require('@notionhq/client');

class NotionService {
    constructor() {
        this.client = null;
        this.databaseId = process.env.NOTION_DATABASE_ID;
        this.enabled = false;
        this.init();
    }

    init() {
        const token = process.env.NOTION_API_TOKEN;
        if (token && this.databaseId) {
            this.client = new Client({ auth: token });
            this.enabled = true;
            console.log('[Notion] 서비스 활성화됨');
        } else {
            console.log('[Notion] API 토큰 또는 데이터베이스 ID가 없습니다. 서비스 비활성화.');
        }
    }

    async saveToNotion(data) {
        const token = process.env.NOTION_API_TOKEN;
        if (!token) {
            throw new Error('Notion API 토큰이 설정되지 않았습니다.');
        }

        const {
            databaseId,
            videoUrl,
            videoTitle,
            platform,
            transcript,
            correctedText,
            summary,
            translatedText
        } = data;

        if (!databaseId) {
            throw new Error('데이터베이스 ID가 필요합니다.');
        }

        // 클라이언트가 없거나 다른 DB를 사용하는 경우 새로 생성
        if (!this.client) {
            this.client = new Client({ auth: token });
        }

        try {
            // 기본 속성 (제목은 필수)
            const properties = {
                'Name': {
                    title: [
                        {
                            text: {
                                content: videoTitle || '제목 없음'
                            }
                        }
                    ]
                }
            };

            // 선택적 속성들 - 에러 방지를 위해 try-catch로 개별 처리
            // URL 속성이 있으면 추가
            if (videoUrl) {
                properties['URL'] = { url: videoUrl };
            }

            // 플랫폼 속성
            if (platform) {
                properties['플랫폼'] = { select: { name: platform } };
            }

            // 날짜 속성
            properties['날짜'] = { date: { start: new Date().toISOString() } };

            // 블록(본문) 내용 구성
            const children = [];

            // 전사 결과
            if (transcript) {
                children.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '전사 결과' } }]
                    }
                });

                // Notion 블록은 2000자 제한이 있으므로 분할
                const transcriptChunks = this.splitText(transcript, 1900);
                for (const chunk of transcriptChunks) {
                    children.push({
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [{ type: 'text', text: { content: chunk } }]
                        }
                    });
                }
            }

            // 교정 결과
            if (correctedText) {
                children.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '교정된 텍스트' } }]
                    }
                });

                const correctedChunks = this.splitText(correctedText, 1900);
                for (const chunk of correctedChunks) {
                    children.push({
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [{ type: 'text', text: { content: chunk } }]
                        }
                    });
                }
            }

            // 요약
            if (summary) {
                children.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '요약' } }]
                    }
                });

                const summaryChunks = this.splitText(summary, 1900);
                for (const chunk of summaryChunks) {
                    children.push({
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [{ type: 'text', text: { content: chunk } }]
                        }
                    });
                }
            }

            // 번역
            if (translatedText) {
                children.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '번역' } }]
                    }
                });

                const translatedChunks = this.splitText(translatedText, 1900);
                for (const chunk of translatedChunks) {
                    children.push({
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [{ type: 'text', text: { content: chunk } }]
                        }
                    });
                }
            }

            const response = await this.client.pages.create({
                parent: { database_id: databaseId },
                properties,
                children: children.length > 0 ? children : undefined
            });

            console.log('[Notion] 페이지 생성 완료:', response.id);
            return {
                success: true,
                pageId: response.id,
                url: response.url
            };
        } catch (error) {
            console.error('[Notion] 저장 실패:', error.message);
            console.error('[Notion] 상세 에러:', JSON.stringify(error.body || error, null, 2));

            // 더 친화적인 에러 메시지
            if (error.code === 'validation_error') {
                throw new Error('노션 데이터베이스 속성을 확인해주세요. Name(제목) 속성이 필요합니다.');
            }
            if (error.code === 'object_not_found') {
                throw new Error('노션 데이터베이스를 찾을 수 없습니다. Integration 연결을 확인해주세요.');
            }
            if (error.code === 'unauthorized') {
                throw new Error('노션 API 토큰이 유효하지 않습니다.');
            }
            throw error;
        }
    }

    // 긴 텍스트를 청크로 분할
    splitText(text, maxLength) {
        const chunks = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }

            // 문장 끝에서 자르기 시도
            let splitIndex = remaining.lastIndexOf('. ', maxLength);
            if (splitIndex === -1 || splitIndex < maxLength / 2) {
                splitIndex = remaining.lastIndexOf(' ', maxLength);
            }
            if (splitIndex === -1 || splitIndex < maxLength / 2) {
                splitIndex = maxLength;
            }

            chunks.push(remaining.substring(0, splitIndex + 1));
            remaining = remaining.substring(splitIndex + 1);
        }

        return chunks;
    }

    getStatus() {
        const hasToken = !!process.env.NOTION_API_TOKEN;
        return {
            enabled: hasToken,
            hasToken: hasToken
        };
    }
}

module.exports = new NotionService();
