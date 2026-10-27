-- exact row count of every ordinary table in schema public, one «table<TAB>count» line each, sorted.
-- Same file runs against Cloud SQL (source) and the VM database, then `diff` the two outputs.
SELECT table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint AS n
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
 ORDER BY table_name;
