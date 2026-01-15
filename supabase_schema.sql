-- =====================================================
-- MetaGrabber Supabase Schema
-- =====================================================

-- UUID 확장 활성화
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. 페르소나 테이블 (instructors)
-- =====================================================
CREATE TABLE IF NOT EXISTS instructors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    info TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 2. 설정 테이블 (settings)
-- =====================================================
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- RLS 정책
-- =====================================================
ALTER TABLE instructors ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for instructors" ON instructors FOR ALL USING (true);
CREATE POLICY "Enable all for settings" ON settings FOR ALL USING (true);
