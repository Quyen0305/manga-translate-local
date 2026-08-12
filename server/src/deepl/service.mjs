import { ProviderApiError } from "../shared/errors.mjs";

export const DEEPL_FREE_URL = "https://api-free.deepl.com";
export const DEEPL_PRO_URL = "https://api.deepl.com";

export async function resolveDeepLEndpoint({ apiKey, baseUrl = "", fetchImpl = fetch }) {
  const customUrl = normalizeBaseUrl(baseUrl);
  const preferred = apiKey.trim().endsWith(":fx") ? DEEPL_FREE_URL : DEEPL_PRO_URL;
  const alternate = preferred === DEEPL_FREE_URL ? DEEPL_PRO_URL : DEEPL_FREE_URL;
  const candidates = customUrl ? [customUrl] : [preferred, alternate];
  const attempts = [];

  for (const endpoint of candidates) {
    let response;
    try {
      response = await fetchImpl(`${endpoint}/v2/usage`, {
        headers: { authorization: `DeepL-Auth-Key ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      attempts.push({ endpoint, error: error.message });
      if (customUrl) {
        throw new ProviderApiError(`Không kết nối được DeepL tại ${endpoint}: ${error.message}`);
      }
      continue;
    }

    if (response.ok) return { baseUrl: endpoint, response };
    const body = await response.text().catch(() => "");
    attempts.push({ endpoint, status: response.status, body: body.slice(0, 300) });
    if (![401, 403].includes(response.status) || customUrl) {
      throw deepLError(response.status, endpoint, attempts);
    }
  }

  throw new ProviderApiError(
    "DeepL từ chối API key ở cả endpoint Free và Pro. Hãy dùng Authentication Key trong mục DeepL API Keys, không dùng mật khẩu hoặc token của ứng dụng DeepL.",
    { provider: "deepl", attempts },
  );
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function deepLError(status, endpoint, attempts) {
  const authenticationFailure = [401, 403].includes(status);
  const message = authenticationFailure
    ? `DeepL từ chối API key tại ${endpoint}. Kiểm tra key và endpoint Free/Pro.`
    : `DeepL trả về HTTP ${status} tại ${endpoint}.`;
  return new ProviderApiError(message, {
    provider: "deepl",
    upstreamStatus: status,
    attempts,
  });
}
