export const config = {
  runtime: 'edge',
};

const GOOGLE_AI_API_KEY_PATTERN = /^(?:AIza|AQ)\S{10,}$/;

const SERVER_FALLBACK_MODELS: string[] = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
];

const MODEL_ALIASES: Record<string, string> = {
  'gemini-3.7-flash': 'gemini-4-hydrogen',
  'gemini-3.5-flash': 'gemini-3.6-flash',
  'gemini-2.5-flash': 'gemini-4-hydrogen',
  'gemini-2.5-pro': 'gemini-4-hydrogen',
  'gemini-2.0-flash': 'gemini-4-hydrogen',
  'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-3-pro-preview': 'gemini-4-hydrogen',
  'gemini-3.1-flash-lite-preview': 'gemini-3.5-flash-lite',
};

function normalizeKey(raw: string): string {
  return (raw || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^(?:(?:vite_)?(?:gemini_)?api[_-]?key|key)\s*[=:]\s*/i, '')
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, '');
}

function getServerKeys(): string[] {
  const raw =
    (typeof process !== 'undefined' &&
      (process.env?.GEMINI_API_KEYS || process.env?.GEMINI_API_KEY)) ||
    '';
  if (!raw) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const part of raw.split(/[\n,;]+/)) {
    const clean = normalizeKey(part);
    if (GOOGLE_AI_API_KEY_PATTERN.test(clean) && !seen.has(clean)) {
      seen.add(clean);
      keys.push(clean);
    }
  }
  return keys;
}

function resolveModel(requested?: string): string {
  if (!requested) return SERVER_FALLBACK_MODELS[0];
  const trimmed = requested.trim();
  return MODEL_ALIASES[trimmed] || trimmed;
}

function buildOrderedModels(primary: string): string[] {
  const resolved = resolveModel(primary);
  const list = [resolved];
  for (const m of SERVER_FALLBACK_MODELS) {
    if (!list.includes(m)) list.push(m);
  }
  return list;
}

