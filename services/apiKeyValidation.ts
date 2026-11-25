export const GOOGLE_AI_API_KEY_PATTERN = /^(?:AIza|AQ)\S{10,}$/;

export const normalizeGoogleAiApiKey = (key: string): string => {
  return (key || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^(?:(?:vite_)?(?:gemini_)?api[_-]?key|key)\s*[=:]\s*/i, '')
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, '');
};

export const isValidGoogleAiApiKey = (key: string): boolean => {
  return GOOGLE_AI_API_KEY_PATTERN.test(normalizeGoogleAiApiKey(key));
};

export const maskGoogleAiApiKey = (key: string): string => {
  const normalized = normalizeGoogleAiApiKey(key);
  if (normalized.length <= 10) return '••••••••';
  const prefixLen = normalized.startsWith('AIzaSy') ? 6 : normalized.startsWith('AIza') ? 4 : 2;
  return `${normalized.slice(0, prefixLen)}...${normalized.slice(-4)}`;
};
