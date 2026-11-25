import React, { useState, useEffect, useMemo } from 'react';
import { Button } from './Button';
import {
  Key,
  X,
  Zap,
  Cpu,
  Sparkles,
  ExternalLink,
  Server,
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldCheck,
  Play,
  Loader2,
  Lock,
} from 'lucide-react';
import {
  DEFAULT_GEMINI_MODEL,
  FALLBACK_MODELS,
  AGENT_PLATFORM_MODELS,
  GEMINI_MODEL_STORAGE_KEY,
  LEGACY_GEMINI_MODEL_STORAGE_KEYS,
  MODEL_INFO,
  resolveModelAlias,
  type AiProvider,
} from '../constants';
import { isValidGoogleAiApiKey, normalizeGoogleAiApiKey } from '../services/apiKeyValidation';
import { apiKeyManager, MAX_KEYS, type ApiKeyInfo } from '../services/apiKeyManager';
import {
  SERVER_PROXY_KEY_SENTINEL,
  checkServerProxyAvailable,
  getServerProxyStatus,
  subscribeServerProxyStatus,
  testApiKey,
  type ApiKeyTestResult,
  type ServerProxyStatus,
} from '../services/geminiService';

interface ApiKeyModalProps {
  isOpen: boolean;
  onSave: (key: string, selectedModel: string, provider: AiProvider) => void;
  onClose: () => void;
  isDismissible?: boolean;
}

const AGENT_PLATFORM_MODEL_STORAGE_KEY = 'agent_platform_model_id';

const ModelIcon: React.FC<{ modelId: string }> = ({ modelId }) => {
  if (modelId.startsWith('gemini-4')) return <Sparkles className="w-5 h-5" />;
  if (modelId.includes('flash-lite')) return <Zap className="w-5 h-5" />;
  if (modelId.includes('pro')) return <Sparkles className="w-5 h-5" />;
  return <Cpu className="w-5 h-5" />;
};

const getModelsForProvider = (provider: AiProvider): string[] => {
  if (provider === 'agent-platform') {
    return [...AGENT_PLATFORM_MODELS];
  }
  return [...FALLBACK_MODELS];
};

