ALTER TABLE mcp_definitions ADD COLUMN secret_ref TEXT;
ALTER TABLE mcp_definitions ADD COLUMN credential_required INTEGER NOT NULL DEFAULT 0
  CHECK (credential_required IN (0, 1));

-- Require administrators to choose the new shared credential for previously authenticated integrations.
UPDATE mcp_definitions SET credential_required = 1
WHERE id IN (SELECT definition_id FROM mcp_grants WHERE secret_ref IS NOT NULL);

INSERT OR IGNORE INTO mcp_retired_secrets (ref)
SELECT secret_ref FROM mcp_grants WHERE secret_ref IS NOT NULL;

DROP TRIGGER mcp_endpoint_change;
DROP TRIGGER mcp_grant_revoked;
DROP TRIGGER mcp_secret_replaced;
DROP TABLE mcp_grants;

CREATE TABLE mcp_agent_access (
  agent_id TEXT NOT NULL,
  definition_id TEXT NOT NULL REFERENCES mcp_definitions(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  scope TEXT NOT NULL,
  PRIMARY KEY (agent_id, definition_id)
);
CREATE TRIGGER mcp_definition_secret_replaced
AFTER UPDATE OF secret_ref ON mcp_definitions
WHEN OLD.secret_ref IS NOT NULL AND OLD.secret_ref IS NOT NEW.secret_ref
BEGIN
  INSERT INTO mcp_retired_secrets (ref) VALUES (OLD.secret_ref);
END;
CREATE TRIGGER mcp_definition_deleted
AFTER DELETE ON mcp_definitions WHEN OLD.secret_ref IS NOT NULL
BEGIN
  INSERT INTO mcp_retired_secrets (ref) VALUES (OLD.secret_ref);
END;
