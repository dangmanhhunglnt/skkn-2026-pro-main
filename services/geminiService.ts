import { GoogleGenAI, Chat } from "@google/genai";
import {
  SYSTEM_INSTRUCTION,
  DEFAULT_GEMINI_MODEL,
  FALLBACK_MODELS,
  AGENT_PLATFORM_FALLBACK_MODELS,
  getModelConfigSafe,
  isGemini3Or4,
  isLiteModel,
  resolveModelAlias,
  type AiProvider,
} from "../constants";
import { TitleAnalysisResult } from '../types';
import { apiKeyManager } from './apiKeyManager';
import { isValidGoogleAiApiKey, maskGoogleAiApiKey, normalizeGoogleAiApiKey } from './apiKeyValidation';

export const SERVER_PROXY_KEY_SENTINEL = '__SERVER_PROXY__';

// ============================================================
// CLIENT FACTORY — điểm duy nhất khởi tạo SDK (api.md §III)
// ============================================================
export const createGoogleAiClient = (
  apiKey: string,
  provider: AiProvider = 'gemini',
): GoogleGenAI => {
  const cleanKey = normalizeGoogleAiApiKey(apiKey);
  if (provider === 'agent-platform') {
    return new GoogleGenAI({ vertexai: true, apiKey: cleanKey });
  }
  return new GoogleGenAI({ apiKey: cleanKey });
};

// ============================================================
// SERVER PROXY STATUS & CLIENT (/api/gemini — api.md §V.2)
// ============================================================
export interface ServerProxyStatus {
  checked: boolean;
  available: boolean;
  keyCount: number;
}

let serverProxyStatus: ServerProxyStatus = {
  checked: false,
  available: false,
  keyCount: 0,
};

const proxyListeners = new Set<(status: ServerProxyStatus) => void>();

export const getServerProxyStatus = (): ServerProxyStatus => ({ ...serverProxyStatus });

export const subscribeServerProxyStatus = (
  listener: (status: ServerProxyStatus) => void,
): (() => void) => {
  proxyListeners.add(listener);
  return () => {
    proxyListeners.delete(listener);
  };
};

const notifyProxyListeners = () => {
  const snapshot = getServerProxyStatus();
  proxyListeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch {
      // ignore
    }
  });
};

export const checkServerProxyAvailable = async (): Promise<ServerProxyStatus> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch('/api/gemini', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await res.json();
          serverProxyStatus = {
            checked: true,
            available: Boolean(data?.available),
            keyCount: typeof data?.keyCount === 'number' ? data.keyCount : 0,
          };
          notifyProxyListeners();
          return getServerProxyStatus();
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Khi chạy vite dev thuần không có /api/gemini thì coi như proxy không bật
  }

  serverProxyStatus = { checked: true, available: false, keyCount: 0 };
  notifyProxyListeners();
  return getServerProxyStatus();
};

const extractGenerationConfigForProxy = (config: any) => {
  if (!config || typeof config !== 'object') return {};
  const { systemInstruction, tools, ...rest } = config;
  return {
    systemInstruction,
    tools,
    generationConfig: Object.keys(rest).length > 0 ? rest : undefined,
  };
};

