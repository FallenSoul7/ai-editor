import { ProviderRegistry, DEFAULT_CAPABILITIES } from './registry.js';
import veniceProvider from './venice.js';
import openRouterProvider from './openrouter.js';
import ollamaProvider from './ollama.js';
import geminiProvider from './gemini.js';
import groqProvider from './groq.js';

ProviderRegistry.register(veniceProvider);
ProviderRegistry.register(openRouterProvider);
ProviderRegistry.register(ollamaProvider);
ProviderRegistry.register(geminiProvider);
ProviderRegistry.register(groqProvider);

export { ProviderRegistry, DEFAULT_CAPABILITIES };
