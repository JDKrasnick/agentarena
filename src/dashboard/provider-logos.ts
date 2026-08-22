import { createRequire } from "node:module";

export interface ProviderBrand {
  id: string;
  name: string;
  owner: string;
  aliases: readonly string[];
  iconPath: string;
}

const require = createRequire(import.meta.url);

function icon(file: string): string {
  return require.resolve(`@lobehub/icons-static-png/dark/${file}`);
}

export const MAJOR_PROVIDER_BRANDS: readonly ProviderBrand[] = [
  {
    id: "openai",
    name: "Codex",
    owner: "OpenAI",
    aliases: ["codex", "openai", "chatgpt", "gpt"],
    iconPath: icon("openai.png"),
  },
  {
    id: "anthropic",
    name: "Claude",
    owner: "Anthropic",
    aliases: ["claude", "claude-code", "claudecode", "anthropic"],
    iconPath: icon("claude-color.png"),
  },
  {
    id: "google",
    name: "Gemini",
    owner: "Google",
    aliases: ["gemini", "gemini-cli", "geminicli", "google"],
    iconPath: icon("gemini-color.png"),
  },
  {
    id: "xai",
    name: "Grok",
    owner: "xAI",
    aliases: ["grok", "xai", "x.ai"],
    iconPath: icon("grok.png"),
  },
  {
    id: "mistral",
    name: "Mistral",
    owner: "Mistral AI",
    aliases: ["mistral", "mistral-ai", "codestral"],
    iconPath: icon("mistral-color.png"),
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    owner: "DeepSeek",
    aliases: ["deepseek"],
    iconPath: icon("deepseek-color.png"),
  },
  {
    id: "cohere",
    name: "Cohere",
    owner: "Cohere",
    aliases: ["cohere", "command-r", "command"],
    iconPath: icon("cohere-color.png"),
  },
  {
    id: "perplexity",
    name: "Perplexity",
    owner: "Perplexity AI",
    aliases: ["perplexity", "pplx"],
    iconPath: icon("perplexity-color.png"),
  },
  {
    id: "meta",
    name: "Meta AI",
    owner: "Meta",
    aliases: ["meta", "meta-ai", "metaai", "llama"],
    iconPath: icon("meta-color.png"),
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    owner: "GitHub / Microsoft",
    aliases: ["copilot", "github-copilot", "githubcopilot"],
    iconPath: icon("copilot-color.png"),
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    owner: "Amazon Web Services",
    aliases: ["bedrock", "amazon-bedrock", "aws"],
    iconPath: icon("bedrock-color.png"),
  },
  {
    id: "qwen",
    name: "Qwen",
    owner: "Alibaba Cloud",
    aliases: ["qwen", "qwen-code", "alibaba"],
    iconPath: icon("qwen-color.png"),
  },
  {
    id: "nvidia",
    name: "NVIDIA AI",
    owner: "NVIDIA",
    aliases: ["nvidia", "nemotron", "nemo"],
    iconPath: icon("nvidia-color.png"),
  },
  {
    id: "azure",
    name: "Azure AI",
    owner: "Microsoft",
    aliases: ["azure", "azure-ai", "azure-openai", "microsoft"],
    iconPath: icon("azure-color.png"),
  },
  {
    id: "groq",
    name: "Groq",
    owner: "Groq",
    aliases: ["groq", "groqcloud"],
    iconPath: icon("groq.png"),
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    owner: "Hugging Face",
    aliases: ["huggingface", "hugging-face", "hf"],
    iconPath: icon("huggingface-color.png"),
  },
  {
    id: "together",
    name: "Together AI",
    owner: "Together AI",
    aliases: ["together", "together-ai"],
    iconPath: icon("together-color.png"),
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    owner: "Fireworks AI",
    aliases: ["fireworks", "fireworks-ai"],
    iconPath: icon("fireworks-color.png"),
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    owner: "OpenRouter",
    aliases: ["openrouter", "open-router"],
    iconPath: icon("openrouter-color.png"),
  },
  {
    id: "cursor",
    name: "Cursor",
    owner: "Anysphere",
    aliases: ["cursor", "anysphere"],
    iconPath: icon("cursor.png"),
  },
] as const;

export function providerBrand(provider: string): ProviderBrand | undefined {
  const normalized = provider.toLowerCase().replaceAll("_", "-");
  return MAJOR_PROVIDER_BRANDS.find((brand) =>
    brand.aliases.some(
      (alias) => normalized === alias || normalized.startsWith(`${alias}-`),
    ),
  );
}
