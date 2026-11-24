export function taskPromptWithInstructions({
  prompt,
  sharedRules,
  instructions,
  agentRules,
}: {
  prompt: string;
  sharedRules?: string;
  instructions?: string;
  agentRules?: string;
}): string {
  const sections: string[] = [];
  if (sharedRules?.trim())
    sections.push(`Shared rules (defaults):\n${sharedRules}`);
  if (instructions?.trim())
    sections.push(`Agent instructions:\n${instructions}`);
  if (agentRules?.trim()) sections.push(`Agent rules:\n${agentRules}`);
  if (sections.length === 0) return prompt;
  if (sharedRules?.trim() && (instructions?.trim() || agentRules?.trim()))
    sections.unshift(
      "Follow the agent instructions and agent rules wherever they conflict with the shared rules.",
    );
  return [...sections, `User task:\n${prompt}`].join("\n\n");
}