const callServerProxyGenerate = async (params: {
  model: string;
  contents: any;
  config?: any;
  signal?: AbortSignal;
}): Promise<{ text: string }> => {
  const { systemInstruction, tools, generationConfig } = extractGenerationConfigForProxy(params.config);
  const res = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      contents: params.contents,
      systemInstruction,
      generationConfig,
      tools,
      stream: false,
    }),
    signal: params.signal,
  });

  const rawText = await res.text();
  if (!res.ok) {
    let errMsg = rawText;
    try {
      const parsed = JSON.parse(rawText);
      errMsg = parsed?.error?.message || rawText;
    } catch {
      // keep rawText
    }
    const err: any = new Error(errMsg || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  let data: any = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error('Phản hồi JSON từ Server Proxy không hợp lệ.');
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((p: any) => typeof p?.text === 'string' && !p?.thought)
    .map((p: any) => p.text)
    .join('');

  return { text };
};

async function* callServerProxyStream(params: {
  model: string;
  contents: any;
  config?: any;
  signal?: AbortSignal;
}): AsyncGenerator<{ text: string }, void, unknown> {
  const { systemInstruction, tools, generationConfig } = extractGenerationConfigForProxy(params.config);
  const res = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      contents: params.contents,
      systemInstruction,
      generationConfig,
      tools,
      stream: true,
    }),
    signal: params.signal,
  });

  if (!res.ok || !res.body) {
    const rawText = await res.text().catch(() => '');
    let errMsg = rawText;
    try {
      const parsed = JSON.parse(rawText);
      errMsg = parsed?.error?.message || rawText;
    } catch {
      // keep rawText
    }
    const err: any = new Error(errMsg || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonPayload = trimmed.slice(5).trim();
        if (!jsonPayload || jsonPayload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonPayload);
          const parts = parsed?.candidates?.[0]?.content?.parts || [];
          const chunkText = parts
            .filter((p: any) => typeof p?.text === 'string' && !p?.thought)
            .map((p: any) => p.text)
            .join('');
          if (chunkText) {
            yield { text: chunkText };
          }
        } catch {
          // ignore partial JSON line
        }
      }
    }

    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const jsonPayload = tail.slice(5).trim();
      if (jsonPayload && jsonPayload !== '[DONE]') {
        try {
          const parsed = JSON.parse(jsonPayload);
          const parts = parsed?.candidates?.[0]?.content?.parts || [];
          const chunkText = parts
            .filter((p: any) => typeof p?.text === 'string' && !p?.thought)
            .map((p: any) => p.text)
            .join('');
          if (chunkText) {
            yield { text: chunkText };
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================
// FALLBACK NOTICE PUB/SUB BANNER
// ============================================================
let currentFallbackNotice: string | null = null;
const noticeListeners = new Set<(notice: string | null) => void>();

export const setFallbackNotice = (notice: string | null): void => {
  currentFallbackNotice = notice;
  noticeListeners.forEach((fn) => {
    try {
      fn(currentFallbackNotice);
    } catch {
      // ignore
    }
  });
};

export const getFallbackNotice = (): string | null => currentFallbackNotice;

export const subscribeFallbackNotice = (
  listener: (notice: string | null) => void,
): (() => void) => {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
};

// ============================================================
// PHÂN LOẠI LỖI CHÍNH XÁC (api.md §II)
// ============================================================
export type ApiErrorType =
  | 'MODEL_OVERLOADED'   // 500/502/503/504/overloaded → chuyển model, KHÔNG phạt key
  | 'NOT_FOUND'          // 404 → bỏ qua model hiện tại, chuyển model tiếp
  | 'QUOTA_EXCEEDED'     // 429 RPD → cooldown cặp (key, model) 15 phút, xoay key / đổi model
  | 'RATE_LIMIT'         // 429 RPM → cooldown cặp (key, model) ~65s, xoay key / đổi model
  | 'INVALID_API_KEY'    // 401 / API_KEY_INVALID → đánh dấu key lỗi, xoay sang key tiếp
  | 'PERMISSION_DENIED'  // 403 → xoay sang key tiếp (Gemini) hoặc thử model tiếp (Agent Platform)
  | 'INVALID_ARGUMENT'   // 400 → tự gỡ thinkingConfig/tools nếu liên quan, ngược lại dừng
  | 'NETWORK_ERROR'      // mạng chập chờn → thử tiếp
  | 'UNKNOWN';

export interface ClassifiedApiError {
  type: ApiErrorType;
  statusCode: number;
  retryDelaySec?: number;
  isThinkingConfigError: boolean;
  isToolsError: boolean;
}

const extractHttpStatus = (error: any, rawLower: string): number => {
  const direct = Number(error?.status || error?.code || error?.httpCode || error?.error?.code || 0);
  if ([400, 401, 403, 404, 429, 500, 502, 503, 504].includes(direct)) {
    return direct;
  }
  const match = rawLower.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
  return match ? Number(match[1]) : 0;
};

const extractRetryDelaySec = (rawLower: string): number | undefined => {
  const m1 = rawLower.match(/retrydelay["'\s:]+(\d+(?:\.\d+)?)s/i);
  if (m1) return Math.ceil(Number(m1[1]));
  const m2 = rawLower.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (m2) return Math.ceil(Number(m2[1]));
  return undefined;
};

export const classifyApiError = (error: any): ClassifiedApiError => {
  const msg = String(error?.message || error?.toString?.() || '');
  let serialized = '';
  try {
    serialized = JSON.stringify(error) || '';
  } catch {
    serialized = '';
  }
  const rawLower = `${msg} ${serialized}`.toLowerCase();
  const statusCode = extractHttpStatus(error, rawLower);
  const retryDelaySec = extractRetryDelaySec(rawLower);

  const isThinkingConfigError =
    (statusCode === 400 || rawLower.includes('invalid_argument')) &&
    (rawLower.includes('thinking') || rawLower.includes('thinkinglevel') || rawLower.includes('thinking_config'));

  const isToolsError =
    (statusCode === 400 || rawLower.includes('invalid_argument')) &&
    (rawLower.includes('google_search') || rawLower.includes('googlesearch') || rawLower.includes('tool'));

  // 1. Kiểm tra API_KEY_INVALID TRƯỚC 400 (vì Google trả HTTP 400 kèm reason API_KEY_INVALID)
  if (
    statusCode === 401 ||
    rawLower.includes('api_key_invalid') ||
    rawLower.includes('api key not valid') ||
    rawLower.includes('api_key_expired') ||
    rawLower.includes('unauthenticated')
  ) {
    return { type: 'INVALID_API_KEY', statusCode: statusCode || 401, isThinkingConfigError: false, isToolsError: false };
  }

  // 2. 403 PERMISSION_DENIED
  if (statusCode === 403 || rawLower.includes('permission_denied') || rawLower.includes('forbidden')) {
    return { type: 'PERMISSION_DENIED', statusCode: 403, isThinkingConfigError: false, isToolsError: false };
  }

  // 3. 429 / Quota / Rate Limit
  if (
    statusCode === 429 ||
    rawLower.includes('resource_exhausted') ||
    rawLower.includes('quota') ||
    rawLower.includes('too many requests') ||
    (rawLower.includes('rate') && rawLower.includes('limit'))
  ) {
    const isDailyQuota =
      rawLower.includes('per day') ||
      rawLower.includes('perday') ||
      rawLower.includes('daily') ||
      rawLower.includes('limit: 0');
    const isShortRateLimit =
      !isDailyQuota &&
      ((retryDelaySec !== undefined && retryDelaySec <= 120) ||
        rawLower.includes('per minute') ||
        rawLower.includes('perminute') ||
        rawLower.includes('rate limit') ||
        rawLower.includes('too many requests'));

    return {
      type: isShortRateLimit ? 'RATE_LIMIT' : 'QUOTA_EXCEEDED',
      statusCode: 429,
      retryDelaySec,
      isThinkingConfigError: false,
      isToolsError: false,
    };
  }

  // 4. 404 NOT_FOUND
  if (
    statusCode === 404 ||
    rawLower.includes('not_found') ||
    rawLower.includes('is not found') ||
    rawLower.includes('not supported for generatecontent')
  ) {
    return { type: 'NOT_FOUND', statusCode: 404, isThinkingConfigError: false, isToolsError: false };
  }

  // 5. 500/502/503/504 / Overloaded / Timeout
  if (
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    rawLower.includes('overloaded') ||
    rawLower.includes('unavailable') ||
    rawLower.includes('high demand') ||
    rawLower.includes('try again later') ||
    rawLower.includes('deadline_exceeded') ||
    rawLower.includes('internal error') ||
    rawLower.includes('timeout')
  ) {
    return {
      type: 'MODEL_OVERLOADED',
      statusCode: statusCode || 503,
      retryDelaySec,
      isThinkingConfigError: false,
      isToolsError: false,
    };
  }

  // 6. 400 INVALID_ARGUMENT
  if (statusCode === 400 || rawLower.includes('invalid_argument') || rawLower.includes('bad request')) {
    return {
      type: 'INVALID_ARGUMENT',
      statusCode: 400,
      isThinkingConfigError,
      isToolsError,
    };
  }

  // 7. Network errors
  if (
    rawLower.includes('failed to fetch') ||
    rawLower.includes('networkerror') ||
    rawLower.includes('network error') ||
    rawLower.includes('load failed') ||
    rawLower.includes('econnrefused') ||
    rawLower.includes('econnreset')
  ) {
    return { type: 'NETWORK_ERROR', statusCode: 0, isThinkingConfigError: false, isToolsError: false };
  }

  return { type: 'UNKNOWN', statusCode, isThinkingConfigError: false, isToolsError: false };
};

export const parseApiError = (error: any): ApiErrorType => classifyApiError(error).type;

const FALLBACKABLE_ERRORS: ApiErrorType[] = ['MODEL_OVERLOADED', 'NOT_FOUND', 'NETWORK_ERROR'];

export const isFallbackableError = (errorType: ApiErrorType, provider: AiProvider = 'gemini'): boolean => {
  if (FALLBACKABLE_ERRORS.includes(errorType)) return true;
  if (provider === 'agent-platform' && errorType === 'PERMISSION_DENIED') return true;
  return false;
};

// Hàm tạo thông báo lỗi thân thiện
export const getFriendlyErrorMessage = (error: any): { type: string; title: string; message: string; suggestions: string[] } => {
  const errorType = parseApiError(error);

  switch (errorType) {
    case 'MODEL_OVERLOADED':
      return {
        type: 'overloaded',
        title: '⚡ Máy chủ AI đang cao điểm',
        message: 'Các model dự phòng đều đang quá tải tạm thời. Dữ liệu bạn đã viết vẫn được giữ nguyên.',
        suggestions: [
          '⏳ Đợi 20–30 giây rồi bấm "Thử lại" để tiếp tục ngay từ bước hiện tại',
          '🔑 Thêm nhiều API Key từ các Gmail khác nhau trong Cài đặt để tăng tốc độ xoay vòng'
        ]
      };

    case 'NOT_FOUND':
      return {
        type: 'not_found',
        title: '🔍 Model không khả dụng',
        message: 'Model đang chọn hiện không phản hồi trên tài khoản này.',
        suggestions: [
          '🔄 Mở Cài đặt API Key và chọn Gemini 4 Hydrogen (Mặc định khuyên dùng)',
          '🔑 Kiểm tra lại loại dịch vụ (Gemini API vs Agent Platform API)'
        ]
      };

    case 'QUOTA_EXCEEDED':
      return {
        type: 'quota',
        title: '⚠️ Tất cả API Key & Model miễn phí đều đã chạm hạn mức',
        message: 'Hệ thống đã tự động thử qua toàn bộ kho API Key và 6 model Free Tier nhưng đều đã hết quota hiện tại.',
        suggestions: [
          '🔑 Mở Cài đặt API Key → dán thêm 3–5 API Key miễn phí từ các tài khoản Gmail/Project khác nhau (tối đa 30 key)',
          '🔄 Bấm "Thử lại (đổi key)" sau ít phút khi hạn mức theo phút (RPM) vừa được làm mới',
          '💾 Hoặc bấm "Lưu phiên" ở thanh bên trái để hôm sau mở lại chạy tiếp không mất dữ liệu'
        ]
      };

    case 'RATE_LIMIT':
      return {
        type: 'rate_limit',
        title: '🚦 Vượt giới hạn tốc độ tạm thời (RPM)',
        message: 'Tất cả key hiện tại đang gửi yêu cầu quá nhanh trong 1 phút.',
        suggestions: [
          '⏳ Đợi khoảng 30–60 giây rồi bấm "Thử lại"',
          '🔑 Dán thêm nhiều API Key trong Cài đặt để chia tải tự động không bị nghẽn'
        ]
      };

    case 'INVALID_API_KEY':
      return {
        type: 'auth',
        title: '🔐 API Key không hợp lệ hoặc đã bị thu hồi',
        message: 'API Key đang dùng không hợp lệ hoặc đã hết hạn. Vui lòng kiểm tra trong phần Cài đặt.',
        suggestions: [
          '🔑 Mở Cài đặt API Key → bấm nút "Test" để kiểm tra từng key',
          '🆕 Tạo API Key mới tại Google AI Studio (aistudio.google.com/api-keys) và dán vào kho key'
        ]
      };

    case 'PERMISSION_DENIED':
      return {
        type: 'permission',
        title: '🚫 API Key chưa có quyền truy cập dịch vụ này',
        message: 'Google đã nhận key nhưng dự án hoặc dịch vụ đang chọn chưa được cấp quyền.',
        suggestions: [
          '📋 Nếu bạn dùng key từ Google AI Studio, hãy chọn đúng tab "Gemini API" (không chọn Agent Platform API)',
          '🔧 Nếu dùng Agent Platform API, hãy bật Vertex AI / Agent Platform API và billing trên Google Cloud'
        ]
      };

    case 'INVALID_ARGUMENT':
      return {
        type: 'invalid_arg',
        title: '⚙️ Tham số yêu cầu không hợp lệ',
        message: error?.message || 'Yêu cầu gửi tới AI có tham số vượt giới hạn hoặc không tương thích.',
        suggestions: [
          '🔄 Thử rút gọn bớt tài liệu tham khảo đính kèm nếu quá dài',
          '📋 Chọn model Gemini 4 Hydrogen trong Cài đặt rồi thử lại'
        ]
      };

    case 'NETWORK_ERROR':
      return {
        type: 'network',
        title: '🌐 Lỗi kết nối mạng',
        message: 'Không thể kết nối ổn định đến máy chủ Google AI.',
        suggestions: [
          '📶 Kiểm tra kết nối WiFi/Internet của bạn',
          '🔄 Bấm "Thử lại" — tiến trình của bạn vẫn được giữ nguyên'
        ]
      };

    default:
      return {
        type: 'unknown',
        title: '❌ Đã xảy ra lỗi khi gọi AI',
        message: error?.message || 'Có lỗi không xác định xảy ra khi gọi AI.',
        suggestions: [
          '🔄 Bấm "Thử lại" hoặc kiểm tra kho API Key trong Cài đặt',
          '⏰ Đợi vài giây rồi thực hiện lại'
        ]
      };
  }
};

// ============================================================
// SESSION & CONFIG HELPERS
// ============================================================
let chatSession: Chat | null = null;
let currentApiKey: string | null = null;
let currentSelectedModel: string | null = null;
let currentProvider: AiProvider = 'gemini';
let history: any[] = [];

const normalizeProvider = (provider?: string | null): AiProvider => {
  if (provider === 'agent-platform') return 'agent-platform';
  return 'gemini';
};

export const initializeGeminiChat = (apiKey: string, selectedModel?: string, provider?: AiProvider) => {
  const normProvider = normalizeProvider(provider);
  currentProvider = normProvider;
  currentApiKey = apiKey || null;
  currentSelectedModel = resolveModelAlias(selectedModel, normProvider);
  chatSession = null;
  history = [];
};

/** Cập nhật API key / model / provider mà KHÔNG xóa lịch sử hội thoại (dùng khi retry / xoay key giữa chừng) */
export const updateGeminiConnection = (apiKey: string, selectedModel?: string, provider?: AiProvider) => {
  const normProvider = normalizeProvider(provider || currentProvider);
  currentProvider = normProvider;
  currentApiKey = apiKey || currentApiKey;
  if (selectedModel) {
    currentSelectedModel = resolveModelAlias(selectedModel, normProvider);
  }
  chatSession = null;
};

export const getChatHistory = (): any[] => [...history];

export const setChatHistory = (savedHistory: any[]) => {
  history = Array.isArray(savedHistory) ? [...savedHistory] : [];
};

interface BuildConfigOptions {
  mode?: 'main' | 'aux';
  includeSystemInstruction?: boolean;
  includeSearchTool?: boolean;
  stripThinking?: boolean;
  provider?: AiProvider;
}

const buildRequestConfig = (model: string, opts: BuildConfigOptions = {}): any => {
  const mode = opts.mode || 'main';
  const provider = opts.provider || currentProvider;
  const cfg = getModelConfigSafe(model, mode);
  const config: Record<string, any> = {
    maxOutputTokens: cfg.maxOutputTokens,
  };

  if (opts.includeSystemInstruction) {
    config.systemInstruction = SYSTEM_INSTRUCTION;
  }

  // TUYỆT ĐỐI KHÔNG truyền temperature/topP/topK/thinkingBudget cho Gemini 3 & 4 (api.md §IV)
  if (!isGemini3Or4(model)) {
    if (cfg.temperature !== undefined) config.temperature = cfg.temperature;
    if (cfg.topK !== undefined) config.topK = cfg.topK;
    if (cfg.topP !== undefined) config.topP = cfg.topP;
    if (!opts.stripThinking && cfg.thinkingBudget && provider === 'gemini') {
      config.thinkingConfig = { thinkingBudget: cfg.thinkingBudget };
    }
  } else if (!opts.stripThinking && !isLiteModel(model) && cfg.thinkingLevel && provider === 'gemini') {
    config.thinkingConfig = { thinkingLevel: cfg.thinkingLevel };
  }

  if (opts.includeSearchTool && provider === 'gemini') {
    config.tools = [{ googleSearch: {} }];
  }

  return config;
};

const getOrderedModels = (preferredModel?: string, provider: AiProvider = currentProvider): string[] => {
  const fallbackList =
    provider === 'agent-platform' ? [...AGENT_PLATFORM_FALLBACK_MODELS] : [...FALLBACK_MODELS];

  const primary = resolveModelAlias(preferredModel || currentSelectedModel, provider);
  const ordered = [primary];
  for (const m of fallbackList) {
    if (!ordered.includes(m)) {
      ordered.push(m);
    }
  }
  return ordered;
};

const getCandidateKeysForModel = (
  model: string,
  explicitKey?: string | null,
  provider: AiProvider = currentProvider,
): string[] => {
  if (provider === 'agent-platform') {
    const savedAgentKey =
      (explicitKey && explicitKey !== SERVER_PROXY_KEY_SENTINEL ? explicitKey : '') ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('agent_platform_api_key') || '' : '');
    const clean = normalizeGoogleAiApiKey(savedAgentKey);
    return isValidGoogleAiApiKey(clean) ? [clean] : [];
  }

  const poolKeys = apiKeyManager.getAvailableKeysForModel(model);
  const result: string[] = [...poolKeys];

  if (explicitKey && explicitKey !== SERVER_PROXY_KEY_SENTINEL) {
    const cleanExplicit = normalizeGoogleAiApiKey(explicitKey);
    if (isValidGoogleAiApiKey(cleanExplicit) && !result.includes(cleanExplicit)) {
      // Chỉ thêm nếu key đó chưa bị đánh dấu lỗi xác thực hoặc đang cooldown trên model này
      const allKnown = apiKeyManager.getAllKeys();
      const knownObj = allKnown.find((k) => k.key === cleanExplicit);
      const now = Date.now();
      const inCooldown = Boolean(knownObj?.modelCooldowns?.[model] && knownObj.modelCooldowns[model] > now);
      if (!knownObj || (knownObj.status !== 'error' && !inCooldown)) {
        result.unshift(cleanExplicit);
      }
    }
  }

  return result;
};

// ============================================================
// KIỂM TRA ĐƠN LẺ 1 API KEY (Test 1 / Test All trong Cài đặt)
// ============================================================
export interface ApiKeyTestResult {
  ok: boolean;
  latencyMs: number;
  errorType?: ApiErrorType;
  message: string;
}

export const testApiKey = async (
  rawKey: string,
  provider: AiProvider = 'gemini',
  model?: string,
): Promise<ApiKeyTestResult> => {
  const cleanKey = normalizeGoogleAiApiKey(rawKey);
  if (!isValidGoogleAiApiKey(cleanKey)) {
    return {
      ok: false,
      latencyMs: 0,
      errorType: 'INVALID_API_KEY',
      message: 'Sai định dạng (cần bắt đầu bằng AIzaSy... hoặc AQ...)',
    };
  }

  const targetModel = resolveModelAlias(
    model || (provider === 'agent-platform' ? AGENT_PLATFORM_FALLBACK_MODELS[0] : DEFAULT_GEMINI_MODEL),
    provider,
  );
  const startedAt = Date.now();

  try {
    const ai = createGoogleAiClient(cleanKey, provider);
    const cfg = buildRequestConfig(targetModel, {
      mode: 'aux',
      includeSystemInstruction: false,
      includeSearchTool: false,
      provider,
    });

    const timeout = createTimeout(20_000, `Kiểm tra key trên ${targetModel}`);
    try {
      await Promise.race([
        ai.models.generateContent({
          model: targetModel,
          contents: 'Trả lời 1 từ: OK',
          config: { ...cfg, maxOutputTokens: 16 },
        }),
        timeout.promise,
      ]);
    } finally {
      timeout.clear();
    }

    const latencyMs = Date.now() - startedAt;
    if (provider === 'gemini') {
      apiKeyManager.markKeySuccess(cleanKey, targetModel);
    }
    return {
      ok: true,
      latencyMs,
      message: `Hoạt động tốt (${targetModel} • ${latencyMs}ms)`,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    const classified = classifyApiError(err);

    // Nếu 400 do thinkingConfig thì thử lại nhanh không kèm thinkingConfig
    if (classified.isThinkingConfigError) {
      try {
        const ai = createGoogleAiClient(cleanKey, provider);
        await ai.models.generateContent({
          model: targetModel,
          contents: 'OK',
          config: { maxOutputTokens: 16 },
        });
        const retryLatency = Date.now() - startedAt;
        if (provider === 'gemini') {
          apiKeyManager.markKeySuccess(cleanKey, targetModel);
        }
        return {
          ok: true,
          latencyMs: retryLatency,
          message: `Hoạt động tốt (${targetModel} • ${retryLatency}ms)`,
        };
      } catch (retryErr: any) {
        const retryClass = classifyApiError(retryErr);
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          errorType: retryClass.type,
          message: getFriendlyErrorMessage(retryErr).title,
        };
      }
    }

    if (provider === 'gemini') {
      if (classified.type === 'INVALID_API_KEY') {
        apiKeyManager.markKeyAuthError(cleanKey);
      } else if (classified.type === 'QUOTA_EXCEEDED' || classified.type === 'RATE_LIMIT') {
        apiKeyManager.markKeyModelQuota(cleanKey, targetModel, classified.type, classified.retryDelaySec);
      }
    }

    const statusLabel =
      classified.type === 'QUOTA_EXCEEDED' || classified.type === 'RATE_LIMIT'
        ? `Key hợp lệ nhưng đang chạm giới hạn quota trên ${targetModel}`
        : classified.type === 'INVALID_API_KEY'
          ? 'Key không hợp lệ hoặc đã bị thu hồi'
          : classified.type === 'PERMISSION_DENIED'
            ? 'Key thiếu quyền truy cập dịch vụ này'
            : err?.message || 'Lỗi kết nối khi kiểm tra key';

    return {
      ok: false,
      latencyMs,
      errorType: classified.type,
      message: statusLabel,
    };
  }
};

// ============================================================
// TIMEOUT & ABORT CONFIGURATION
// ============================================================
const FIRST_CHUNK_TIMEOUT_MS = 60_000;   // 60s chờ chunk đầu tiên
const TOTAL_STREAM_TIMEOUT_MS = 600_000; // 10 phút tổng thời gian stream
const MAX_SHORT_RPM_WAIT_MS = 35_000;    // Chờ tối đa 35s khi tất cả key chỉ vướng RPM ngắn

let currentAbortController: AbortController | null = null;

/** Hủy stream đang chạy (gọi từ UI khi user muốn dừng) */
export const abortCurrentStream = () => {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
    setFallbackNotice(null);
    console.log('🛑 Đã hủy stream theo yêu cầu người dùng.');
  }
};

/** Kiểm tra stream có đang chạy không */
export const isStreamActive = (): boolean => {
  return currentAbortController !== null && !currentAbortController.signal.aborted;
};

const createTimeout = (ms: number, label: string): { promise: Promise<never>; clear: () => void } => {
  let timerId: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`⏰ Timeout: ${label} (${Math.round(ms / 1000)}s). Vui lòng thử lại.`));
    }, ms);
  });
  return { promise, clear: () => clearTimeout(timerId) };
};

