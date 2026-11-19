import { createServerTool } from "./server-tool.js";

const time = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" };

export function createScheduleToolDefinitions() {
  return [
    createServerTool({
      operation: "schedule.context",
      name: "schedule_context",
      description:
        "Read the current local date, local time, and panel-configured IANA time zone when the owner asks to schedule a reminder or recurring task. Use this to resolve relative dates and times. Tell the owner which zone applies. To use a different zone, ask the owner to update Schedule time zone in the panel first.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }),
    createServerTool({
      operation: "schedule.propose",
      name: "schedule_propose",
      description:
        "When the owner explicitly requests future or recurring work, propose one schedule for this agent. Ordinary requests to run a task now do not need this tool. Read schedule_context first and use its timeZone. If the requested zone differs, ask the owner to update the panel setting before proposing. Ask the owner for missing or ambiguous date, time, frequency, or task details before proposing. Supply a short name and a standalone prompt for the scheduled run. For a reminder, the prompt should ask the agent to notify the owner at run time. The server sends its own preview with Confirm and Cancel buttons. If awaiting_confirmation is returned, tell the owner to use the buttons. Only confirmation in Telegram saves the schedule.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          prompt: { type: "string", minLength: 1, maxLength: 4000 },
          timeZone: { type: "string" },
          cadence: {
            type: "object",
            oneOf: [
              {
                properties: {
                  kind: { const: "once" },
                  date: { type: "string", format: "date" },
                  time,
                },
                required: ["kind", "date", "time"],
                additionalProperties: false,
              },
              {
                properties: { kind: { const: "daily" }, time },
                required: ["kind", "time"],
                additionalProperties: false,
              },
              {
                properties: {
                  kind: { const: "weekly" },
                  time,
                  weekdays: {
                    type: "array",
                    items: { type: "integer", minimum: 0, maximum: 6 },
                    minItems: 1,
                    maxItems: 7,
                    description: "Sunday = 0 through Saturday = 6.",
                  },
                },
                required: ["kind", "time", "weekdays"],
                additionalProperties: false,
              },
              {
                properties: {
                  kind: { const: "interval" },
                  minutes: { type: "integer", minimum: 15 },
                },
                required: ["kind", "minutes"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["name", "prompt", "timeZone", "cadence"],
        additionalProperties: false,
      },
    }),
  ];
}
