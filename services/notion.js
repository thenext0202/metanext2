const { Client } = require('@notionhq/client');

class NotionService {
    constructor() {
        this.databaseId = process.env.NOTION_DATABASE_ID;
        this.enabled = false;
        this.init();
    }

    init() {
        const token = process.env.NOTION_API_TOKEN;
        if (token) {
            this.enabled = true;
            console.log('[Notion] 서비스 활성화됨');
        } else {
            console.log('[Notion] API 토큰이 없습니다. 서비스 비활성화.');
        }
    }

    // 클라이언트 생성 헬퍼
    getClient() {
        const token = process.env.NOTION_API_TOKEN;
        if (!token) {
            throw new Error('Notion API 토큰이 설정되지 않았습니다.');
        }
        const notionClient = new Client({ auth: token });
        console.log('[Notion] 클라이언트 생성됨, databases 존재:', !!notionClient.databases);
        return notionClient;
    }

    // 데이터베이스에서 강사 이름으로 기존 페이지 검색
    async findInstructorPage(databaseId, instructorName) {
        try {
            console.log('[Notion] 강사 페이지 검색:', instructorName);

            // 클라이언트 생성
            const token = process.env.NOTION_API_TOKEN;
            const notionClient = new Client({ auth: token });

            // databases 객체의 사용 가능한 메서드 확인
            console.log('[Notion] databases 메서드:', Object.keys(notionClient.databases || {}));

            // search API 사용 (databases.query 대신)
            const response = await notionClient.search({
                filter: {
                    property: 'object',
                    value: 'page'
                }
            });

            console.log('[Notion] 검색 결과 개수:', response.results?.length || 0);

            if (response.results && response.results.length > 0) {
                // 해당 데이터베이스의 페이지만 필터링
                const dbPages = response.results.filter(page => {
                    const parentDbId = page.parent?.database_id?.replace(/-/g, '');
                    const targetDbId = databaseId.replace(/-/g, '');
                    return parentDbId === targetDbId;
                });

                console.log('[Notion] DB 페이지 개수:', dbPages.length);

                // "XXX 강사 보드" 형태의 페이지 찾기
                for (const page of dbPages) {
                    // 제목 속성 찾기 (어떤 이름이든)
                    let pageTitle = '';
                    for (const [propName, propValue] of Object.entries(page.properties || {})) {
                        if (propValue.type === 'title' && propValue.title?.length > 0) {
                            pageTitle = propValue.title[0].plain_text || '';
                            break;
                        }
                    }

                    console.log('[Notion] 페이지 제목:', pageTitle);

                    // 강사 이름이 포함되고 "강사 보드"가 포함된 페이지 찾기
                    if (pageTitle.includes(instructorName) && pageTitle.includes('강사 보드')) {
                        console.log('[Notion] 기존 강사 페이지 발견:', page.id, pageTitle);
                        return page;
                    }
                }
            }

            console.log('[Notion] 기존 강사 페이지 없음');
            return null;
        } catch (error) {
            console.error('[Notion] 페이지 검색 실패:', error.message);
            console.error('[Notion] 상세:', error);
            return null;
        }
    }

    // 기존 페이지에 블록 추가
    async appendBlocksToPage(pageId, blocks) {
        const client = this.getClient();

        try {
            console.log('[Notion] 페이지에 블록 추가:', pageId);

            const response = await client.blocks.children.append({
                block_id: pageId,
                children: blocks
            });

            console.log('[Notion] 블록 추가 완료');
            return response;
        } catch (error) {
            console.error('[Notion] 블록 추가 실패:', error.message);
            throw error;
        }
    }

    // 비디오 + 스크립트 블록 생성 (사용자 템플릿에 맞는 구조)
    createVideoScriptBlock(videoUrl, scriptText) {
        // 스크립트 텍스트를 청크로 분할
        const textChunks = this.splitText(scriptText || '', 1900);

        // 내부 콜아웃
        const innerCallout = {
            object: 'block',
            type: 'callout',
            callout: {
                rich_text: textChunks.length > 0 ? [{ type: 'text', text: { content: textChunks[0] } }] : [],
                color: 'default'
            }
        };

        // 긴 텍스트면 추가 paragraph 블록
        if (textChunks.length > 1) {
            innerCallout.callout.children = textChunks.slice(1).map(chunk => ({
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{ type: 'text', text: { content: chunk } }]
                }
            }));
        }

        // 외부 콜아웃
        const calloutBlock = {
            object: 'block',
            type: 'callout',
            callout: {
                rich_text: [],
                color: 'gray_background',
                children: [innerCallout]
            }
        };

        // 동영상 블록
        const videoBlock = videoUrl ? {
            object: 'block',
            type: 'video',
            video: {
                type: 'external',
                external: {
                    url: videoUrl
                }
            }
        } : {
            object: 'block',
            type: 'paragraph',
            paragraph: {
                rich_text: [{ type: 'text', text: { content: '(동영상 URL 없음)' } }]
            }
        };

        return [videoBlock, calloutBlock];
    }

    async saveToNotion(data) {
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

        const client = this.getClient();

        try {
            // 1. 기존 강사 페이지 검색
            let existingPage = null;
            if (instructorName) {
                existingPage = await this.findInstructorPage(databaseId, instructorName);
            }

            // 2. 추가할 블록 생성 (비디오 + 스크립트)
            const newBlocks = this.createVideoScriptBlock(videoUrl, correctedText || transcript);

            if (existingPage) {
                // 3a. 기존 페이지에 블록 추가
                await this.appendBlocksToPage(existingPage.id, newBlocks);

                console.log('[Notion] 기존 페이지에 콘텐츠 추가 완료');
                return {
                    success: true,
                    pageId: existingPage.id,
                    url: existingPage.url,
                    isNewPage: false
                };
            } else {
                // 3b. 새 페이지 생성
                const pageTitle = instructorName ? `${instructorName} 강사 보드` : (videoTitle || '새 스크립트');

                console.log('[Notion] 새 페이지 생성:', pageTitle);

                // 기본 속성으로 먼저 시도
                const properties = {};

                // 제목 속성 이름 찾기 위해 데이터베이스 스키마 조회
                try {
                    const dbInfo = await client.databases.retrieve({ database_id: databaseId });
                    let titlePropName = '이름';

                    if (dbInfo.properties) {
                        for (const [name, prop] of Object.entries(dbInfo.properties)) {
                            if (prop.type === 'title') {
                                titlePropName = name;
                                break;
                            }
                        }
                    }

                    console.log('[Notion] 제목 속성 이름:', titlePropName);

                    properties[titlePropName] = {
                        title: [{ text: { content: pageTitle } }]
                    };

                    // 태그, 선택 속성 있으면 추가
                    if (dbInfo.properties['태그']) {
                        properties['태그'] = { multi_select: [{ name: '광고소재' }] };
                    }
                    if (dbInfo.properties['선택'] && instructorName) {
                        properties['선택'] = { select: { name: instructorName } };
                    }
                } catch (schemaError) {
                    console.log('[Notion] 스키마 조회 실패, 기본값 사용');
                    properties['이름'] = {
                        title: [{ text: { content: pageTitle } }]
                    };
                }

                const response = await client.pages.create({
                    parent: { database_id: databaseId },
                    properties: properties,
                    children: newBlocks
                });

                console.log('[Notion] 새 페이지 생성 완료:', response.id);
                return {
                    success: true,
                    pageId: response.id,
                    url: response.url,
                    isNewPage: true
                };
            }
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
        if (!text) return [];

        const chunks = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }

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