const sleepWithCountdown = async (
  waitMs: number,
  signal?: AbortSignal,
  prefix = 'Đang chờ làm mới hạn mức tốc độ',
): Promise<void> => {
  const endAt = Date.now() + waitMs;
  while (Date.now() < endAt) {
    if (signal?.aborted) throw new Error('Đã hủy yêu cầu.');
    const sec = Math.max(1, Math.ceil((endAt - Date.now()) / 1000));
    setFallbackNotice(`⏳ ${prefix} (${sec}s)...`);
    await new Promise((r) => setTimeout(r, Math.min(1000, endAt - Date.now())));
  }
};

/** Làm sạch HTML tags thừa từ AI output */
const sanitizeAIOutput = (text: string): string => {
  let clean = text;
  clean = clean.replace(/<br\s*\/?>/gi, '\n');
  clean = clean.replace(/<\/?(p|div|span|b|i|em|strong|u|s|del|ins|mark|sub|sup|small|big|center)(\s[^>]*)?>/gi, '');
  return clean;
};

// ============================================================
// CƠ CHẾ GỌI ĐA TẦNG 2-TIER: MULTI-KEY × 6 FREE MODELS + PROXY
// ============================================================
interface StreamAttemptOutcome {
  done: boolean;
  value?: string;
  lastErr?: any;
}

