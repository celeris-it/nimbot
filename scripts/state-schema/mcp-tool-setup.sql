ALTER TABLE mcp_definitions ADD COLUMN tool_setup TEXT NOT NULL DEFAULT 'manual'
  CHECK (tool_setup IN ('manual', 'pending', 'ready'));
