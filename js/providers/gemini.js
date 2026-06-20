import { DEFAULT_CAPABILITIES } from './registry.js';

export default {
  id: 'gemini',
  name: 'Google Gemini',
  description: 'Free Gemini models via Google AI Studio.',
  defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
  settingsKey: 'geminiParameters',
  parseModels(raw) {
    return raw.map(m => ({
      id: m.id || String(m),
      name: m.name || m.id,
      type: 'text',
      capabilities: { ...DEFAULT_CAPABILITIES, supportsVision: true, supportsFunctionCalling: true },
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
