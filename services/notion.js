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

    // 데이터베이스 스키마 조회
    async getDatabaseSchema(databaseId) {
        const token = process.env.NOTION_API_TOKEN;
        if (!token) {
            throw new Error('Notion API 토큰이 설정되지 않았습니다.');
        }

        if (!this.client) {
            this.client = new Client({ auth: token });
        }

        try {
            const response = await this.client.databases.retrieve({
                database_id: databaseId
            });

            console.log('[Notion] 데이터베이스 스키마 조회 완료');

            // 속성 정보 추출
            const properties = {};
            let titleProperty = null;

            for (const [name, prop] of Object.entries(response.properties)) {
                properties[name] = prop.type;
                if (prop.type === 'title') {
                    titleProperty = name;
                }
            }

            console.log('[Notion] 속성 목록:', properties);
            console.log('[Notion] 제목 속성:', titleProperty);

            return {
                properties,
                titleProperty,
                raw: response.properties
            };
        } catch (error) {
            console.error('[Notion] 스키마 조회 실패:', error.message);
            throw error;
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
            translatedText,
            instructorName
        } = data;

        if (!databaseId) {
            throw new Error('데이터베이스 ID가 필요합니다.');
        }

        if (!this.client) {
            this.client = new Client({ auth: token });
        }

        try {
            // 먼저 데이터베이스 스키마를 조회해서 속성 이름 확인
            const schema = await this.getDatabaseSchema(databaseId);
            const titleProperty = schema.titleProperty || '이름';

            console.log('[Notion] 사용할 제목 속성:', titleProperty);

            // 동적으로 속성 구성
            const properties = {};

            // 제목 속성 (필수)
            properties[titleProperty] = {
                title: [
                    {
                        text: {
                            content: videoTitle || '제목 없음'
                        }
                    }
                ]
            };

            // 데이터베이스에 있는 속성만 추가
            if (schema.properties['태그']) {
                properties['태그'] = {
                    multi_select: [{ name: '광고소재' }]
                };
            }

            if (schema.properties['선택'] && instructorName) {
                properties['선택'] = {
                    select: { name: instructorName }
                };
            }

            // 페이지 본문 구성 - 사용자 템플릿에 맞는 2열 레이아웃
            const children = [];

            // 2열 레이아웃: 왼쪽 비디오, 오른쪽 스크립트
            const columnList = {
                object: 'block',
                type: 'column_list',
                column_list: {
                    children: [
                        // 왼쪽 열 - 비디오
                        {
                            object: 'block',
                            type: 'column',
                            column: {
                                children: [
                                    {
                                        object: 'block',
                                        type: 'heading_3',
                                        heading_3: {
                                            rich_text: [{ type: 'text', text: { content: '영상' } }]
                                        }
                                    }
                                ]
                            }
                        },
                        // 오른쪽 열 - 스크립트
                        {
                            object: 'block',
                            type: 'column',
                            column: {
                                children: []
                            }
                        }
                    ]
                }
            };

            // 왼쪽 열에 비디오 embed 추가 (URL이 있는 경우)
            if (videoUrl) {
                columnList.column_list.children[0].column.children.push({
                    object: 'block',
                    type: 'embed',
                    embed: {
                        url: videoUrl
                    }
                });
            }

            // 오른쪽 열에 콜아웃 블록으로 스크립트 추가
            const rightColumn = columnList.column_list.children[1].column.children;

            // 교정된 텍스트를 콜아웃으로 추가
            if (correctedText) {
                rightColumn.push({
                    object: 'block',
                    type: 'heading_3',
                    heading_3: {
                        rich_text: [{ type: 'text', text: { content: '스크립트' } }]
                    }
                });

                // 콜아웃 블록으로 텍스트 추가
                const correctedChunks = this.splitText(correctedText, 1900);
                for (const chunk of correctedChunks) {
                    rightColumn.push({
                        object: 'block',
                        type: 'callout',
                        callout: {
                            rich_text: [{ type: 'text', text: { content: chunk } }],
                            icon: { emoji: '📝' }
                        }
                    });
                }
            }

            children.push(columnList);

            // 구분선
            children.push({
                object: 'block',
                type: 'divider',
                divider: {}
            });

            // 추가 정보 섹션
            // 전사 결과
            if (transcript) {
                children.push({
                    object: 'block',
                    type: 'toggle',
                    toggle: {
                        rich_text: [{ type: 'text', text: { content: '📋 전사 원본' } }],
                        children: this.splitText(transcript, 1900).map(chunk => ({
                            object: 'block',
                            type: 'paragraph',
                            paragraph: {
                                rich_text: [{ type: 'text', text: { content: chunk } }]
                            }
                        }))
                    }
                });
            }

            // 요약
            if (summary) {
                children.push({
                    object: 'block',
                    type: 'callout',
                    callout: {
                        rich_text: [{ type: 'text', text: { content: summary.substring(0, 1900) } }],
                        icon: { emoji: '📌' }
                    }
                });
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

            if (error.code === 'validation_error') {
                throw new Error(`노션 데이터베이스 속성 오류: ${error.message}`);
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
