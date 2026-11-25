/**
 * API Key Manager — Quản lý kho tối đa 30 Gemini API Key (v5.0)
 * - Hỗ trợ nhập hàng loạt (bulk paste), test từng key / test tất cả
 * - Cooldown thông minh theo từng cặp (key, model) cho RPM (~65s) và RPD (15 phút)
 * - Nạp key từ .env.local (VITE_GEMINI_API_KEYS) CHỈ trong RAM (isHidden: true, KHÔNG lưu localStorage)
 */

import {
  isValidGoogleAiApiKey,
  maskGoogleAiApiKey,
  normalizeGoogleAiApiKey,
} from './apiKeyValidation';

export interface ApiKeyInfo {
  id: string;
  key: string;
  maskedKey: string;
  name: string;
  status: 'active' | 'exhausted' | 'error';
  source: 'user' | 'env';
  isHidden?: boolean;
  lastError?: string;
  lastUsed?: number;
  exhaustedAt?: number;
  usageCount: number;
  modelCooldowns?: Record<string, number>; // modelId -> cooldownUntil timestamp (ms)
}

export interface BulkAddResult {
  added: number;
  duplicates: number;
  invalid: number;
  limitReached: boolean;
  firstAddedKey: string | null;
}

export interface ApiKeyStats {
  total: number;
  userCount: number;
  envCount: number;
  active: number;
  cooldown: number;
  exhausted: number;
  error: number;
}

const STORAGE_KEY = 'gemini_api_keys';
const LEGACY_SINGLE_KEY = 'gemini_api_key';
export const MAX_KEYS = 30;

const DEFAULT_RPM_COOLDOWN_MS = 65 * 1000;      // 65 giây khi vướng giới hạn tốc độ RPM
const DEFAULT_RPD_COOLDOWN_MS = 15 * 60 * 1000; // 15 phút khi hết quota ngày RPD trên 1 model

type KeyPoolListener = () => void;

class ApiKeyManager {
  private keys: ApiKeyInfo[] = [];
  private activeKeyIndex = 0;
  private listeners: Set<KeyPoolListener> = new Set();

  constructor() {
    this.loadFromStorage();
    this.injectEnvKeysInMemory();
    this.cleanupExpiredCooldowns(false);
    this.syncLegacyActiveKey();
  }

