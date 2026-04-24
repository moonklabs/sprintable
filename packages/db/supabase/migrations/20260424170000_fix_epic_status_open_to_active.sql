-- Migrate any epics with status='open' (invalid) to 'active'
-- Root cause: SupabaseEpicRepository.create() used 'open' as default before this fix
UPDATE epics SET status = 'active' WHERE status = 'open';
