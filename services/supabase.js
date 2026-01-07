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
}

module.exports = new SupabaseService();