const executeResilientStream = async (params: {
  contentsBuilder: () => any;
  preferredModel?: string;
  explicitKey?: string | null;
  provider?: AiProvider;
  includeSearchTool?: boolean;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
  onRetryReset?: () => void;
}): Promise<string> => {
  const provider = normalizeProvider(params.provider || currentProvider);
  const modelsToTry = getOrderedModels(params.preferredModel, provider);
  const primaryModel = modelsToTry[0];

  const runClientMatrix = async (): Promise<StreamAttemptOutcome> => {
    let lastErr: any = null;

    for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
      const model = modelsToTry[mIdx];
      const keysForModel = getCandidateKeysForModel(model, params.explicitKey, provider);

      if (keysForModel.length === 0) continue;

      let moveNextModelImmediately = false;

      for (let kIdx = 0; kIdx < keysForModel.length; kIdx++) {
        const key = keysForModel[kIdx];
        if (params.signal?.aborted) throw new Error('Đã hủy yêu cầu.');

        if (mIdx > 0 || kIdx > 0) {
          setFallbackNotice(
            `🔄 Đang tự động chuyển sang ${model} (${maskGoogleAiApiKey(key)}) để tránh gián đoạn...`,
          );
        }

        for (const attemptMode of ['normal', 'no-thinking', 'plain'] as const) {
          if (params.signal?.aborted) throw new Error('Đã hủy yêu cầu.');

          let emittedAnyChunk = false;
          let fullResponse = '';

          try {
            const ai = createGoogleAiClient(key, provider);
            const config = buildRequestConfig(model, {
              mode: 'main',
              includeSystemInstruction: true,
              includeSearchTool: attemptMode !== 'plain' && Boolean(params.includeSearchTool),
              stripThinking: attemptMode !== 'normal',
              provider,
            });

            const sendTimeout = createTimeout(FIRST_CHUNK_TIMEOUT_MS, `Chờ phản hồi từ ${model}`);
            let responseStream: any;
            try {
              responseStream = await Promise.race([
                ai.models.generateContentStream({
                  model,
                  config,
                  contents: params.contentsBuilder(),
                }),
                sendTimeout.promise,
              ]);
            } finally {
              sendTimeout.clear();
            }

            const totalTimeout = createTimeout(TOTAL_STREAM_TIMEOUT_MS, 'Tổng thời gian stream quá dài');
            try {
              for await (const chunk of responseStream) {
                if (params.signal?.aborted) throw new Error('Đã hủy yêu cầu.');
                if (chunk.text) {
                  emittedAnyChunk = true;
                  const cleanText = sanitizeAIOutput(chunk.text);
                  params.onChunk(cleanText);
                  fullResponse += cleanText;
                }
              }
            } finally {
              totalTimeout.clear();
            }

            if (provider === 'gemini') {
              apiKeyManager.markKeySuccess(key, model);
              currentApiKey = key;
            }
            setFallbackNotice(null);
            return { done: true, value: fullResponse };
          } catch (err: any) {
            lastErr = err;
            if (params.signal?.aborted) {
              setFallbackNotice(null);
              throw new Error('Đã hủy yêu cầu.');
            }

            if (emittedAnyChunk && params.onRetryReset) {
              params.onRetryReset();
            }

            const classified = classifyApiError(err);

            if (classified.type === 'INVALID_ARGUMENT') {
              if (attemptMode === 'normal' && classified.isThinkingConfigError) {
                continue; // gửi lại ngay không kèm thinkingConfig
              }
              if (attemptMode !== 'plain' && classified.isToolsError) {
                continue; // gửi lại ngay không kèm googleSearch tool
              }
              setFallbackNotice(null);
              throw err;
            }

            if (classified.type === 'INVALID_API_KEY') {
              if (provider === 'gemini') {
                apiKeyManager.markKeyAuthError(key);
              }
              break; // sang key tiếp theo
            }

            if (classified.type === 'PERMISSION_DENIED') {
              if (provider === 'agent-platform') {
                moveNextModelImmediately = true; // thử model tiếp trên Agent Platform
              }
              break; // trên Gemini thử key tiếp theo
            }

            if (classified.type === 'QUOTA_EXCEEDED' || classified.type === 'RATE_LIMIT') {
              if (provider === 'gemini') {
                apiKeyManager.markKeyModelQuota(key, model, classified.type, classified.retryDelaySec);
              }
              break; // xoay sang key tiếp theo trên cùng model, hết key mới sang model tiếp
            }

            if (classified.type === 'MODEL_OVERLOADED' || classified.type === 'NOT_FOUND') {
              moveNextModelImmediately = true;
              break; // lỗi phía model -> sang model dự phòng ngay, không phạt key
            }

            // Lỗi mạng tạm thời -> thử key/model kế tiếp
            break;
          }
        }

        if (moveNextModelImmediately) break;
      }
    }

    return { done: false, lastErr };
  };

  // TẦNG 1 & 2: Chạy qua ma trận (Tất cả Client Keys × 6 Model Free Tier)
  const firstPass = await runClientMatrix();
  if (firstPass.done && firstPass.value !== undefined) {
    return firstPass.value;
  }

  let lastError: any = firstPass.lastErr;

  // TẦNG 3: Fallback sang Server Proxy ngầm (/api/gemini) nếu chạy Gemini API
  if (provider === 'gemini') {
    const proxyStatus = serverProxyStatus.checked
      ? serverProxyStatus
      : await checkServerProxyAvailable();

    if (proxyStatus.available) {
      let emittedProxyChunk = false;
      try {
        setFallbackNotice('🛡️ Đang sử dụng kho API Key dự phòng trên máy chủ để tiếp tục...');
        const config = buildRequestConfig(primaryModel, {
          mode: 'main',
          includeSystemInstruction: true,
          includeSearchTool: Boolean(params.includeSearchTool),
          provider: 'gemini',
        });

        let fullResponse = '';
        for await (const chunk of callServerProxyStream({
          model: primaryModel,
          contents: params.contentsBuilder(),
          config,
          signal: params.signal,
        })) {
          if (params.signal?.aborted) throw new Error('Đã hủy yêu cầu.');
          if (chunk.text) {
            emittedProxyChunk = true;
            const cleanText = sanitizeAIOutput(chunk.text);
            params.onChunk(cleanText);
            fullResponse += cleanText;
          }
        }

        setFallbackNotice(null);
        return fullResponse;
      } catch (proxyErr: any) {
        if (emittedProxyChunk && params.onRetryReset) {
          params.onRetryReset();
        }
        lastError = proxyErr;
      }
    }
  }

  // TẦNG 4: Nếu có ít nhất 1 key chỉ bị giới hạn RPM ngắn (<= 35s), tự chờ đếm ngược rồi thử lại 1 vòng
  if (provider === 'gemini') {
    const soonestMs = apiKeyManager.getSoonestCooldownMs();
    if (soonestMs !== null && soonestMs > 0 && soonestMs <= MAX_SHORT_RPM_WAIT_MS) {
      await sleepWithCountdown(soonestMs + 500, params.signal);
      const retryPass = await runClientMatrix();
      if (retryPass.done && retryPass.value !== undefined) {
        setFallbackNotice(null);
        return retryPass.value;
      }
      if (retryPass.lastErr) lastError = retryPass.lastErr;
    }
  }

  setFallbackNotice(null);
  throw (
    lastError ||
    new Error('Chưa có API Key khả dụng. Vui lòng mở Cài đặt API Key để thêm key mới.')
  );
};

