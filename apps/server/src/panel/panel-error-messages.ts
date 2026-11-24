export const panelErrorMessages = {
  origin_not_allowed: "Origin not allowed.",
  request_too_large: "Request too large.",
  login_rate_limited: "Too many attempts. Try again in 15 minutes.",
  incorrect_password: "Incorrect password. Try again.",
  unauthorized: "Unauthorized",
  agent_not_found: "Agent not found.",
  schedules_unavailable: "Schedules unavailable.",
  schedule_form_required: "Use form data for schedule requests.",
  invalid_schedule_form: "Invalid schedule form data.",
  schedule_zone_required: "Enter a schedule time zone.",
  unknown_schedule_field: "Unknown schedule field.",
  schedule_fields_required: "Enter a name, prompt, cadence, and time zone.",
  invalid_cadence_json: "Cadence must be valid JSON.",
  unknown_cadence_field: "Unknown cadence field.",
  invalid_cadence: "Invalid cadence.",
  schedule_not_found: "Schedule not found.",
  webhook_schedule_not_found: "Webhook schedule not found.",
  unexpected_form_fields: "This action does not accept form fields.",
  schedule_changed: "Schedule changed. Refresh before running it again.",
  scheduled_execution_unavailable:
    "Scheduled execution is unavailable. Refresh and try again.",
  invalid_login_attempt: "Invalid login attempt.",
  unknown_provider: "Unknown provider.",
  invalid_api_key_format:
    "Enter an API key of 1–4096 characters without whitespace.",
  model_settings_unavailable: "Model settings unavailable.",
  invalid_model_selection: "Invalid model selection.",
  model_catalog_unavailable:
    "Model catalog unavailable. Start the agent and try again.",
  reasoning_effort_unavailable:
    "That reasoning effort is unavailable for this model.",
  model_unavailable: "That model is unavailable for this agent.",
  invalid_usage_range: "Invalid usage range.",
  usage_unavailable: "Usage unavailable.",
  invalid_usage_page: "Invalid usage page.",
  peers_unavailable: "Peers unavailable.",
  invalid_grant: "Invalid grant.",
  grant_not_found: "Grant not found.",
  grant_owner_mismatch: "Choose a different agent that shares the same owner.",
  approvals_unavailable: "Approvals unavailable.",
  delegations_unavailable: "Delegations unavailable.",
  invalid_delegation_id: "Invalid delegation ID.",
  delegation_not_found: "Delegation not found.",
  delegation_not_cancellable: "Delegation is no longer cancellable.",
  delegation_cancellation_unavailable: "Delegation cancellation unavailable.",
  invalid_rule: "Invalid rule.",
  rule_not_found: "Rule not found.",
  memory_unavailable: "Memory unavailable.",
  invalid_execution_cursor: "Invalid execution cursor.",
  execution_not_found: "Execution not found.",
  avatar_unavailable: "Avatar unavailable.",
  invalid_agent_rule: "Enter Markdown of up to 4000 characters.",
  agent_rule_scope_limit:
    "Rules in this list may use up to 16000 characters combined, including spacing between rules.",
  agent_rule_not_found: "This rule or agent is no longer available.",
  invalid_agent_details:
    "Enter a name of up to 128 characters and instructions of up to 4000 characters.",
  agent_save_failed: "Could not save the changes. Try again.",
  discord_owner_id_invalid:
    "Copy the user ID from your personal Discord profile and paste it here.",
  discord_token_invalid:
    "Paste the bot token from your app’s Bot settings in the Discord Developer Portal.",
  discord_token_rejected:
    "Discord rejected the bot token. Copy the current token from your app’s Bot settings and try again.",
  discord_bot_already_assigned:
    "This Discord bot is linked to another agent. Use a different bot or disconnect it from the other agent first.",
  discord_save_failed: "Could not save Discord. Wait a moment and try again.",
  invalid_notification_request_id: "Enter a valid notification request ID.",
  discord_delivery_unconfirmed:
    "Delivery could not be confirmed. Retry with the same request ID to check its status.",
  discord_remove_confirmation: "Confirm the agent ID to remove Discord.",
  discord_remove_failed: "Could not remove Discord. Refresh and try again.",
  invalid_telegram_credentials:
    "Enter a valid Telegram owner ID and bot token.",
  telegram_connect_failed:
    "Could not connect Telegram. Check the owner ID, token, and whether the bot is already linked.",
  invalid_replacement_token: "Enter a valid token for the same bot.",
  token_save_failed:
    "Could not save the token. Enter a valid token for the same bot.",
  invalid_agent_settings: "Invalid agent settings",
  agent_create_failed:
    "Could not create the agent. Check its settings and any supplied Telegram connection.",
  agent_delete_confirmation:
    "Confirm the agent ID and explicitly select whether to delete data",
  agent_delete_failed: "Deletion failed; retry after checking the agent",
  invalid_process_action:
    "Select start, stop or restart; stopping and restarting require confirmation of the agent ID",
  process_action_failed:
    "Agent Host action failed. Refresh its status before trying again.",
  invalid_memory_request: "Invalid memory request.",
  memory_not_found: "Memory not found. Refresh the list.",
  host_memory_unavailable:
    "Memory unavailable. Start the agent and refresh to try again.",
  invalid_provider_request: "Invalid provider request.",
  provider_key_denied: "The provider denied access with this API key.",
  provider_key_rejected: "The provider rejected the API key.",
  provider_key_rate_limited:
    "The provider rate limited the API key check. Try again shortly.",
  provider_key_check_failed:
    "Could not validate the API key. Try again when the provider is available.",
  login_attempt_not_found: "Login attempt not found. Start a new login.",
  authentication_change_in_progress:
    "An authentication change is in progress. Try again when it finishes.",
  provider_opencode_missing:
    "OpenCode is missing from Nimbot’s PATH. Install OpenCode 2.2.7 and restart Nimbot.",
  provider_opencode_start_failed:
    "OpenCode failed to start. Check that Nimbot is using OpenCode 2.2.7, then restart Nimbot.",
  provider_opencode_start_timeout:
    "OpenCode did not become ready in time. Check the OpenCode installation and refresh.",
  provider_opencode_check_failed:
    "OpenCode could not read provider settings. Check that Nimbot is using OpenCode 2.2.7.",
  provider_settings_unavailable:
    "Provider settings unavailable. Check the Nimbot Server logs and refresh.",
  request_failed: "The request could not be completed.",
  mcp_json_required: "Use application/json for MCP requests.",
  invalid_mcp_request: "Invalid MCP request data.",
  mcp_settings_changed: "MCP settings changed. Refresh and try again.",
  mcp_unavailable: "MCP settings are unavailable.",
  mcp_example_not_found: "MCP example not found.",
  mcp_definition_not_found: "MCP definition not found.",
  invalid_mcp_discovery_credential: "Invalid discovery credential selection.",
  invalid_mcp_bearer_credential:
    "Enter a bearer credential without whitespace.",
  invalid_schedule_name: "Name must contain 1 to 60 characters.",
  invalid_schedule_prompt: "Prompt must contain 1 to 4000 characters.",
  invalid_schedule_channel: "Choose Telegram or Discord for delivery.",
  invalid_limit: "Limit must be a positive integer.",
  schedule_owner_chat_required:
    "Scheduled tasks require a linked owner chat on the delivery channel.",
  schedule_agent_id_required: "Agent ID is required.",
  schedule_limit_reached: "An agent can have at most 20 schedules.",
  invalid_time_zone: "Time zone must be a valid IANA time zone name.",
  schedule_zone_changed:
    "The schedule time zone changed. Ask for the schedule again.",
  schedule_first_run_passed:
    "The first run time has passed. Ask for the schedule again.",
  invalid_schedule_enabled: "Enabled must be a boolean.",
  cron_field_count:
    "Cron expression must have five fields or use a supported macro.",
  cron_interval_too_short: "Cron minutes must be at least 15 minutes apart.",
  cadence_object_required: "Cadence must be an object.",
  cron_text_required: "Cron expression must be text.",
  invalid_schedule_interval:
    "Interval must be a whole number of at least 15 minutes.",
  invalid_interval_anchor: "Interval anchor must be a valid UTC timestamp.",
  unknown_cadence_kind: "Unknown schedule cadence kind.",
  invalid_schedule_time: "Time must use HH:mm in the range 00:00 to 23:59.",
  invalid_schedule_date:
    "Date must be a valid calendar date in YYYY-MM-DD format.",
  invalid_schedule_weekdays:
    "Select at least one weekday (Sunday = 0 to Saturday = 6).",
  no_future_schedule_occurrence:
    "Schedule must have an occurrence in the future.",
  schedule_local_time_unresolved: "Unable to resolve schedule local time.",
  invalid_schedule_timestamp: "After must be a valid UTC timestamp.",
  schedule_occurrence_unavailable:
    "Unable to find the next schedule occurrence.",
  invalid_mcp_definition: "Invalid MCP definition.",
  invalid_mcp_endpoint: "Use an HTTPS endpoint without embedded credentials.",
  mcp_endpoint_too_long: "MCP endpoint is too long.",
  invalid_mcp_tool: "Invalid MCP tool definition.",
  mcp_schema_too_large: "MCP tool schema is too large.",
  unsupported_mcp_schema: "Invalid or unsupported MCP tool schema.",
  mcp_tool_data_too_large: "MCP definition has too much tool data.",
  invalid_mcp_tool_review: "Invalid MCP tool review selection.",
  mcp_catalog_full: "MCP catalog is full.",
  invalid_mcp_revision: "Invalid MCP definition revision.",
  approval_allow_requires_read_only:
    "Always allow is only available for read-only actions",
  approval_rule_limit_reached: "Too many rules",
} as const;
