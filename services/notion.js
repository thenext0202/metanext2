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

    // 블록과 그 children을 재귀적으로 복사하는 헬퍼 함수
    async copyBlockWithChildren(client, block) {
        // 메타데이터 제거
        const { id, parent, created_time, last_edited_time, created_by, last_edited_by, has_children, archived, in_trash, request_id, ...rest } = block;

        // children이 있으면 재귀적으로 가져오기
        if (block.has_children && block.id) {
            const childrenResponse = await client.blocks.children.list({
                block_id: block.id
            });

            if (childrenResponse.results?.length > 0) {
                const copiedChildren = await Promise.all(
                    childrenResponse.results.map(child => this.copyBlockWithChildren(client, child))
                );

                // 블록 타입에 따라 children 설정
                if (rest.type === 'callout' && rest.callout) {
                    rest.callout.children = copiedChildren;
                } else if (rest.type === 'paragraph' && rest.paragraph) {
                    rest.paragraph.children = copiedChildren;
                } else if (rest.type === 'bulleted_list_item' && rest.bulleted_list_item) {
                    rest.bulleted_list_item.children = copiedChildren;
                } else if (rest.type === 'numbered_list_item' && rest.numbered_list_item) {
                    rest.numbered_list_item.children = copiedChildren;
                } else if (rest.type === 'toggle' && rest.toggle) {
                    rest.toggle.children = copiedChildren;
                }
            }
        }

        return rest;
    }

    // 기존 페이지에 블록 추가 (2열 레이아웃 지원)
    async appendBlocksToPage(pageId, newColumn) {
        const client = this.getClient();

        try {
            console.log('[Notion] 페이지에 블록 추가:', pageId);

            // 1. 페이지의 기존 블록들 조회
            const existingBlocks = await client.blocks.children.list({
                block_id: pageId
            });

            console.log('[Notion] 기존 블록 수:', existingBlocks.results?.length || 0);

            // 2. 마지막 블록이 column_list이고 두 번째 열이 비어있는지 확인
            const lastBlock = existingBlocks.results?.[existingBlocks.results.length - 1];

            if (lastBlock && lastBlock.type === 'column_list') {
                // column_list의 자식(column들) 조회
                const columns = await client.blocks.children.list({
                    block_id: lastBlock.id
                });

                console.log('[Notion] 마지막 column_list의 열 수:', columns.results?.length || 0);

                // 2열이고, 두 번째 열이 비어있는지 확인
                if (columns.results?.length === 2) {
                    const secondColumn = columns.results[1];
                    const secondColumnContent = await client.blocks.children.list({
                        block_id: secondColumn.id
                    });

                    // 두 번째 열이 비어있는지 확인 (빈 paragraph만 있거나 내용이 없음)
                    const isSecondColumnEmpty =
                        secondColumnContent.results?.length === 0 ||
                        (secondColumnContent.results?.length === 1 &&
                         secondColumnContent.results[0].type === 'paragraph' &&
                         (!secondColumnContent.results[0].paragraph?.rich_text?.length));

                    console.log('[Notion] 두 번째 열 비어있음:', isSecondColumnEmpty);

                    if (isSecondColumnEmpty) {
                        console.log('[Notion] 빈 두 번째 열 발견 - 내용 채우기');

                        // 첫 번째 column의 내용 가져오기 (재귀적으로 children 포함)
                        const firstColumn = columns.results[0];
                        const firstColumnContent = await client.blocks.children.list({
                            block_id: firstColumn.id
                        });

                        // 기존 블록들을 재귀적으로 복사 (children 포함)
                        const existingChildren = await Promise.all(
                            (firstColumnContent.results || []).map(block =>
                                this.copyBlockWithChildren(client, block)
                            )
                        );

                        // 기존 column_list 삭제
                        await client.blocks.delete({ block_id: lastBlock.id });

                        // 2열 column_list 재생성 (두 번째 열에 새 내용)
                        const twoColumnList = {
                            object: 'block',
                            type: 'column_list',
                            column_list: {
                                children: [
                                    {
                                        object: 'block',
                                        type: 'column',
                                        column: {
                                            children: existingChildren.length > 0 ? existingChildren : [{
                                                object: 'block',
                                                type: 'paragraph',
                                                paragraph: { rich_text: [] }
                                            }]
                                        }
                                    },
                                    {
                                        object: 'block',
                                        type: 'column',
                                        column: {
                                            children: newColumn
                                        }
                                    }
                                ]
                            }
                        };

                        const response = await client.blocks.children.append({
                            block_id: pageId,
                            children: [twoColumnList]
                        });

                        console.log('[Notion] 2열 column_list 완성');
                        return response;
                    }
                }
            }

            // 3. 새 2열 column_list 추가 (두 번째 열은 빈 placeholder)
            console.log('[Notion] 새 2열 column_list 생성 (두 번째 열 비움)');
            const twoColumnListNew = {
                object: 'block',
                type: 'column_list',
                column_list: {
                    children: [
                        {
                            object: 'block',
                            type: 'column',
                            column: {
                                children: newColumn
                            }
                        },
                        {
                            object: 'block',
                            type: 'column',
                            column: {
                                children: [{
                                    object: 'block',
                                    type: 'paragraph',
                                    paragraph: {
                                        rich_text: []
                                    }
                                }]
                            }
                        }
                    ]
                }
            };

            const response = await client.blocks.children.append({
                block_id: pageId,
                children: [twoColumnListNew]
            });

            console.log('[Notion] 블록 추가 완료');
            return response;
        } catch (error) {
            console.error('[Notion] 블록 추가 실패:', error.message);
            throw error;
        }
    }

    // 비디오 + 스크립트 블록 생성 (column 내용물만 반환)
    createVideoScriptBlock(videoUrl, scriptText) {
        // 스크립트 텍스트를 청크로 분할
        const textChunks = this.splitText(scriptText || '', 1900);

        // 텍스트 블록들 생성
        const textBlocks = textChunks.map(chunk => ({
            object: 'block',
            type: 'paragraph',
            paragraph: {
                rich_text: [{ type: 'text', text: { content: chunk } }]
            }
        }));

        // 동영상 블록 (Google Drive URL은 embed 블록 사용)
        let videoBlock;
        if (!videoUrl) {
            videoBlock = {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{ type: 'text', text: { content: '(동영상 URL 없음)' } }]
                }
            };
        } else if (videoUrl.includes('drive.google.com')) {
            // Google Drive URL은 embed 블록으로 (video 블록은 직접 재생 URL 필요)
            videoBlock = {
                object: 'block',
                type: 'embed',
                embed: {
                    url: videoUrl
                }
            };
        } else {
            // 일반 URL은 video 블록
            videoBlock = {
                object: 'block',
                type: 'video',
                video: {
                    type: 'external',
                    external: {
                        url: videoUrl
                    }
                }
            };
        }

        // column 내용물 반환 (비디오 + 텍스트들)
        return [videoBlock, ...textBlocks];
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
            console.log('[Notion] videoUrl:', videoUrl);
            console.log('[Notion] correctedText 길이:', correctedText?.length || 0);
            console.log('[Notion] transcript 길이:', transcript?.length || 0);
            const scriptToUse = correctedText || transcript;
            console.log('[Notion] 사용할 스크립트 길이:', scriptToUse?.length || 0);
            const newBlocks = this.createVideoScriptBlock(videoUrl, scriptToUse);
            console.log('[Notion] 생성된 블록:', JSON.stringify(newBlocks, null, 2));

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
