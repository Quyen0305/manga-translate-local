export function profileKey(provider, model) {
  return `${String(provider || "").trim()}::${String(model || "").trim()}`;
}

export function profileFor(profiles, provider, model) {
  const profile = profiles?.[profileKey(provider, model)];
  return profile && typeof profile === "object"
    ? { apiKey: String(profile.apiKey || ""), baseUrl: String(profile.baseUrl || "") }
    : { apiKey: "", baseUrl: "" };
}

export function saveProfile(profiles, provider, model, credentials) {
  const key = profileKey(provider, model);
  if (!provider || !model) return { ...(profiles || {}) };
  return {
    ...(profiles || {}),
    [key]: {
      apiKey: String(credentials.apiKey || "").trim(),
      baseUrl: String(credentials.baseUrl || "").trim().replace(/\/+$/, ""),
    },
  };
}

export function migrateLegacyProfile(settings) {
  const profiles = { ...(settings.apiProfiles || {}) };
  const key = profileKey(settings.provider, settings.model);
  if (settings.provider && settings.model && !profiles[key] && (settings.apiKey || settings.baseUrl)) {
    return saveProfile(profiles, settings.provider, settings.model, settings);
  }
  return profiles;
}
