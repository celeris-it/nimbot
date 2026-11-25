ALTER TABLE mcp_definitions ADD COLUMN local_json TEXT
  CHECK(local_json IS NULL OR json_valid(local_json));