  subscribe(listener: KeyPoolListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // ignore listener errors
      }
    });
  }

  private parseEnvKeys(): string[] {
    try {
      const raw = (import.meta as any)?.env?.VITE_GEMINI_API_KEYS || '';
      if (!raw || typeof raw !== 'string') return [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const token of raw.split(/[\n,;]+/)) {
        const clean = normalizeGoogleAiApiKey(token);
        if (isValidGoogleAiApiKey(clean) && !seen.has(clean)) {
          seen.add(clean);
          out.push(clean);
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private loadFromStorage(): void {
    const envSet = new Set(this.parseEnvKeys());

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        const rawList: any[] = Array.isArray(data?.keys) ? data.keys : [];
        const loaded: ApiKeyInfo[] = [];
        const seen = new Set<string>();

        for (const item of rawList) {
          const clean = normalizeGoogleAiApiKey(item?.key || '');
          if (!isValidGoogleAiApiKey(clean) || seen.has(clean)) continue;
          // Nếu key trùng với key trong .env.local thì bỏ bản lưu cũ trong localStorage để giữ ẩn trong RAM
          if (envSet.has(clean)) continue;

          seen.add(clean);
          loaded.push({
            id: item.id || this.generateId(),
            key: clean,
            maskedKey: maskGoogleAiApiKey(clean),
            name: item.name || `Key ${loaded.length + 1}`,
            status: item.status === 'error' ? 'error' : 'active',
            source: 'user',
            isHidden: false,
            lastError: item.lastError,
            lastUsed: item.lastUsed,
            usageCount: typeof item.usageCount === 'number' ? item.usageCount : 0,
            modelCooldowns:
              item.modelCooldowns && typeof item.modelCooldowns === 'object'
                ? { ...item.modelCooldowns }
                : {},
          });
          if (loaded.length >= MAX_KEYS) break;
        }

        this.keys = loaded;
        this.activeKeyIndex =
          typeof data?.activeKeyIndex === 'number' &&
          data.activeKeyIndex >= 0 &&
          data.activeKeyIndex < this.keys.length
            ? data.activeKeyIndex
            : 0;
      }

      // Di trú key đơn lẻ từ phiên bản cũ (gemini_api_key)
      const legacyKey = normalizeGoogleAiApiKey(localStorage.getItem(LEGACY_SINGLE_KEY) || '');
      if (legacyKey) {
        if (envSet.has(legacyKey)) {
          // Xóa key env từng bị ghi nhầm xuống localStorage ở bản cũ
          localStorage.removeItem(LEGACY_SINGLE_KEY);
        } else if (
          isValidGoogleAiApiKey(legacyKey) &&
          !this.keys.some((k) => k.key === legacyKey) &&
          this.keys.length < MAX_KEYS
        ) {
          this.keys.unshift({
            id: this.generateId(),
            key: legacyKey,
            maskedKey: maskGoogleAiApiKey(legacyKey),
            name: 'Key 1',
            status: 'active',
            source: 'user',
            isHidden: false,
            usageCount: 0,
            modelCooldowns: {},
          });
          this.activeKeyIndex = 0;
        }
      }

      this.saveToStorage();
    } catch (e) {
      console.error('Lỗi đọc kho API key:', e);
      this.keys = [];
      this.activeKeyIndex = 0;
    }
  }

  /**
   * Nạp key từ .env.local CHỈ vào RAM (isHidden: true, source: 'env'),
   * TUYỆT ĐỐI KHÔNG ghi xuống localStorage (api.md §V.2).
   */
  private injectEnvKeysInMemory(): void {
    const envKeys = this.parseEnvKeys();
    if (envKeys.length === 0) return;

    let envIdx = 1;
    for (const clean of envKeys) {
      if (this.keys.length >= MAX_KEYS) break;
      if (this.keys.some((k) => k.key === clean)) continue;

      this.keys.push({
        id: `env_${envIdx}`,
        key: clean,
        maskedKey: maskGoogleAiApiKey(clean),
        name: `Key hệ thống #${envIdx}`,
        status: 'active',
        source: 'env',
        isHidden: true,
        usageCount: 0,
        modelCooldowns: {},
      });
      envIdx++;
    }

    if (this.activeKeyIndex >= this.keys.length) {
      this.activeKeyIndex = 0;
    }
  }

  /**
   * Chỉ lưu các key do người dùng nhập (source === 'user' && !isHidden) xuống localStorage.
   */
  private saveToStorage(): void {
    try {
      const userKeys = this.keys
        .filter((k) => k.source === 'user' && !k.isHidden)
        .map((k) => ({
          id: k.id,
          key: k.key,
          maskedKey: maskGoogleAiApiKey(k.key),
          name: k.name,
          status: k.status === 'error' ? 'error' : 'active',
          source: 'user',
          lastError: k.lastError,
          lastUsed: k.lastUsed,
          usageCount: k.usageCount,
          modelCooldowns: k.modelCooldowns || {},
        }));

      const activeKeyObj = this.keys[this.activeKeyIndex];
      const savedActiveIdx =
        activeKeyObj && activeKeyObj.source === 'user'
          ? Math.max(
              0,
              userKeys.findIndex((u) => u.key === activeKeyObj.key),
            )
          : 0;

      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          keys: userKeys,
          activeKeyIndex: savedActiveIdx,
        }),
      );
      this.syncLegacyActiveKey();
    } catch (e) {
      console.error('Lỗi lưu kho API key:', e);
    }
  }

  private syncLegacyActiveKey(): void {
    try {
      const activeObj = this.keys[this.activeKeyIndex];
      if (activeObj && activeObj.source === 'user' && !activeObj.isHidden) {
        localStorage.setItem(LEGACY_SINGLE_KEY, activeObj.key);
      } else {
        const firstUser = this.keys.find((k) => k.source === 'user' && !k.isHidden && k.status !== 'error');
        if (firstUser) {
          localStorage.setItem(LEGACY_SINGLE_KEY, firstUser.key);
        } else {
          localStorage.removeItem(LEGACY_SINGLE_KEY);
        }
      }
    } catch {
      // ignore storage errors
    }
  }

  private generateId(): string {
    return 'key_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  private cleanupExpiredCooldowns(shouldNotify = false): void {
    const now = Date.now();
    let changed = false;

    for (const k of this.keys) {
      if (k.modelCooldowns) {
        for (const [model, until] of Object.entries(k.modelCooldowns)) {
          if (!until || now >= until) {
            delete k.modelCooldowns[model];
            changed = true;
          }
        }
      }
      if (k.status === 'exhausted') {
        const hasAnyCooldown =
          k.modelCooldowns && Object.values(k.modelCooldowns).some((until) => until > now);
        if (!hasAnyCooldown) {
          k.status = 'active';
          k.lastError = undefined;
          k.exhaustedAt = undefined;
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveToStorage();
      if (shouldNotify) this.notify();
    }
  }

  getAllKeys(): ApiKeyInfo[] {
    this.cleanupExpiredCooldowns(false);
    return this.keys.map((k) => ({
      ...k,
      maskedKey: maskGoogleAiApiKey(k.key),
      modelCooldowns: k.modelCooldowns ? { ...k.modelCooldowns } : {},
    }));
  }

  getUserKeys(): ApiKeyInfo[] {
    return this.getAllKeys().filter((k) => k.source === 'user' && !k.isHidden);
  }

  getEnvKeyCount(): number {
    return this.keys.filter((k) => k.source === 'env' || k.isHidden).length;
  }

  getActiveKey(): string | null {
    this.cleanupExpiredCooldowns(false);
    if (this.keys.length === 0) return null;

    const current = this.keys[this.activeKeyIndex];
    if (current && current.status !== 'error') {
      return current.key;
    }

    const validIdx = this.keys.findIndex((k) => k.status !== 'error');
    if (validIdx !== -1) {
      this.activeKeyIndex = validIdx;
      this.saveToStorage();
      return this.keys[validIdx].key;
    }

    return null;
  }

  getActiveKeyInfo(): ApiKeyInfo | null {
    this.cleanupExpiredCooldowns(false);
    if (this.keys.length === 0) return null;
    return this.keys[this.activeKeyIndex] || null;
  }

  /**
   * Trả về danh sách các key sẵn sàng cho một `model` cụ thể theo thứ tự xoay vòng
   * bắt đầu từ `activeKeyIndex` (không bị lỗi auth và không đang cooldown trên `model` đó).
   */
  getAvailableKeysForModel(model: string): string[] {
    this.cleanupExpiredCooldowns(false);
    const total = this.keys.length;
    if (total === 0) return [];

    const now = Date.now();
    const result: string[] = [];
    for (let offset = 0; offset < total; offset++) {
      const idx = (this.activeKeyIndex + offset) % total;
      const item = this.keys[idx];
      if (!item || item.status === 'error') continue;
      const until = item.modelCooldowns?.[model] || 0;
      if (until > now) continue;
      result.push(item.key);
    }
    return result;
  }

  /**
   * Trả về thời gian chờ ngắn nhất (ms) để có ít nhất 1 key thoát cooldown.
   */
  getSoonestCooldownMs(model?: string): number | null {
    this.cleanupExpiredCooldowns(false);
    const now = Date.now();
    let minRemaining: number | null = null;

    for (const item of this.keys) {
      if (item.status === 'error' || !item.modelCooldowns) continue;
      if (model) {
        const until = item.modelCooldowns[model];
        if (until && until > now) {
          const rem = until - now;
          if (minRemaining === null || rem < minRemaining) minRemaining = rem;
        }
      } else {
        for (const until of Object.values(item.modelCooldowns)) {
          if (until && until > now) {
            const rem = until - now;
            if (minRemaining === null || rem < minRemaining) minRemaining = rem;
          }
        }
      }
    }

    return minRemaining;
  }

  getActiveModelCooldowns(keyId: string): Array<{ model: string; remainingSec: number }> {
    const now = Date.now();
    const found = this.keys.find((k) => k.id === keyId);
    if (!found || !found.modelCooldowns) return [];
    return Object.entries(found.modelCooldowns)
      .filter(([, until]) => until > now)
      .map(([model, until]) => ({
        model,
        remainingSec: Math.max(1, Math.ceil((until - now) / 1000)),
      }))
      .sort((a, b) => a.remainingSec - b.remainingSec);
  }

  /**
   * Thêm nhiều API key cùng lúc (tách theo dòng mới, dấu phẩy, chấm phẩy hoặc khoảng trắng).
   */
  addKeysBulk(rawInput: string): BulkAddResult {
    const tokens = (rawInput || '')
      .split(/[\r\n,;]+/)
      .flatMap((line) => {
        const normalizedLine = normalizeGoogleAiApiKey(line);
        if (isValidGoogleAiApiKey(normalizedLine)) return [normalizedLine];
        return line
          .trim()
          .split(/\s+/)
          .map((t) => normalizeGoogleAiApiKey(t))
          .filter(Boolean);
      })
      .filter(Boolean);

    let added = 0;
    let duplicates = 0;
    let invalid = 0;
    let limitReached = false;
    let firstAddedKey: string | null = null;

    for (const candidate of tokens) {
      const clean = normalizeGoogleAiApiKey(candidate);
      if (!clean) continue;

      if (!isValidGoogleAiApiKey(clean)) {
        invalid++;
        continue;
      }

      if (this.keys.some((k) => k.key === clean)) {
        duplicates++;
        continue;
      }

      const userCount = this.keys.filter((k) => k.source === 'user').length;
      if (this.keys.length >= MAX_KEYS) {
        limitReached = true;
        break;
      }

      const newInfo: ApiKeyInfo = {
        id: this.generateId(),
        key: clean,
        maskedKey: maskGoogleAiApiKey(clean),
        name: `Key ${userCount + 1}`,
        status: 'active',
        source: 'user',
        isHidden: false,
        usageCount: 0,
        modelCooldowns: {},
      };

      // Chèn key của người dùng lên trước các key env để ưu tiên quản lý rõ ràng
      const firstEnvIdx = this.keys.findIndex((k) => k.source === 'env' || k.isHidden);
      if (firstEnvIdx === -1) {
        this.keys.push(newInfo);
      } else {
        this.keys.splice(firstEnvIdx, 0, newInfo);
      }

      if (!firstAddedKey) {
        firstAddedKey = clean;
      }
      added++;
    }

    if (added > 0) {
      if (firstAddedKey) {
        const idx = this.keys.findIndex((k) => k.key === firstAddedKey);
        if (idx !== -1 && this.keys.filter((k) => k.source === 'user').length === added) {
          this.activeKeyIndex = idx;
        }
      }
      this.saveToStorage();
      this.notify();
    }

    return { added, duplicates, invalid, limitReached, firstAddedKey };
  }

  addKey(key: string, name?: string): { success: boolean; message: string; keyInfo?: ApiKeyInfo } {
    const cleanKey = normalizeGoogleAiApiKey(key);
    if (!cleanKey) {
      return { success: false, message: 'API Key không được để trống.' };
    }
    if (!isValidGoogleAiApiKey(cleanKey)) {
      return {
        success: false,
        message: 'API Key không hợp lệ (cần bắt đầu bằng AIzaSy... hoặc AQ...).',
      };
    }
    const existing = this.keys.find((k) => k.key === cleanKey);
    if (existing) {
      return { success: false, message: `API Key này đã có trong kho (${existing.name}).`, keyInfo: existing };
    }
    if (this.keys.length >= MAX_KEYS) {
      return { success: false, message: `Kho đã đạt tối đa ${MAX_KEYS} API Key.` };
    }

    const userCount = this.keys.filter((k) => k.source === 'user').length;
    const newKey: ApiKeyInfo = {
      id: this.generateId(),
      key: cleanKey,
      maskedKey: maskGoogleAiApiKey(cleanKey),
      name: name?.trim() || `Key ${userCount + 1}`,
      status: 'active',
      source: 'user',
      isHidden: false,
      usageCount: 0,
      modelCooldowns: {},
    };

    const firstEnvIdx = this.keys.findIndex((k) => k.source === 'env' || k.isHidden);
    if (firstEnvIdx === -1) {
      this.keys.push(newKey);
    } else {
      this.keys.splice(firstEnvIdx, 0, newKey);
    }

    if (userCount === 0) {
      this.activeKeyIndex = this.keys.findIndex((k) => k.id === newKey.id);
    }

    this.saveToStorage();
    this.notify();
    return { success: true, message: `Đã thêm ${newKey.name}.`, keyInfo: newKey };
  }

  removeKey(id: string): boolean {
    const index = this.keys.findIndex((k) => k.id === id);
    if (index === -1) return false;
    // Không xóa key env trong RAM (nếu có)
    if (this.keys[index].source === 'env' || this.keys[index].isHidden) return false;

    this.keys.splice(index, 1);
    if (this.activeKeyIndex >= this.keys.length) {
      this.activeKeyIndex = Math.max(0, this.keys.length - 1);
    }
    this.saveToStorage();
    this.notify();
    return true;
  }

  clearAllUserKeys(): void {
    this.keys = this.keys.filter((k) => k.source === 'env' || k.isHidden);
    this.activeKeyIndex = 0;
    this.saveToStorage();
    this.notify();
  }

  setActiveKey(id: string): boolean {
    const index = this.keys.findIndex((k) => k.id === id);
    if (index === -1) return false;
    this.activeKeyIndex = index;
    if (this.keys[index].status === 'error') {
      this.keys[index].status = 'active';
      this.keys[index].lastError = undefined;
    }
    this.saveToStorage();
    this.notify();
    return true;
  }

  setActiveKeyByValue(keyValue: string): void {
    const clean = normalizeGoogleAiApiKey(keyValue);
    const idx = this.keys.findIndex((k) => k.key === clean);
    if (idx !== -1 && idx !== this.activeKeyIndex) {
      this.activeKeyIndex = idx;
      this.saveToStorage();
      this.notify();
    }
  }

  /**
   * Đưa cặp (key, model) vào trạng thái tạm nghỉ thông minh khi gặp 429 / vượt giới hạn tốc độ.
   * TUYỆT ĐỐI KHÔNG đánh dấu key là 'error' (invalid).
   */
  markKeyModelQuota(
    keyValue: string,
    model: string,
    kind: 'RATE_LIMIT' | 'QUOTA_EXCEEDED',
    retryDelaySec?: number,
  ): void {
    const clean = normalizeGoogleAiApiKey(keyValue);
    const keyObj = this.keys.find((k) => k.key === clean);
    if (!keyObj) return;

    if (!keyObj.modelCooldowns) keyObj.modelCooldowns = {};

    let cooldownMs: number;
    if (retryDelaySec && retryDelaySec > 0 && retryDelaySec <= 180) {
      cooldownMs = Math.max(15, retryDelaySec + 5) * 1000;
    } else if (kind === 'RATE_LIMIT') {
      cooldownMs = DEFAULT_RPM_COOLDOWN_MS;
    } else {
      cooldownMs = DEFAULT_RPD_COOLDOWN_MS;
    }

    keyObj.modelCooldowns[model] = Date.now() + cooldownMs;
    keyObj.lastError =
      kind === 'RATE_LIMIT'
        ? `Giới hạn tốc độ trên ${model} (~${Math.round(cooldownMs / 1000)}s)`
        : `Tạm hết hạn mức trên ${model} (~${Math.round(cooldownMs / 60000)} phút)`;

    // Tự động nhích con trỏ sang key tiếp theo để lượt gọi sau ưu tiên key khỏe
    const keyIdx = this.keys.indexOf(keyObj);
    if (keyIdx === this.activeKeyIndex && this.keys.length > 1) {
      this.activeKeyIndex = (this.activeKeyIndex + 1) % this.keys.length;
    }

    this.saveToStorage();
    this.notify();
  }

  markKeyAuthError(keyValue: string, reason = 'API Key không hợp lệ hoặc đã hết hạn'): void {
    const clean = normalizeGoogleAiApiKey(keyValue);
    const keyObj = this.keys.find((k) => k.key === clean);
    if (!keyObj) return;

    keyObj.status = 'error';
    keyObj.lastError = reason;

    const nextValid = this.keys.findIndex((k) => k.status !== 'error');
    if (nextValid !== -1) {
      this.activeKeyIndex = nextValid;
    }

    this.saveToStorage();
    this.notify();
  }

  markKeySuccess(keyValue: string, model?: string): void {
    const clean = normalizeGoogleAiApiKey(keyValue);
    const idx = this.keys.findIndex((k) => k.key === clean);
    if (idx === -1) return;

    const keyObj = this.keys[idx];
    keyObj.status = 'active';
    keyObj.lastUsed = Date.now();
    keyObj.usageCount = (keyObj.usageCount || 0) + 1;
    keyObj.lastError = undefined;
    if (model && keyObj.modelCooldowns?.[model]) {
      delete keyObj.modelCooldowns[model];
    }
    this.activeKeyIndex = idx;

    this.saveToStorage();
    this.notify();
  }

  /**
   * Hàm tương thích ngược cho các đoạn gọi cũ (rotateToNextKey / markKeyError).
   */
  rotateToNextKey(reason = 'quota_exceeded'): { success: boolean; newKey: string | null; message: string } {
    this.cleanupExpiredCooldowns(false);
    if (this.keys.length === 0) {
      return { success: false, newKey: null, message: 'Chưa có API Key nào trong kho.' };
    }

    if (this.keys.length > 1) {
      for (let offset = 1; offset <= this.keys.length; offset++) {
        const nextIdx = (this.activeKeyIndex + offset) % this.keys.length;
        const candidate = this.keys[nextIdx];
        if (candidate && candidate.status !== 'error') {
          this.activeKeyIndex = nextIdx;
          this.saveToStorage();
          this.notify();
          return {
            success: true,
            newKey: candidate.key,
            message: `Đã chuyển sang ${candidate.name} (${maskGoogleAiApiKey(candidate.key)})`,
          };
        }
      }
    }

    const fallback = this.getActiveKey();
    if (fallback) {
      return {
        success: true,
        newKey: fallback,
        message: `Tiếp tục với ${this.keys[this.activeKeyIndex]?.name || 'Key hiện tại'}`,
      };
    }

    return {
      success: false,
      newKey: null,
      message: `Không còn API key khả dụng (${reason}). Vui lòng kiểm tra Cài đặt API Key.`,
    };
  }

  markKeyError(key: string, errorType: string, model = 'gemini-4-hydrogen'): {
    success: boolean;
    newKey: string | null;
    message: string;
  } {
    if (errorType === 'INVALID_API_KEY') {
      this.markKeyAuthError(key);
    } else if (errorType === 'QUOTA_EXCEEDED' || errorType === 'RATE_LIMIT') {
      this.markKeyModelQuota(key, model, errorType);
    }
    return this.rotateToNextKey(errorType);
  }

  resetKeyStatus(id: string): boolean {
    const keyObj = this.keys.find((k) => k.id === id);
    if (!keyObj) return false;
    keyObj.status = 'active';
    keyObj.lastError = undefined;
    keyObj.exhaustedAt = undefined;
    keyObj.modelCooldowns = {};
    this.saveToStorage();
    this.notify();
    return true;
  }

  resetAllKeys(): void {
    this.keys.forEach((k) => {
      k.status = 'active';
      k.lastError = undefined;
      k.exhaustedAt = undefined;
      k.modelCooldowns = {};
    });
    this.activeKeyIndex = 0;
    this.saveToStorage();
    this.notify();
  }

  getStats(): ApiKeyStats {
    this.cleanupExpiredCooldowns(false);
    const now = Date.now();
    let active = 0;
    let cooldown = 0;
    let error = 0;

    for (const k of this.keys) {
      if (k.status === 'error') {
        error++;
      } else {
        const hasCooldown =
          k.modelCooldowns && Object.values(k.modelCooldowns).some((until) => until > now);
        if (hasCooldown) {
          cooldown++;
        } else {
          active++;
        }
      }
    }

    const userCount = this.keys.filter((k) => k.source === 'user' && !k.isHidden).length;
    const envCount = this.keys.filter((k) => k.source === 'env' || k.isHidden).length;

    return {
      total: this.keys.length,
      userCount,
      envCount,
      active,
      cooldown,
      exhausted: cooldown,
      error,
    };
  }
}

export const apiKeyManager = new ApiKeyManager();
export default apiKeyManager;
