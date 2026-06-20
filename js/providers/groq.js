import { DEFAULT_CAPABILITIES } from './registry.js';

export default {
  id: 'groq',
  name: 'Groq',
  description: 'Ultra-fast free inference via Groq Cloud.',
  defaultEndpoint: 'https://api.groq.com/openai/v1',
  settingsKey: 'groqParameters',
  parseModels(raw) {
    return raw.map(m => ({
      id: m.id || String(m),
      name: m.name || m.id,
      type: 'text',
      capabilities: { ...DEFAULT_CAPABILITIES, supportsFunctionCalling: true },
      pricing: null,
      meta: {}
    }));
  },
  transformRequest(body) { return body; },
  transformResponse(r) { return r; },
  getHeaders() { return {}; },
  async fetchBalance() { return null; },
  settingsSchema: {}
};
