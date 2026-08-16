import assert from "node:assert/strict";
import test from "node:test";
import { migrateLegacyProfile, profileFor, profileKey, saveProfile } from "../extension/profile-utils.js";

test("mỗi provider/model giữ API key riêng", () => {
  let profiles = {};
  profiles = saveProfile(profiles, "openai", "gpt-5-mini", { apiKey: "key-mini" });
  profiles = saveProfile(profiles, "openai", "gpt-4.1-mini", { apiKey: "key-41" });
  profiles = saveProfile(profiles, "deepl", "mt", {
    apiKey: "deepl-key:fx",
    baseUrl: "https://api-free.deepl.com/",
  });
  assert.equal(profileFor(profiles, "openai", "gpt-5-mini").apiKey, "key-mini");
  assert.equal(profileFor(profiles, "openai", "gpt-4.1-mini").apiKey, "key-41");
  assert.deepEqual(profileFor(profiles, "deepl", "mt"), {
    apiKey: "deepl-key:fx",
    baseUrl: "https://api-free.deepl.com",
  });
});

test("model chưa cấu hình không kế thừa nhầm API key", () => {
  const profiles = saveProfile({}, "gemini", "gemini-a", { apiKey: "key-a" });
  assert.deepEqual(profileFor(profiles, "gemini", "gemini-b"), { apiKey: "", baseUrl: "" });
});

test("cấu hình cũ được migrate vào đúng profile", () => {
  const profiles = migrateLegacyProfile({
    provider: "deepseek",
    model: "deepseek-chat",
    apiKey: "legacy-key",
    baseUrl: "",
    apiProfiles: {},
  });
  assert.equal(profiles[profileKey("deepseek", "deepseek-chat")].apiKey, "legacy-key");
});
