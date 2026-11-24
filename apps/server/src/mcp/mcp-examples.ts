export interface McpExample {
  id: string;
  label: string;
  description: string;
  endpoint: string;
  requiresBearerCredential?: true;
}

export const mcpExamples: readonly McpExample[] = [
  {
    id: "context7",
    label: "Context7",
    description: "Find current library documentation and code examples.",
    endpoint: "https://mcp.context7.com/mcp",
  },
  {
    id: "deepwiki",
    label: "DeepWiki",
    description: "Explore and ask questions about public GitHub repositories.",
    endpoint: "https://mcp.deepwiki.com/mcp",
  },
  {
    id: "hugging-face",
    label: "Hugging Face",
    description: "Search for public models, datasets, and Spaces.",
    endpoint: "https://huggingface.co/mcp",
  },
  {
    id: "astro-docs",
    label: "Astro Docs",
    description:
      "Search Astro documentation for framework guides and examples.",
    endpoint: "https://mcp.docs.astro.build/mcp",
  },
  {
    id: "autodesk-product-help",
    label: "Autodesk Product Help",
    description:
      "Search official help for Autodesk products, including Fusion and AutoCAD.",
    endpoint: "https://api.aps.autodesk.com/knowledge/public/v1/mcp",
  },
  {
    id: "aws-knowledge",
    label: "AWS Knowledge",
    description:
      "Find AWS documentation and check regional service availability.",
    endpoint: "https://knowledge-mcp.global.api.aws",
  },
  {
    id: "claude-code-docs",
    label: "Claude Code Docs",
    description:
      "Search Claude Code documentation for commands and configuration.",
    endpoint: "https://code.claude.com/docs/mcp",
  },
  {
    id: "cloudflare-docs",
    label: "Cloudflare Docs",
    description:
      "Search Cloudflare documentation for Workers, networking, and other platform features.",
    endpoint: "https://docs.mcp.cloudflare.com/mcp",
  },
  {
    id: "exa-search",
    label: "Exa Search",
    description: "Search the web and retrieve page content.",
    endpoint: "https://mcp.exa.ai/mcp",
  },
  {
    id: "firecrawl-docs",
    label: "Firecrawl Docs",
    description: "Look up Firecrawl API guides and web extraction examples.",
    endpoint: "https://docs.firecrawl.dev/mcp",
  },
  {
    id: "github",
    label: "GitHub",
    description:
      "Work with GitHub repositories, issues, and pull requests. Requires a personal access token.",
    endpoint: "https://api.githubcopilot.com/mcp/",
    requiresBearerCredential: true,
  },
  {
    id: "gitmcp",
    label: "GitMCP",
    description: "Search code and documentation in public GitHub repositories.",
    endpoint: "https://gitmcp.io/docs",
  },
  {
    id: "langchain-docs",
    label: "LangChain Docs",
    description: "Find guides for LangChain, LangGraph, and related tools.",
    endpoint: "https://docs.langchain.com/mcp",
  },
  {
    id: "mcp-docs",
    label: "Model Context Protocol Docs",
    description: "Read the MCP specification and implementation guides.",
    endpoint: "https://modelcontextprotocol.io/mcp",
  },
  {
    id: "microsoft-learn",
    label: "Microsoft Learn",
    description: "Search Microsoft documentation and find code samples.",
    endpoint: "https://learn.microsoft.com/api/mcp",
  },
  {
    id: "notion-developer-docs",
    label: "Notion Developer Docs",
    description:
      "Look up the Notion API, integration guides, and request examples.",
    endpoint: "https://developers.notion.com/mcp",
  },
  {
    id: "nuxt-docs",
    label: "Nuxt Docs",
    description:
      "Browse Nuxt guides, modules, releases, and deployment providers.",
    endpoint: "https://nuxt.com/mcp",
  },
  {
    id: "nuxt-ui",
    label: "Nuxt UI",
    description:
      "Find Nuxt UI components, templates, examples, and migration guides.",
    endpoint: "https://ui.nuxt.com/mcp",
  },
  {
    id: "openai-docs",
    label: "OpenAI Docs",
    description:
      "Look up OpenAI developer guides, API endpoints, and specifications.",
    endpoint: "https://developers.openai.com/mcp",
  },
  {
    id: "open-meteo",
    label: "Open-Meteo",
    description: "Look up weather forecasts and air quality for a location.",
    endpoint: "https://weather.chukai.io/mcp",
  },
  {
    id: "perplexity-docs",
    label: "Perplexity Docs",
    description: "Search Perplexity API documentation and integration guides.",
    endpoint: "https://docs.perplexity.ai/mcp",
  },
  {
    id: "pinecone-docs",
    label: "Pinecone Docs",
    description:
      "Find Pinecone guides for vector search, indexes, and API usage.",
    endpoint: "https://docs.pinecone.io/mcp",
  },
  {
    id: "svelte",
    label: "Svelte",
    description:
      "Search Svelte and SvelteKit documentation or check Svelte source.",
    endpoint: "https://mcp.svelte.dev/mcp",
  },
  {
    id: "tavily-docs",
    label: "Tavily Docs",
    description: "Find API guides for Tavily search and content extraction.",
    endpoint: "https://docs.tavily.com/mcp",
  },
];
