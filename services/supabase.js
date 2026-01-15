const { createClient } = require('@supabase/supabase-js');

class SupabaseService {
    constructor() {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_KEY;

        if (url && key) {
            this.client = createClient(url, key);
            this.enabled = true;
            console.log('[Supabase] 연결됨');
        } else {
            this.enabled = false;
            console.log('[Supabase] 환경변수 없음 - 로컬 파일 모드');
        }
    }

    async getSession(key) {
        if (!this.enabled) return null;

        try {
            const { data, error } = await this.client
                .from('settings')
                .select('value')
                .eq('key', key)
                .single();

            if (error) {
                if (error.code === 'PGRST116') return null; // not found
                console.log('[Supabase] 조회 에러:', error.message);
                return null;
            }
            return data?.value || null;
        } catch (e) {
            console.log('[Supabase] 에러:', e.message);
            return null;
        }
    }

    async setSession(key, value) {
        if (!this.enabled) return false;

        try {
            const { error } = await this.client
                .from('settings')
                .upsert({ key, value, updated_at: new Date().toISOString() });

            if (error) {
                console.log('[Supabase] 저장 에러:', error.message);
                return false;
            }
            return true;
        } catch (e) {
            console.log('[Supabase] 에러:', e.message);
            return false;
        }
    }

    // ===== 페르소나 관리 =====
    async getInstructors() {
        if (!this.enabled) return [];

        try {
            const { data, error } = await this.client
                .from('instructors')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) {
                console.log('[Supabase] 페르소나 목록 조회 에러:', error.message);
                return [];
            }
            return data || [];
        } catch (e) {
            console.log('[Supabase] 에러:', e.message);
            return [];
        }
    }

    async addInstructor(name, info) {
        if (!this.enabled) return null;

        try {
            const { data, error } = await this.client
                .from('instructors')
                .insert({ name, info })
                .select()
                .single();

            if (error) {
                console.log('[Supabase] 페르소나 추가 에러:', error.message);
                return null;
            }
            return data;
        } catch (e) {
            console.log('[Supabase] 에러:', e.message);
            return null;
        }
    }

    async updateInstructor(id, name, info) {
        if (!this.enabled) return false;

        try {
            const { error } = await this.client
                .from('instructors')
                .update({ name, info })
                .eq('id', id);

            if (error) {
                console.log('[Supabase] 페르소나 수정 에러:', error.message);
                return false;
            }
            return true;
        } catch (e) {
            console.log('[Supabase] 에러:', e.message);
            return false;
        }
    }

    async deleteInstructor(id) {
        if (!this.enabled) return false;

        try {
            const { error } = await this.client
                .from('instructors')
                .delete()
                .eq('id', id);

            if (error) {
                console.log('[Supabase] 페르소나 삭제 에러:', error.message);
                return false;
            }
            return true;
        } catch (e) {
            console.log('[Supabase] 에러:', e.message);
            return false;
        }
    }

    // ===== 지침(프롬프트) 관리 =====
    async getPrompt() {
        return await this.getSession('script_prompt');
    }

    async setPrompt(prompt) {
        return await this.setSession('script_prompt', prompt);
    }

    // ===== Notion URL 관리 =====
    async getNotionUrl() {
        return await this.getSession('notion_db_url');
    }

    async setNotionUrl(url) {
        return await this.setSession('notion_db_url', url);
    }

    // ===== 선택된 페르소나 관리 =====
    async getSelectedInstructor() {
        return await this.getSession('selected_instructor');
    }

    async setSelectedInstructor(instructorId) {
        return await this.setSession('selected_instructor', instructorId);
    }
}

module.exports = new SupabaseService();