interface NonStreamOutcome {
  done: boolean;
  value?: string;
  lastErr?: any;
}

const executeResilientGenerateText = async (params: {
  prompt: string;
  preferredModel?: string;
  explicitKey?: string | null;
  provider?: AiProvider;
  mode?: 'main' | 'aux';
}): Promise<string> => {
  const provider = normalizeProvider(
    params.provider ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('google_ai_provider') : null) ||
      currentProvider,
  );
  const modelsToTry = getOrderedModels(params.preferredModel, provider);
  const primaryModel = modelsToTry[0];
  const mode = params.mode || 'aux';

  const runMatrix = async (): Promise<NonStreamOutcome> => {
    let lastErr: any = null;

    for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
      const model = modelsToTry[mIdx];
      const keysForModel = getCandidateKeysForModel(model, params.explicitKey, provider);
      if (keysForModel.length === 0) continue;

      let moveNextModelImmediately = false;

      for (let kIdx = 0; kIdx < keysForModel.length; kIdx++) {
        const key = keysForModel[kIdx];

        if (mIdx > 0 || kIdx > 0) {
          setFallbackNotice(
            `🔄 Đang tự động chuyển sang ${model} (${maskGoogleAiApiKey(key)}) để xử lý...`,
          );
        }

        for (const stripThinking of [false, true]) {
          try {
            const ai = createGoogleAiClient(key, provider);
            const config = buildRequestConfig(model, {
              mode,
              includeSystemInstruction: false,
              includeSearchTool: false,
              stripThinking,
              provider,
            });

            const timeout = createTimeout(FIRST_CHUNK_TIMEOUT_MS, `Phân tích với ${model}`);
            let response: any;
            try {
              response = await Promise.race([
                ai.models.generateContent({
                  model,
                  contents: params.prompt,
                  config,
                }),
                timeout.promise,
              ]);
            } finally {
              timeout.clear();
            }

            if (provider === 'gemini') {
              apiKeyManager.markKeySuccess(key, model);
            }
            setFallbackNotice(null);
            return { done: true, value: response?.text || '' };
          } catch (err: any) {
            lastErr = err;
            const classified = classifyApiError(err);

            if (!stripThinking && classified.isThinkingConfigError) {
              continue;
            }
            if (classified.type === 'INVALID_ARGUMENT') {
              setFallbackNotice(null);
              throw err;
            }
            if (classified.type === 'INVALID_API_KEY') {
              if (provider === 'gemini') apiKeyManager.markKeyAuthError(key);
              break;
            }
            if (classified.type === 'PERMISSION_DENIED') {
              if (provider === 'agent-platform') moveNextModelImmediately = true;
              break;
            }
            if (classified.type === 'QUOTA_EXCEEDED' || classified.type === 'RATE_LIMIT') {
              if (provider === 'gemini') {
                apiKeyManager.markKeyModelQuota(key, model, classified.type, classified.retryDelaySec);
              }
              break;
            }
            if (classified.type === 'MODEL_OVERLOADED' || classified.type === 'NOT_FOUND') {
              moveNextModelImmediately = true;
              break;
            }
            break;
          }
        }

        if (moveNextModelImmediately) break;
      }
    }

    return { done: false, lastErr };
  };

  const firstPass = await runMatrix();
  if (firstPass.done && firstPass.value !== undefined) {
    return firstPass.value;
  }

  let lastError: any = firstPass.lastErr;

  if (provider === 'gemini') {
    const proxyStatus = serverProxyStatus.checked
      ? serverProxyStatus
      : await checkServerProxyAvailable();

    if (proxyStatus.available) {
      try {
        setFallbackNotice('🛡️ Đang phân tích bằng kho API Key dự phòng trên máy chủ...');
        const config = buildRequestConfig(primaryModel, {
          mode,
          includeSystemInstruction: false,
          includeSearchTool: false,
          provider: 'gemini',
        });
        const res = await callServerProxyGenerate({
          model: primaryModel,
          contents: params.prompt,
          config,
        });
        setFallbackNotice(null);
        return res.text || '';
      } catch (proxyErr: any) {
        lastError = proxyErr;
      }
    }

    const soonestMs = apiKeyManager.getSoonestCooldownMs();
    if (soonestMs !== null && soonestMs > 0 && soonestMs <= MAX_SHORT_RPM_WAIT_MS) {
      await sleepWithCountdown(soonestMs + 500);
      const retryPass = await runMatrix();
      if (retryPass.done && retryPass.value !== undefined) {
        setFallbackNotice(null);
        return retryPass.value;
      }
      if (retryPass.lastErr) lastError = retryPass.lastErr;
    }
  }

  setFallbackNotice(null);
  throw (
    lastError ||
    new Error('Chưa có API Key khả dụng. Vui lòng mở Cài đặt API Key để thêm key.')
  );
};