const getDefaultModel = (provider: AiProvider): string => {
  if (provider === 'agent-platform') return AGENT_PLATFORM_MODELS[0] || 'gemini-3-flash-preview';
  return DEFAULT_GEMINI_MODEL;
};

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({
  isOpen,
  onSave,
  onClose,
  isDismissible = true,
}) => {
  const [provider, setProvider] = useState<AiProvider>('gemini');
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_GEMINI_MODEL);
  const [bulkInput, setBulkInput] = useState('');
  const [agentApiKey, setAgentApiKey] = useState('');
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const [poolKeys, setPoolKeys] = useState<ApiKeyInfo[]>(() => apiKeyManager.getAllKeys());
  const [activePoolKey, setActivePoolKey] = useState<string | null>(() => apiKeyManager.getActiveKey());
  const [proxyStatus, setProxyStatus] = useState<ServerProxyStatus>(() => getServerProxyStatus());

  const [testingIds, setTestingIds] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, ApiKeyTestResult>>({});
  const [isTestingAll, setIsTestingAll] = useState(false);
  const [tick, setTick] = useState(0);

  const availableModels = useMemo(() => getModelsForProvider(provider), [provider]);

  const refreshPool = () => {
    setPoolKeys(apiKeyManager.getAllKeys());
    setActivePoolKey(apiKeyManager.getActiveKey());
  };

  useEffect(() => {
    if (!isOpen) return;

    refreshPool();
    const unsubPool = apiKeyManager.subscribe(refreshPool);
    const unsubProxy = subscribeServerProxyStatus(setProxyStatus);
    if (!getServerProxyStatus().checked) {
      checkServerProxyAvailable().catch(() => {});
    }

    // Dọn các khóa model cũ khi mở modal
    for (const oldKey of LEGACY_GEMINI_MODEL_STORAGE_KEYS) {
      localStorage.removeItem(oldKey);
    }

    const rawSavedProvider = localStorage.getItem('google_ai_provider');
    const savedProvider: AiProvider =
      rawSavedProvider === 'agent-platform' ? 'agent-platform' : 'gemini';
    if (rawSavedProvider === 'vertex') {
      localStorage.setItem('google_ai_provider', 'gemini');
    }
    setProvider(savedProvider);

    setAgentApiKey(localStorage.getItem('agent_platform_api_key') || '');

    const savedModelKey =
      savedProvider === 'agent-platform'
        ? AGENT_PLATFORM_MODEL_STORAGE_KEY
        : GEMINI_MODEL_STORAGE_KEY;
    const savedModel = localStorage.getItem(savedModelKey);
    setSelectedModel(resolveModelAlias(savedModel, savedProvider));

    setError('');
    setStatusMessage('');

    // Bộ đếm giây trực tiếp cho trạng thái cooldown từng key
    const timer = setInterval(() => {
      setTick((t) => t + 1);
      refreshPool();
    }, 1000);

    return () => {
      unsubPool();
      unsubProxy();
      clearInterval(timer);
    };
  }, [isOpen]);

  const handleProviderChange = (newProvider: AiProvider) => {
    setProvider(newProvider);
    setError('');
    setStatusMessage('');

    if (newProvider === 'agent-platform') {
      setAgentApiKey(localStorage.getItem('agent_platform_api_key') || '');
      const savedAgentModel = localStorage.getItem(AGENT_PLATFORM_MODEL_STORAGE_KEY);
      setSelectedModel(resolveModelAlias(savedAgentModel, 'agent-platform'));
    } else {
      const savedGeminiModel = localStorage.getItem(GEMINI_MODEL_STORAGE_KEY);
      setSelectedModel(resolveModelAlias(savedGeminiModel, 'gemini'));
    }
  };

  const handleBulkAdd = () => {
    setError('');
    setStatusMessage('');
    if (!bulkInput.trim()) {
      setError('Vui lòng dán ít nhất 1 API Key vào ô bên trên.');
      return;
    }

    const res = apiKeyManager.addKeysBulk(bulkInput);
    refreshPool();

    if (res.added === 0) {
      if (res.limitReached) {
        setError(`Kho đã đạt giới hạn tối đa ${MAX_KEYS} API Key.`);
      } else if (res.duplicates > 0 && res.invalid === 0) {
        setStatusMessage(`Tất cả ${res.duplicates} key bạn dán đều đã có sẵn trong kho.`);
        setBulkInput('');
      } else {
        setError(
          `Không tìm thấy key hợp lệ (${res.invalid} chuỗi sai định dạng — key cần bắt đầu bằng AIzaSy... hoặc AQ...).`,
        );
      }
      return;
    }

    const parts: string[] = [`✅ Đã thêm ${res.added} API Key vào kho xoay vòng`];
    if (res.duplicates > 0) parts.push(`bỏ qua ${res.duplicates} key trùng`);
    if (res.invalid > 0) parts.push(`${res.invalid} dòng không hợp lệ`);
    if (res.limitReached) parts.push(`đã chạm trần ${MAX_KEYS} key`);
    setStatusMessage(parts.join(' • '));
    setBulkInput('');
  };

  const handleTestSingleKey = async (item: ApiKeyInfo) => {
    setTestingIds((prev) => ({ ...prev, [item.id]: true }));
    try {
      const res = await testApiKey(item.key, 'gemini', selectedModel);
      setTestResults((prev) => ({ ...prev, [item.id]: res }));
      refreshPool();
    } finally {
      setTestingIds((prev) => ({ ...prev, [item.id]: false }));
    }
  };

  const handleTestAllKeys = async () => {
    if (poolKeys.length === 0 || isTestingAll) return;
    setIsTestingAll(true);
    setError('');
    setStatusMessage(`Đang kiểm tra lần lượt ${poolKeys.length} API Key...`);

    let okCount = 0;
    let quotaCount = 0;
    let failCount = 0;

    for (const item of poolKeys) {
      setTestingIds((prev) => ({ ...prev, [item.id]: true }));
      try {
        const res = await testApiKey(item.key, 'gemini', selectedModel);
        setTestResults((prev) => ({ ...prev, [item.id]: res }));
        if (res.ok) okCount++;
        else if (res.errorType === 'QUOTA_EXCEEDED' || res.errorType === 'RATE_LIMIT') quotaCount++;
        else failCount++;
      } finally {
        setTestingIds((prev) => ({ ...prev, [item.id]: false }));
      }
    }

    refreshPool();
    setIsTestingAll(false);
    setStatusMessage(
      `Kết quả kiểm tra: ${okCount} hoạt động tốt • ${quotaCount} chạm hạn mức tạm thời • ${failCount} lỗi`,
    );
  };

  const handleTestAgentKey = async () => {
    const clean = normalizeGoogleAiApiKey(agentApiKey);
    if (!isValidGoogleAiApiKey(clean)) {
      setError('Agent Platform API Key không hợp lệ (cần bắt đầu bằng AIzaSy... hoặc AQ...).');
      return;
    }
    setTestingIds((prev) => ({ ...prev, agent: true }));
    setError('');
    try {
      const res = await testApiKey(clean, 'agent-platform', selectedModel);
      setTestResults((prev) => ({ ...prev, agent: res }));
      if (res.ok) {
        setStatusMessage(`✅ Agent Platform Key: ${res.message}`);
      } else {
        setError(res.message);
      }
    } finally {
      setTestingIds((prev) => ({ ...prev, agent: false }));
    }
  };

  const handleSave = () => {
    setError('');

    if (provider === 'agent-platform') {
      const cleanAgentKey = normalizeGoogleAiApiKey(agentApiKey);
      if (!cleanAgentKey) {
        setError('Vui lòng nhập Agent Platform API Key.');
        return;
      }
      if (!isValidGoogleAiApiKey(cleanAgentKey)) {
        setError('API Key không hợp lệ. Key phải bắt đầu bằng "AIzaSy..." hoặc "AQ..."');
        return;
      }

      const resolvedModel = resolveModelAlias(selectedModel, 'agent-platform');
      localStorage.setItem('agent_platform_api_key', cleanAgentKey);
      localStorage.setItem('google_ai_provider', 'agent-platform');
      localStorage.setItem('google_ai_provider_selection_source', 'manual');
      localStorage.setItem(AGENT_PLATFORM_MODEL_STORAGE_KEY, resolvedModel);

      onSave(cleanAgentKey, resolvedModel, 'agent-platform');
      return;
    }

    // Tab Gemini API: nếu người dùng vừa dán key vào ô nhưng bấm thẳng "Lưu cấu hình", tự động nạp luôn!
    if (bulkInput.trim()) {
      const bulkRes = apiKeyManager.addKeysBulk(bulkInput);
      refreshPool();
      if (bulkRes.added === 0 && apiKeyManager.getAllKeys().length === 0 && !proxyStatus.available) {
        setError('API Key vừa nhập không đúng định dạng (cần bắt đầu bằng AIzaSy... hoặc AQ...).');
        return;
      }
      setBulkInput('');
    }

    const activeKey = apiKeyManager.getActiveKey();
    const keyToUse = activeKey || (proxyStatus.available ? SERVER_PROXY_KEY_SENTINEL : '');

    if (!keyToUse) {
      setError('Vui lòng thêm ít nhất 1 Gemini API Key vào kho xoay vòng để sử dụng ứng dụng.');
      return;
    }

    const resolvedModel = resolveModelAlias(selectedModel, 'gemini');
    localStorage.setItem('google_ai_provider', 'gemini');
    localStorage.setItem('google_ai_provider_selection_source', 'manual');
    localStorage.setItem(GEMINI_MODEL_STORAGE_KEY, resolvedModel);
    for (const oldKey of LEGACY_GEMINI_MODEL_STORAGE_KEYS) {
      localStorage.removeItem(oldKey);
    }

    onSave(keyToUse, resolvedModel, 'gemini');
  };

  if (!isOpen) return null;

  const stats = apiKeyManager.getStats();
  void tick; // giữ re-render đếm ngược cooldown

  return (
    <div className="fixed inset-0 bg-black/55 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col border border-sky-100">
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex-shrink-0 bg-gradient-to-r from-sky-50 via-white to-orange-50">
          {isDismissible && (
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              title="Đóng"
            >
              <X size={20} />
            </button>
          )}

          <div className="flex items-center gap-3">
            <div className="p-3 bg-gradient-to-br from-orange-500 to-sky-500 rounded-xl shadow-md">
              <Key className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">
                Kho API Key Xoay Vòng & Cấu Hình Model AI
              </h2>
              <p className="text-xs sm:text-sm text-gray-600">
                Hỗ trợ tối đa {MAX_KEYS} key • Tự động xoay key & chuyển 6 model Free Tier khi hết quota
              </p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Provider Tabs */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              1. Chọn Dịch vụ AI
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleProviderChange('gemini')}
                className={`flex items-center gap-2.5 p-3.5 rounded-xl border-2 transition-all text-left ${
                  provider === 'gemini'
                    ? 'border-sky-500 bg-sky-50/80 shadow-sm'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <Cpu className={`w-5 h-5 flex-shrink-0 ${provider === 'gemini' ? 'text-sky-600' : 'text-gray-400'}`} />
                <div>
                  <div className={`font-bold text-sm ${provider === 'gemini' ? 'text-sky-800' : 'text-gray-700'}`}>
                    Gemini API
                  </div>
                  <div className="text-xs text-gray-500">Google AI Studio • Free Tier</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleProviderChange('agent-platform')}
                className={`flex items-center gap-2.5 p-3.5 rounded-xl border-2 transition-all text-left ${
                  provider === 'agent-platform'
                    ? 'border-purple-500 bg-purple-50/80 shadow-sm'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <Server className={`w-5 h-5 flex-shrink-0 ${provider === 'agent-platform' ? 'text-purple-600' : 'text-gray-400'}`} />
                <div>
                  <div className={`font-bold text-sm ${provider === 'agent-platform' ? 'text-purple-800' : 'text-gray-700'}`}>
                    Agent Platform API
                  </div>
                  <div className="text-xs text-gray-500">Google Cloud Express Mode</div>
                </div>
              </button>
            </div>
          </div>

          {/* Gemini Multi-Key Pool Section */}
          {provider === 'gemini' ? (
            <div className="space-y-4 border-t border-gray-100 pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-sm font-semibold text-gray-800">
                  2. Kho Gemini API Key xoay vòng ({stats.total}/{MAX_KEYS} key)
                </label>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                    {stats.active} sẵn sàng
                  </span>
                  {stats.cooldown > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                      {stats.cooldown} tạm nghỉ
                    </span>
                  )}
                  {stats.error > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                      {stats.error} lỗi
                    </span>
                  )}
                </div>
              </div>

              {/* Server Proxy Status Banner */}
              {proxyStatus.available && (
                <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-2.5 text-xs sm:text-sm text-emerald-800">
                  <ShieldCheck className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>Đã kết nối Kho Key Dự Phòng Trên Máy Chủ ({proxyStatus.keyCount} key ẩn bảo mật):</strong>{' '}
                    Bạn có thể bấm <strong>Lưu cấu hình</strong> để dùng ngay, hoặc dán thêm API key cá nhân bên dưới để tăng hạn mức riêng.
                  </div>
                </div>
              )}

              {/* Hidden local env keys notice */}
              {stats.envCount > 0 && (
                <div className="p-3 rounded-xl bg-sky-50 border border-sky-200 flex items-center gap-2 text-xs text-sky-800">
                  <Lock className="w-4 h-4 text-sky-600 flex-shrink-0" />
                  <span>
                    Đang nạp <strong>{stats.envCount} key hệ thống</strong> trong bộ nhớ tạm (không lưu xuống trình duyệt, luôn ẩn mã gốc).
                  </span>
                </div>
              )}

              {/* Bulk Paste Input */}
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                <label className="block text-xs font-semibold text-slate-700">
                  ➕ Dán thêm 1 hoặc nhiều API Key cùng lúc (mỗi dòng 1 key, hoặc cách nhau bởi dấu phẩy):
                </label>
                <textarea
                  rows={3}
                  value={bulkInput}
                  onChange={(e) => {
                    setBulkInput(e.target.value);
                    setError('');
                  }}
                  placeholder={
                    'AIzaSy...\nAQ...\n(Mẹo: Tạo 3–5 key miễn phí từ các tài khoản Gmail khác nhau để nhân 18–30 lần hạn mức!)'
                  }
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 bg-white focus:ring-2 focus:ring-sky-500 focus:border-transparent outline-none text-xs sm:text-sm font-mono resize-y"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <a
                    href="https://aistudio.google.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-600 hover:text-orange-700 hover:underline"
                  >
                    <ExternalLink size={14} />
                    Lấy API Key miễn phí tại Google AI Studio
                  </a>
                  <button
                    type="button"
                    onClick={handleBulkAdd}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs sm:text-sm font-semibold shadow-xs transition-colors"
                  >
                    <Plus size={16} />
                    Thêm vào kho Key
                  </button>
                </div>
              </div>

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs sm:text-sm text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {statusMessage && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs sm:text-sm text-emerald-800">
                  {statusMessage}
                </div>
              )}

              {/* Key Pool List */}
              {poolKeys.length > 0 && (
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-gray-700">
                      Danh sách API Key trong kho ({poolKeys.length})
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleTestAllKeys}
                        disabled={isTestingAll}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-sky-200 text-sky-700 hover:bg-sky-50 text-xs font-medium disabled:opacity-50"
                      >
                        {isTestingAll ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                        Test tất cả
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          apiKeyManager.resetAllKeys();
                          setTestResults({});
                          refreshPool();
                          setStatusMessage('🔄 Đã làm mới trạng thái toàn bộ kho API Key.');
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-gray-200 text-gray-700 hover:bg-gray-100 text-xs font-medium"
                      >
                        <RefreshCw size={12} />
                        Reset trạng thái
                      </button>
                      {stats.userCount > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            apiKeyManager.clearAllUserKeys();
                            setTestResults({});
                            refreshPool();
                            setStatusMessage('Đã xóa toàn bộ API Key cá nhân khỏi trình duyệt.');
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-red-200 text-red-600 hover:bg-red-50 text-xs font-medium"
                        >
                          <Trash2 size={12} />
                          Xóa hết
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                    {poolKeys.map((item) => {
                      const isCurrent = item.key === activePoolKey;
                      const cooldowns = apiKeyManager.getActiveModelCooldowns(item.id);
                      const isTesting = Boolean(testingIds[item.id]);
                      const testRes = testResults[item.id];

                      return (
                        <div
                          key={item.id}
                          className={`px-4 py-2.5 flex flex-col gap-1.5 text-xs ${
                            isCurrent ? 'bg-sky-50/60' : 'bg-white hover:bg-gray-50/70'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-semibold text-gray-800 truncate">{item.name}</span>
                              <code className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded font-mono text-[11px]">
                                {item.maskedKey}
                              </code>
                              {item.isHidden || item.source === 'env' ? (
                                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium">
                                  🔒 Hệ thống
                                </span>
                              ) : null}
                              {isCurrent && (
                                <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 font-semibold">
                                  Đang ưu tiên
                                </span>
                              )}
                              {item.status === 'error' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                                  <AlertCircle size={11} /> Lỗi key
                                </span>
                              ) : cooldowns.length > 0 ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
                                  <Clock size={11} />
                                  Nghỉ {cooldowns[0].model.replace('gemini-', '')}: {cooldowns[0].remainingSec}s
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                                  <CheckCircle2 size={11} /> Sẵn sàng
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5">
                              {!isCurrent && item.status !== 'error' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    apiKeyManager.setActiveKey(item.id);
                                    refreshPool();
                                  }}
                                  className="px-2 py-1 rounded border border-sky-200 text-sky-700 hover:bg-sky-50 font-medium"
                                >
                                  Dùng
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleTestSingleKey(item)}
                                disabled={isTesting}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 text-gray-700 hover:bg-gray-100 font-medium disabled:opacity-50"
                              >
                                {isTesting ? <Loader2 size={11} className="animate-spin" /> : 'Test'}
                              </button>
                              {(item.status === 'error' || cooldowns.length > 0) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    apiKeyManager.resetKeyStatus(item.id);
                                    refreshPool();
                                  }}
                                  className="px-2 py-1 rounded border border-amber-200 text-amber-700 hover:bg-amber-50 font-medium"
                                >
                                  Reset
                                </button>
                              )}
                              {item.source === 'user' && !item.isHidden && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    apiKeyManager.removeKey(item.id);
                                    refreshPool();
                                  }}
                                  className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                                  title="Xóa key này"
                                >
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </div>
                          </div>

                          {(testRes || item.lastError || item.usageCount > 0) && (
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-500">
                              <span>
                                {testRes ? (
                                  <span className={testRes.ok ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                                    {testRes.ok ? '✓ ' : '⚠ '}
                                    {testRes.message}
                                  </span>
                                ) : item.lastError ? (
                                  <span className="text-amber-700">{item.lastError}</span>
                                ) : null}
                              </span>
                              {item.usageCount > 0 && <span>Đã gọi: {item.usageCount} lần</span>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Agent Platform Single Key Section */
            <div className="space-y-3 border-t border-gray-100 pt-5">
              <label className="block text-sm font-semibold text-gray-800">
                2. Agent Platform API Key (Google Cloud)
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={agentApiKey}
                  onChange={(e) => {
                    setAgentApiKey(e.target.value);
                    setError('');
                  }}
                  placeholder="Nhập Agent Platform API Key (AIzaSy... hoặc AQ...)"
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-300 focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none text-sm font-mono"
                />
                <button
                  type="button"
                  onClick={handleTestAgentKey}
                  disabled={Boolean(testingIds.agent)}
                  className="px-4 py-2.5 rounded-xl border border-purple-200 bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-semibold flex items-center gap-1.5"
                >
                  {testingIds.agent ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  Test Key
                </button>
              </div>

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs sm:text-sm text-red-700">
                  ⚠️ {error}
                </div>
              )}
              {statusMessage && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs sm:text-sm text-emerald-800">
                  {statusMessage}
                </div>
              )}

              <div className="p-3.5 bg-purple-50 border border-purple-200 rounded-xl text-xs text-purple-800 space-y-1.5">
                <p className="font-semibold">📖 Hướng dẫn lấy Agent Platform API Key:</p>
                <ol className="list-decimal list-inside space-y-0.5 text-purple-700">
                  <li>Truy cập Google Cloud Console & bật Agent Platform API</li>
                  <li>Tạo API Key được cấp quyền gọi endpoint aiplatform.googleapis.com</li>
                  <li>Dán vào ô trên (lưu tách biệt hoàn toàn với kho Gemini API Key)</li>
                </ol>
                <a
                  href="https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-semibold text-purple-700 hover:underline pt-1"
                >
                  <ExternalLink size={13} />
                  Tài liệu Agent Platform API Key
                </a>
              </div>
            </div>
          )}

          {/* Model Selection */}
          <div className="border-t border-gray-100 pt-5">
            <label className="block text-sm font-semibold text-gray-800 mb-2.5">
              3. Chọn Model AI ưu tiên
            </label>
            <div className="grid grid-cols-1 gap-2.5">
              {availableModels.map((modelId) => {
                const info = MODEL_INFO[modelId];
                const isSelected = selectedModel === modelId;
                const isPurple = provider === 'agent-platform';
                const isDefaultForTab = modelId === getDefaultModel(provider);

                return (
                  <button
                    type="button"
                    key={modelId}
                    onClick={() => setSelectedModel(modelId)}
                    className={`relative flex items-center gap-3 p-3.5 rounded-xl border-2 transition-all text-left ${
                      isSelected
                        ? isPurple
                          ? 'border-purple-500 bg-purple-50/80 shadow-xs'
                          : 'border-sky-500 bg-sky-50/80 shadow-xs'
                        : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div
                      className="p-2 rounded-lg flex-shrink-0"
                      style={{
                        backgroundColor: isSelected ? (isPurple ? '#9333ea' : '#0284c7') : '#f3f4f6',
                        color: isSelected ? '#ffffff' : '#4b5563',
                      }}
                    >
                      <ModelIcon modelId={modelId} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`font-bold text-sm ${
                            isSelected ? (isPurple ? 'text-purple-800' : 'text-sky-800') : 'text-gray-900'
                          }`}
                        >
                          {info?.name || modelId}
                        </span>
                        {isDefaultForTab && (
                          <span className="px-2 py-0.5 text-[11px] font-semibold bg-emerald-100 text-emerald-700 rounded-full">
                            Mặc định khuyên dùng
                          </span>
                        )}
                        {info?.badge && !isDefaultForTab && (
                          <span className="px-2 py-0.5 text-[11px] font-medium bg-sky-100 text-sky-700 rounded-full">
                            {info.badge}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{info?.description || modelId}</p>
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-gray-500 mt-2.5">
              💡 Cơ chế chống đứt quãng 2 tầng: Khi 1 key chạm hạn mức trên model đang chọn, app tự xoay sang key tiếp theo; khi tất cả key đều chạm hạn mức trên model đó, app tự chuyển sang các model Free Tier còn lại (mỗi model có hạn mức riêng biệt).
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/80 flex items-center justify-between gap-3 flex-shrink-0">
          <span className="text-xs text-gray-500 hidden sm:inline">
            🔒 Key cá nhân chỉ lưu cục bộ trên trình duyệt của bạn.
          </span>
          <div className="flex items-center gap-2.5 ml-auto">
            {isDismissible && (
              <Button variant="secondary" onClick={onClose}>
                Đóng
              </Button>
            )}
            <Button onClick={handleSave}>Lưu cấu hình</Button>
          </div>
        </div>
      </div>
    </div>
  );
};