function sanitizeGenerationConfig(model: string, rawCfg: any, stripThinking = false): any {
  if (!rawCfg || typeof rawCfg !== 'object') return undefined;
  const cfg: Record<string, any> = { ...rawCfg };
  const isGen3Or4 = /^gemini-[34]/i.test(model);
  const isLite = /-lite/i.test(model);
  const noMinimal = /^gemini-4/i.test(model) || /^gemini-3\.8/i.test(model);

  if (isGen3Or4) {
    delete cfg.temperature;
    delete cfg.topP;
    delete cfg.topK;
    if (cfg.thinkingConfig && typeof cfg.thinkingConfig === 'object') {
      const nextThinking = { ...cfg.thinkingConfig };
      delete nextThinking.thinkingBudget;
      if (
        noMinimal &&
        typeof nextThinking.thinkingLevel === 'string' &&
        nextThinking.thinkingLevel.toUpperCase() === 'MINIMAL'
      ) {
        nextThinking.thinkingLevel = 'LOW';
      }
      if (isLite || stripThinking || Object.keys(nextThinking).length === 0) {
        delete cfg.thinkingConfig;
      } else {
        cfg.thinkingConfig = nextThinking;
      }
    }
  } else if (stripThinking) {
    delete cfg.thinkingConfig;
  }

  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

function normalizeContents(contents: any): any[] {
  if (typeof contents === 'string') {
    return [{ role: 'user', parts: [{ text: contents }] }];
  }
  if (Array.isArray(contents)) {
    return contents.map((item) => {
      if (typeof item === 'string') {
        return { role: 'user', parts: [{ text: item }] };
      }
      return item;
    });
  }
  if (contents && typeof contents === 'object') {
    if (Array.isArray(contents.parts)) {
      return [{ role: contents.role || 'user', parts: contents.parts }];
    }
  }
  return [{ role: 'user', parts: [{ text: String(contents ?? '') }] }];
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let roundRobinIndex = 0;

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const keys = getServerKeys();

  if (req.method === 'GET') {
    return new Response(
      JSON.stringify({
        available: keys.length > 0,
        keyCount: keys.length,
      }),
      {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'Method Not Allowed' } }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (keys.length === 0) {
    return new Response(
      JSON.stringify({
        error: {
          code: 503,
          message:
            'Server chưa cấu hình GEMINI_API_KEYS. Vui lòng nhập API key cá nhân trong phần Cài đặt.',
        },
      }),
      {
        status: 503,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: { code: 400, message: 'Invalid JSON body' } }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const isStream = Boolean(payload?.stream);
  const models = buildOrderedModels(payload?.model);
  const contents = normalizeContents(payload?.contents);
  const startIdx = roundRobinIndex % keys.length;
  roundRobinIndex = (roundRobinIndex + 1) % keys.length;
  const orderedKeys = [...keys.slice(startIdx), ...keys.slice(0, startIdx)];

  let lastStatus = 500;
  let lastErrorBody = JSON.stringify({
    error: { message: 'Tất cả API key và model dự phòng trên server đều đang bận.' },
  });

  for (const model of models) {
    for (const apiKey of orderedKeys) {
      for (const attemptMode of ['normal', 'no-thinking', 'plain'] as const) {
        const stripThinking = attemptMode !== 'normal';
        const stripTools = attemptMode === 'plain';

        const googleBody: Record<string, any> = {
          contents,
        };

        if (payload?.systemInstruction) {
          if (typeof payload.systemInstruction === 'string') {
            googleBody.systemInstruction = {
              parts: [{ text: payload.systemInstruction }],
            };
          } else {
            googleBody.systemInstruction = payload.systemInstruction;
          }
        }

        const genCfg = sanitizeGenerationConfig(model, payload?.generationConfig, stripThinking);
        if (genCfg) {
          googleBody.generationConfig = genCfg;
        }

        if (!stripTools && Array.isArray(payload?.tools) && payload.tools.length > 0) {
          googleBody.tools = payload.tools;
        }

        const action = isStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model,
        )}:${action}`;

        try {
          const upstream = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(googleBody),
          });

          if (upstream.ok) {
            if (isStream) {
              return new Response(upstream.body, {
                status: 200,
                headers: {
                  ...CORS_HEADERS,
                  'Content-Type': 'text/event-stream; charset=utf-8',
                  'Cache-Control': 'no-cache, no-transform',
                  'X-Used-Model': model,
                },
              });
            }

            const dataText = await upstream.text();
            return new Response(dataText, {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                'Content-Type': 'application/json; charset=utf-8',
                'X-Used-Model': model,
              },
            });
          }

          const errText = await upstream.text();
          lastStatus = upstream.status;
          lastErrorBody = errText || lastErrorBody;
          const lowerErr = errText.toLowerCase();

          // 400 do thinkingConfig hoặc tools không tương thích -> tự thử lại không kèm tham số đó
          if (upstream.status === 400) {
            const isInvalidKey = lowerErr.includes('api_key_invalid') || lowerErr.includes('api key not valid');
            if (isInvalidKey) {
              break; // thử key tiếp theo
            }
            if (attemptMode === 'normal' && lowerErr.includes('thinking')) {
              continue; // thử attemptMode = 'no-thinking'
            }
            if (attemptMode !== 'plain' && (lowerErr.includes('tool') || lowerErr.includes('google_search') || lowerErr.includes('search'))) {
              continue; // thử attemptMode = 'plain'
            }
            return new Response(errText, {
              status: 400,
              headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
          }

          // 404 NOT_FOUND -> bỏ qua model này, sang model tiếp theo
          if (upstream.status === 404) {
            break;
          }

          // 500/502/503/504 -> quá tải model, chuyển sang model tiếp theo
          if (upstream.status >= 500) {
            break;
          }

          // 401 / 403 / 429 -> thử key tiếp theo trên cùng model, hết key sẽ sang model tiếp theo
          break;
        } catch (fetchErr: any) {
          lastStatus = 502;
          lastErrorBody = JSON.stringify({
            error: { message: fetchErr?.message || 'Upstream network error' },
          });
          break;
        }
      }

      if (lastStatus === 404 || lastStatus >= 500) {
        break; // sang model tiếp theo ngay
      }
    }
  }

  return new Response(lastErrorBody, {
    status: lastStatus || 500,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
