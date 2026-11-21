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
        "Propose one schedule only when the owner requests future or recurring work. Read schedule_context first and use its timeZone. Ask the owner to update the panel if they want a different zone. Clarify missing or ambiguous timing or task details. Provide a short name and standalone prompt. For reminders, ask the agent to notify the owner at run time. On awaiting_confirmation, tell the owner to use Confirm or Cancel in this chat. Confirm saves delivery to this chat's channel.",
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