/**
 * Gửi prompt đơn lẻ với streaming - KHÔNG dùng chat session hay history.
 * Đã tích hợp xoay vòng nhiều API key + 6 model Free Tier + Server Proxy.
 */
export const sendSinglePromptStream = async (
  message: string,
  onChunk: (text: string) => void,
  onRetryReset?: () => void,
): Promise<string> => {
  abortCurrentStream();
  const abortController = new AbortController();
  currentAbortController = abortController;

  try {
    return await executeResilientStream({
      contentsBuilder: () => [{ role: 'user', parts: [{ text: message }] }],
      preferredModel: currentSelectedModel || undefined,
      explicitKey: currentApiKey,
      provider: currentProvider,
      includeSearchTool: true,
      signal: abortController.signal,
      onChunk,
      onRetryReset,
    });
  } finally {
    if (currentAbortController === abortController) {
      currentAbortController = null;
    }
  }
};

export const sendMessageStream = async (
  message: string,
  onChunk: (text: string) => void,
  onRetryReset?: () => void,
): Promise<void> => {
  abortCurrentStream();
  const abortController = new AbortController();
  currentAbortController = abortController;

  const baseHistory = [...history];

  try {
    const fullResponse = await executeResilientStream({
      contentsBuilder: () => [
        ...baseHistory,
        { role: 'user', parts: [{ text: message }] },
      ],
      preferredModel: currentSelectedModel || undefined,
      explicitKey: currentApiKey,
      provider: currentProvider,
      includeSearchTool: true,
      signal: abortController.signal,
      onChunk,
      onRetryReset,
    });

    history.push({ role: 'user', parts: [{ text: message }] });
    history.push({ role: 'model', parts: [{ text: fullResponse }] });
  } finally {
    if (currentAbortController === abortController) {
      currentAbortController = null;
    }
  }
};

// Phân tích tài liệu để trích xuất thông tin cho SKKN (không dùng chat session)
export const analyzeDocumentForSKKN = async (
  apiKey: string,
  documentContent: string,
  documentType: 'reference' | 'template',
  selectedModel?: string
): Promise<string> => {
  // Giới hạn nội dung để tránh vượt token limit
  const truncatedContent = documentContent.substring(0, 20000);

  const prompt = documentType === 'reference'
    ? `Bạn là chuyên gia phân tích tài liệu giáo dục. Hãy phân tích TÀI LIỆU THAM KHẢO sau và trích xuất thông tin hữu ích cho việc viết SKKN (Sáng kiến Kinh nghiệm):

📚 **TÀI LIỆU THAM KHẢO:**
${truncatedContent}

---

Hãy phân tích và trả về kết quả theo format sau:

## 📖 1. NỘI DUNG CHÍNH
- Liệt kê các chủ đề, khái niệm, kiến thức quan trọng
- Tóm tắt ý chính của tài liệu

## 🔧 2. PHƯƠNG PHÁP / KỸ THUẬT (nếu có)
- Các phương pháp dạy học được đề cập
- Kỹ thuật, chiến lược giảng dạy

## 📊 3. SỐ LIỆU / DỮ LIỆU QUAN TRỌNG (nếu có)
- Thống kê, bảng biểu
- Kết quả nghiên cứu, khảo sát

## 💡 4. GỢI Ý ÁP DỤNG CHO SKKN
- Cách tận dụng tài liệu này vào đề tài SKKN
- Các điểm có thể tham khảo, trích dẫn
- Ý tưởng phát triển giải pháp

⚠️ Lưu ý: Trả lời ngắn gọn, súc tích, tập trung vào thông tin hữu ích nhất.`
    : `Bạn là chuyên gia về quy trình viết SKKN. Hãy phân tích MẪU YÊU CẦU SKKN sau và trích xuất thông tin quan trọng:

📋 **MẪU YÊU CẦU SKKN:**
${truncatedContent}

---

Hãy phân tích và trả về kết quả theo format sau:

## 📝 1. CẤU TRÚC YÊU CẦU
- Các phần bắt buộc phải có
- Thứ tự các mục
- Quy định về format

## ⭐ 2. TIÊU CHÍ ĐÁNH GIÁ (nếu có)
- Các tiêu chí chấm điểm
- Thang điểm
- Trọng số các phần

## 📏 3. YÊU CẦU ĐẶC BIỆT
- Độ dài tối thiểu/tối đa
- Font chữ, cỡ chữ, căn lề
- Quy định về trích dẫn, tài liệu tham khảo

## ⚠️ 4. LƯU Ý QUAN TRỌNG
- Các điểm cần tuân thủ nghiêm ngặt
- Lỗi thường gặp cần tránh
- Điểm khác biệt so với mẫu chuẩn (nếu có)

⚠️ Lưu ý: Trả lời ngắn gọn, súc tích, tập trung vào thông tin cần thiết nhất.`;

  try {
    const responseText = await executeResilientGenerateText({
      prompt,
      preferredModel: selectedModel,
      explicitKey: apiKey,
      mode: 'aux',
    });

    return responseText || 'Không thể phân tích tài liệu. Vui lòng thử lại.';
  } catch (error: any) {
    console.error('Lỗi phân tích tài liệu:', error);
    throw new Error(getFriendlyErrorMessage(error).message);
  }
};

