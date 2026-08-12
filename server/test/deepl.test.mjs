import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEPL_FREE_URL,
  DEEPL_PRO_URL,
  resolveDeepLEndpoint,
} from "../src/deepl/service.mjs";

test("DeepL tự thử endpoint Free khi endpoint Pro từ chối", async () => {
  const urls = [];
  const result = await resolveDeepLEndpoint({
    apiKey: "key-without-free-suffix",
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.startsWith(DEEPL_PRO_URL)) {
        return new Response('{"message":"Forbidden"}', { status: 403 });
      }
      return new Response('{"character_count":0}', { status: 200 });
    },
  });

  assert.equal(result.baseUrl, DEEPL_FREE_URL);
  assert.deepEqual(urls, [`${DEEPL_PRO_URL}/v2/usage`, `${DEEPL_FREE_URL}/v2/usage`]);
});

test("DeepL báo rõ khi cả endpoint Free và Pro đều từ chối key", async () => {
  await assert.rejects(
    () => resolveDeepLEndpoint({
      apiKey: "invalid-key",
      fetchImpl: async () => new Response('{"message":"Forbidden"}', { status: 403 }),
    }),
    /Authentication Key.*không dùng mật khẩu hoặc token/,
  );
});

test("DeepL tôn trọng Base URL tùy chỉnh và không tự đổi endpoint", async () => {
  const urls = [];
  await assert.rejects(
    () => resolveDeepLEndpoint({
      apiKey: "key:fx",
      baseUrl: "https://deepl-proxy.test/",
      fetchImpl: async (url) => {
        urls.push(url);
        return new Response("bad gateway", { status: 502 });
      },
    }),
    /HTTP 502.*deepl-proxy\.test/,
  );
  assert.deepEqual(urls, ["https://deepl-proxy.test/v2/usage"]);
});
