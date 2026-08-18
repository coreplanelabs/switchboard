import type { Provider, ProviderConfig } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openaiCompat.js";

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  constructor(configs: Record<string, ProviderConfig>) {
    for (const [name, cfg] of Object.entries(configs)) {
      switch (cfg.type) {
        case "anthropic":
          this.providers.set(name, new AnthropicProvider(name, cfg));
          break;
        case "openai-compatible":
          this.providers.set(name, new OpenAICompatProvider(name, cfg));
          break;
        default:
          throw new Error(`Unknown provider type "${(cfg as ProviderConfig).type}" for "${name}"`);
      }
    }
  }

  get(name: string): Provider {
    const p = this.providers.get(name);
    if (!p) {
      throw new Error(
        `Unknown provider "${name}". Configured providers: ${[...this.providers.keys()].join(", ")}`,
      );
    }
    return p;
  }

  names(): string[] {
    return [...this.providers.keys()];
  }
}