// Interface cho cấu trúc mục SKKN (import từ types.ts nếu cần)
interface SKKNSection {
  id: string;
  level: number;
  title: string;
  suggestedContent?: string;
}

// Trích xuất cấu trúc mục từ mẫu SKKN
export const extractSKKNStructure = async (
  apiKey: string,
  templateContent: string,
  selectedModel?: string
): Promise<{ sections: SKKNSection[], contentGuidelines?: string, pageLimitFromTemplate?: number, headerFields?: Record<string, string> }> => {
  // Giới hạn nội dung để tránh vượt token limit
  const truncatedContent = templateContent.substring(0, 25000);

  const prompt = `Bạn là chuyên gia phân tích cấu trúc tài liệu SKKN (Sáng kiến Kinh nghiệm).

NHIỆM VỤ: Phân tích MẪU YÊU CẦU SKKN sau và TRÍCH XUẤT ĐẦY ĐỦ thông tin.

═══════════════════════════════════════════════════════════════
MẪU SKKN CẦN PHÂN TÍCH:
═══════════════════════════════════════════════════════════════
${truncatedContent}
═══════════════════════════════════════════════════════════════

TRẢ VỀ JSON OBJECT với format CHÍNH XÁC sau (KHÔNG có text khác, CHỈ JSON):

{
  "sections": [
    {"id": "1", "level": 1, "title": "I. Mô tả giải pháp đã biết", "suggestedContent": "Nêu rõ giải pháp/cách làm cũ đang được áp dụng..."},
    {"id": "2", "level": 1, "title": "II. Nội dung giải pháp đề nghị công nhận sáng kiến", "suggestedContent": ""},
    {"id": "2.1", "level": 2, "title": "II.1 Nội dung giải pháp đề nghị công nhận sáng kiến", "suggestedContent": "Trình bày chi tiết nội dung giải pháp mới"},
    ...
  ],
  "contentGuidelines": "Tóm tắt ngắn gọn các hướng dẫn viết nội dung nếu mẫu có ghi (VD: yêu cầu mô tả giải pháp cũ, nêu tính mới, so sánh trước sau...)",
  "pageLimitFromTemplate": 0,
  "headerFields": {
    "hoTen": "Họ và tên",
    "chucVu": "Chức vụ, đơn vị công tác",
    "tenSangKien": "Tên sáng kiến",
    "linhVuc": "Lĩnh vực áp dụng sáng kiến",
    "donViApDung": "Đơn vị áp dụng sáng kiến",
    "thoiGian": "Thời gian áp dụng"
  }
}

QUY TẮC QUAN TRỌNG TỐI CAO:

📋 PHẦN sections:
1. BỎ QUA CÁC THÔNG TIN HÀNH CHÍNH trong sections (Họ tên, Chức vụ, Đơn vị...) - đưa chúng vào headerFields.
2. CHỈ TRÍCH XUẤT cấu trúc phần NỘI DUNG CỐT LÕI cần viết (Mô tả giải pháp, Nội dung giải pháp, Tính mới, Hiệu quả, Khả năng nhân rộng...)
3. level 1: Phần lớn nhất. level 2: Mục con cấp 1. level 3: Mục con cấp 2.
4. Giữ NGUYÊN tiêu đề gốc trong mẫu.
5. suggestedContent: Tóm tắt hướng dẫn viết nếu mẫu có ghi cho mục đó.

📄 PHẦN contentGuidelines:
- Tóm tắt toàn bộ hướng dẫn/yêu cầu viết mà mẫu đề cập (nếu có).
- VD: "Mẫu yêu cầu mô tả giải pháp cũ trước, sau đó nêu giải pháp mới, so sánh tính mới, nêu hiệu quả..."

📏 PHẦN pageLimitFromTemplate:
- Nếu mẫu có ghi rõ giới hạn số trang (VD: "không quá 15 trang", "từ 10-20 trang"), trả về số trang tối đa.
- Nếu không ghi, trả về 0.

👤 PHẦN headerFields:
- Trích xuất TÊN các trường thông tin hành chính mà mẫu yêu cầu điền (Họ tên, Chức vụ, Đơn vị, Lĩnh vực...).
- Key: tên viết tắt camelCase. Value: tên đầy đủ tiếng Việt như mẫu ghi.
- CHỈ lấy các trường mà MẪU thực sự có, KHÔNG tự bịa thêm.

CHỈ TRẢ VỀ JSON OBJECT, KHÔNG giải thích, KHÔNG markdown code block.

BẮT ĐẦU JSON NGAY:`;

  try {
    const responseText =
      (await executeResilientGenerateText({
        prompt,
        preferredModel: selectedModel,
        explicitKey: apiKey,
        mode: 'aux',
      })) || '{}';

    // Cố gắng parse JSON từ response
    let jsonText = responseText.trim();

    // Remove markdown code blocks if present
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    // Try to find JSON object first
    const jsonObjMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonObjMatch) {
      jsonText = jsonObjMatch[0];
    }

    const parsed = JSON.parse(jsonText);

    // Nếu AI trả về object có sections
    if (parsed && parsed.sections && Array.isArray(parsed.sections)) {
      const sections: SKKNSection[] = parsed.sections.filter(
        (s: any) => s.id && s.title && typeof s.level === 'number'
      );
      return {
        sections,
        contentGuidelines: parsed.contentGuidelines || '',
        pageLimitFromTemplate: typeof parsed.pageLimitFromTemplate === 'number' ? parsed.pageLimitFromTemplate : 0,
        headerFields: parsed.headerFields || {},
      };
    }

    // Fallback: Nếu AI vẫn trả về array cũ
    if (Array.isArray(parsed)) {
      const sections: SKKNSection[] = parsed.filter(
        (s: any) => s.id && s.title && typeof s.level === 'number'
      );
      return { sections };
    }

    return { sections: [] };

  } catch (error: any) {
    console.error('Lỗi trích xuất cấu trúc SKKN:', error);
    return { sections: [] };
  }
};

/**
 * Phân tích tên đề tài SKKN
 * Theo quy trình kiểm tra 3 lớp từ quy trinh kiem tra.txt
 */
export const analyzeTitleSKKN = async (
  apiKey: string,
  title: string,
  subject?: string,
  level?: string,
  selectedModel?: string
): Promise<TitleAnalysisResult> => {

  const prompt = `Bạn là chuyên gia phân tích tên đề tài Sáng kiến kinh nghiệm (SKKN) với 20 năm kinh nghiệm.

## THÔNG TIN ĐỀ TÀI CẦN PHÂN TÍCH:
- Tên đề tài: "${title}"
${subject ? `- Môn học/Lĩnh vực: ${subject}` : ''}
${level ? `- Cấp học: ${level}` : ''}

## QUY TRÌNH KIỂM TRA 3 LỚP:

### LỚP 1: DATABASE NỘI BỘ (Đề tài phổ biến)
So sánh với database đề tài tích hợp:

🔴 TRÙNG LẶP CAO (80-90%):
- "Ứng dụng AI trong dạy học môn [X]"
- "Sử dụng ChatGPT hỗ trợ [công việc Y]"
- "Ứng dụng Canva thiết kế bài giảng"
- "Sử dụng Kahoot/Quizizz tăng tính tương tác"
- "Dạy học trực tuyến qua Google Meet/Zoom"
- "Ứng dụng Google Classroom quản lý lớp học"

🟡 TRÙNG LẶP TRUNG BÌNH (60-70%):
- "Dạy học theo dự án (PBL) môn [X]"
- "Phương pháp dạy học tích cực môn [X]"
- "Dạy học theo nhóm hiệu quả"
- "Phát triển năng lực tự học của học sinh"

🟢 TRÙNG LẶP THẤP (20-40%):
- "Kết hợp AI và PBL trong dạy STEM lớp 8"
- Các đề tài kết hợp nhiều phương pháp
- Đề tài có đối tượng đặc biệt (HS khuyết tật, vùng cao)

### LỚP 2: TÌM KIẾM ONLINE (Mô phỏng)
Ước tính số lượng đề tài tương tự trên:
- Cổng SKKN Bộ GD&ĐT
- Sở GD&ĐT các tỉnh
- Tạp chí Giáo dục
- Google Scholar

### LỚP 3: WEBSITE CHUYÊN NGÀNH
- violet.vn, tailieu.vn, 123doc.net
- thuvienvatly.com, giaoducthoidai.vn

## CHẤM ĐIỂM (TỔNG 100 ĐIỂM):

1. **Độ cụ thể (max 25đ)**:
   - 25: Có đầy đủ: môn học, cấp học, công cụ, phạm vi cụ thể
   - 20: Có 3/4 yếu tố
   - 15: Có 2/4 yếu tố
   - 10: Chỉ có 1 yếu tố cụ thể
   - 5: Quá chung chung

2. **Tính mới (max 30đ)**:
   - 30: Chưa ai làm, hoàn toàn mới
   - 25: Kết hợp 2-3 yếu tố mới
   - 20: Có 1 điểm mới rõ ràng
   - 15: Cải tiến từ đề tài cũ
   - 10: Đã có nhiều người làm
   - 5: Trùng lặp hoàn toàn

3. **Tính khả thi (max 25đ)**:
   - 25: Rất dễ thực hiện, nguồn lực sẵn có
   - 20: Khả thi, cần chuẩn bị ít
   - 15: Khả thi nhưng cần thời gian/chi phí
   - 10: Khó khăn, cần nhiều nguồn lực
   - 5: Không khả thi

4. **Độ rõ ràng (max 20đ)**:
   - 20: Tên ngắn gọn, dễ hiểu, có từ khóa rõ
   - 15: Rõ ràng nhưng hơi dài
   - 10: Có thể hiểu nhưng chưa tối ưu
   - 5: Khó hiểu, rườm rà

## PHÁT HIỆN VẤN ĐỀ:
- Từ ngữ chung chung: "ứng dụng công nghệ", "nâng cao chất lượng", "một số biện pháp"
- Từ quá tham vọng: "toàn diện", "cách mạng hóa", "đột phá"
- Công cụ lỗi thời: "băng hình", "đĩa CD", "máy chiếu overhead"
- Công cụ quá phổ biến: "ChatGPT", "Kahoot", "Google Classroom"

## ĐỀ XUẤT 5 TÊN THAY THẾ (Công thức):
1. Cụ thể hóa: Thêm [Cấp học] + [Bối cảnh đặc biệt]
2. Kết hợp: [Công nghệ A] + [Phương pháp B] + [Môn học C]
3. Đối tượng đặc biệt: [Phương pháp] + [HS đặc thù] + [Mục tiêu]
4. Bài học cụ thể: [Phương pháp] + [Bài/Chương cụ thể] + [Công cụ]
5. Tạo công cụ mới: Thiết kế [Công cụ tự tạo] + [Mục đích]

TRẢ VỀ JSON (KHÔNG có markdown code block, CHỈ JSON thuần):
{
  "structure": {
    "action": "Từ khóa hành động (hoặc rỗng)",
    "tool": "Công cụ/Phương tiện (hoặc rỗng)",
    "subject": "Môn học/Lĩnh vực",
    "scope": "Phạm vi (lớp, cấp học)",
    "purpose": "Mục đích"
  },
  "duplicateLevel": "Cao|Trung bình|Thấp",
  "duplicateDetails": "Giải thích chi tiết về mức độ trùng lặp",
  "scores": {
    "specificity": <điểm>,
    "novelty": <điểm>,
    "feasibility": <điểm>,
    "clarity": <điểm>,
    "total": <tổng điểm>
  },
  "scoreDetails": [
    { "category": "Độ cụ thể", "score": <điểm>, "maxScore": 25, "reason": "lý do" },
    { "category": "Tính mới", "score": <điểm>, "maxScore": 30, "reason": "lý do" },
    { "category": "Tính khả thi", "score": <điểm>, "maxScore": 25, "reason": "lý do" },
    { "category": "Độ rõ ràng", "score": <điểm>, "maxScore": 20, "reason": "lý do" }
  ],
  "problems": ["Vấn đề 1", "Vấn đề 2"],
  "suggestions": [
    { "title": "Tên đề tài thay thế 1", "strength": "Điểm mạnh", "predictedScore": <điểm dự kiến> },
    { "title": "Tên đề tài thay thế 2", "strength": "Điểm mạnh", "predictedScore": <điểm dự kiến> },
    { "title": "Tên đề tài thay thế 3", "strength": "Điểm mạnh", "predictedScore": <điểm dự kiến> },
    { "title": "Tên đề tài thay thế 4", "strength": "Điểm mạnh", "predictedScore": <điểm dự kiến> },
    { "title": "Tên đề tài thay thế 5", "strength": "Điểm mạnh", "predictedScore": <điểm dự kiến> }
  ],
  "relatedTopics": ["Đề tài mới nổi 1", "Đề tài mới nổi 2", "Đề tài mới nổi 3"],
  "overallVerdict": "Kết luận tổng quan và lời khuyên"
}

BẮT ĐẦU JSON NGAY:`;

  try {
    const responseText =
      (await executeResilientGenerateText({
        prompt,
        preferredModel: selectedModel,
        explicitKey: apiKey,
        mode: 'aux',
      })) || '{}';

    // Xử lý response để lấy JSON
    let jsonText = responseText.trim();

    // Remove markdown code blocks if present
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    // Find JSON object in response
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }

    const result: TitleAnalysisResult = JSON.parse(jsonText);
    return result;

  } catch (error: any) {
    console.error('Lỗi phân tích đề tài:', error);
    throw new Error(getFriendlyErrorMessage(error).message);
  }
};
