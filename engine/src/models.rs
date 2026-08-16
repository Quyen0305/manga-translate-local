use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::Serialize;
use serde_json::Value;

use crate::error::AppError;

const DEEPL_FREE_URL: &str = "https://api-free.deepl.com";
const DEEPL_PRO_URL: &str = "https://api.deepl.com";
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct ModelRequest {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
}

pub struct ModelDiscovery {
    client: reqwest::Client,
    cache: Mutex<HashMap<u64, (Instant, Vec<ModelInfo>)>>,
}

impl ModelDiscovery {
    pub fn new() -> Result<Self, anyhow::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()?,
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub async fn list(&self, request: ModelRequest) -> Result<Vec<ModelInfo>, AppError> {
        validate(&request)?;
        let key = fingerprint(&request);
        if let Some(models) = self.cache.lock().ok().and_then(|cache| {
            cache
                .get(&key)
                .filter(|(expires, _)| *expires > Instant::now())
                .map(|(_, models)| models.clone())
        }) {
            return Ok(models);
        }

        let mut models = match request.provider.as_str() {
            "gemini" => self.list_gemini(&request.api_key).await?,
            "openai" => {
                self.list_open_ai("https://api.openai.com/v1", &request.api_key, "openai")
                    .await?
            }
            "deepseek" => {
                self.list_open_ai("https://api.deepseek.com", &request.api_key, "deepseek")
                    .await?
            }
            "openai-compatible" => {
                self.list_open_ai(&request.base_url, &request.api_key, "openai-compatible")
                    .await?
            }
            "claude" => self.list_claude(&request.api_key).await?,
            "deepl" => {
                self.resolve_deepl(&request.api_key, &request.base_url)
                    .await?;
                vec![ModelInfo {
                    id: "mt".into(),
                    name: "DeepL Machine Translation".into(),
                }]
            }
            _ => {
                return Err(AppError::validation(
                    "Provider does not support model discovery",
                ));
            }
        };

        let mut seen = HashSet::new();
        models.retain(|model| !model.id.is_empty() && seen.insert(model.id.clone()));
        models.sort_by(|a, b| {
            model_rank(&a.id)
                .cmp(&model_rank(&b.id))
                .then_with(|| b.id.cmp(&a.id))
        });
        if models.is_empty() {
            return Err(AppError::provider(
                "The API returned no compatible text translation models",
            ));
        }
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(key, (Instant::now() + CACHE_TTL, models.clone()));
        }
        Ok(models)
    }

    pub async fn resolve_deepl(&self, api_key: &str, base_url: &str) -> Result<String, AppError> {
        let custom = base_url.trim().trim_end_matches('/');
        let preferred = if api_key.trim().ends_with(":fx") {
            DEEPL_FREE_URL
        } else {
            DEEPL_PRO_URL
        };
        let alternate = if preferred == DEEPL_FREE_URL {
            DEEPL_PRO_URL
        } else {
            DEEPL_FREE_URL
        };
        let candidates: Vec<&str> = if custom.is_empty() {
            vec![preferred, alternate]
        } else {
            vec![custom]
        };

        for endpoint in candidates {
            let response = self
                .client
                .get(format!("{endpoint}/v2/usage"))
                .header(AUTHORIZATION, format!("DeepL-Auth-Key {api_key}"))
                .send()
                .await
                .map_err(|error| {
                    AppError::provider(format!("Could not connect to DeepL at {endpoint}: {error}"))
                })?;
            if response.status().is_success() {
                return Ok(endpoint.to_string());
            }
            let status = response.status();
            if !matches!(status.as_u16(), 401 | 403) || !custom.is_empty() {
                return Err(AppError::provider(format!(
                    "DeepL returned HTTP {} at {endpoint}",
                    status.as_u16()
                )));
            }
        }
        Err(AppError::provider(
            "DeepL rejected the API key on both Free and Pro endpoints. Use an Authentication Key from DeepL API Keys.",
        ))
    }

    async fn list_gemini(&self, api_key: &str) -> Result<Vec<ModelInfo>, AppError> {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key={}",
            urlencoding::encode(api_key)
        );
        let value = self.fetch_json(&url, HeaderMap::new(), "gemini").await?;
        Ok(value["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|model| {
                model["supportedGenerationMethods"]
                    .as_array()
                    .is_some_and(|methods| methods.iter().any(|method| method == "generateContent"))
            })
            .filter_map(|model| {
                let id = model["name"]
                    .as_str()?
                    .trim_start_matches("models/")
                    .to_string();
                (id.starts_with("gemini-") && is_text_model(&id)).then(|| ModelInfo {
                    name: model["displayName"].as_str().unwrap_or(&id).to_string(),
                    id,
                })
            })
            .collect())
    }

    async fn list_open_ai(
        &self,
        base_url: &str,
        api_key: &str,
        provider: &str,
    ) -> Result<Vec<ModelInfo>, AppError> {
        let mut headers = HeaderMap::new();
        if !api_key.is_empty() {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
                    AppError::validation("API key contains invalid header characters")
                })?,
            );
        }
        let value = self
            .fetch_json(
                &format!("{}/models", base_url.trim_end_matches('/')),
                headers,
                provider,
            )
            .await?;
        Ok(value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| model["id"].as_str())
            .filter(|id| provider != "openai" || is_openai_text_model(id))
            .map(|id| ModelInfo {
                id: id.to_string(),
                name: id.to_string(),
            })
            .collect())
    }

    async fn list_claude(&self, api_key: &str) -> Result<Vec<ModelInfo>, AppError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(api_key)
                .map_err(|_| AppError::validation("API key contains invalid header characters"))?,
        );
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        let value = self
            .fetch_json(
                "https://api.anthropic.com/v1/models?limit=1000",
                headers,
                "claude",
            )
            .await?;
        Ok(value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model["id"].as_str()?.to_string();
                Some(ModelInfo {
                    name: model["display_name"].as_str().unwrap_or(&id).to_string(),
                    id,
                })
            })
            .collect())
    }

    async fn fetch_json(
        &self,
        url: &str,
        headers: HeaderMap,
        provider: &str,
    ) -> Result<Value, AppError> {
        let response = self
            .client
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|error| {
                AppError::provider(format!("Could not connect to {provider} API: {error}"))
            })?;
        let status = response.status();
        if !status.is_success() {
            let message = if matches!(status.as_u16(), 401 | 403) {
                format!("The {provider} API key is invalid or lacks access")
            } else {
                format!("The {provider} API returned HTTP {}", status.as_u16())
            };
            return Err(AppError::provider(message));
        }
        response
            .json()
            .await
            .map_err(|error| AppError::provider(format!("Invalid JSON from {provider}: {error}")))
    }
}

fn validate(request: &ModelRequest) -> Result<(), AppError> {
    if ![
        "gemini",
        "openai",
        "deepseek",
        "claude",
        "deepl",
        "openai-compatible",
    ]
    .contains(&request.provider.as_str())
    {
        return Err(AppError::validation(
            "Provider does not support model discovery",
        ));
    }
    if request.provider != "openai-compatible" && request.api_key.trim().is_empty() {
        return Err(AppError::validation(
            "Enter an API key before loading models",
        ));
    }
    if request.provider == "openai-compatible" && request.base_url.trim().is_empty() {
        return Err(AppError::validation(
            "OpenAI-compatible requires a Base URL",
        ));
    }
    Ok(())
}

fn fingerprint(request: &ModelRequest) -> u64 {
    let mut hasher = DefaultHasher::new();
    request.provider.hash(&mut hasher);
    request.base_url.hash(&mut hasher);
    request.api_key.hash(&mut hasher);
    hasher.finish()
}

fn model_rank(id: &str) -> u8 {
    let id = id.to_ascii_lowercase();
    if ["flash-lite", "mini", "nano", "haiku"]
        .iter()
        .any(|needle| id.contains(needle))
    {
        0
    } else if ["flash", "sonnet", "chat"]
        .iter()
        .any(|needle| id.contains(needle))
    {
        1
    } else {
        2
    }
}

fn is_text_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    ![
        "embedding",
        "image",
        "imagen",
        "tts",
        "audio",
        "live",
        "robotics",
        "aqa",
    ]
    .iter()
    .any(|needle| id.contains(needle))
}

fn is_openai_text_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let prefix = id.starts_with("gpt-")
        || id.starts_with("chatgpt-")
        || (id.starts_with('o')
            && id
                .as_bytes()
                .get(1)
                .is_some_and(|value| value.is_ascii_digit()));
    prefix
        && ![
            "audio", "realtime", "transcri", "tts", "image", "search", "computer",
        ]
        .iter()
        .any(|needle| id.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_filters_match_text_contract() {
        assert!(is_text_model("gemini-3.5-flash-lite"));
        assert!(!is_text_model("gemini-embedding-001"));
        assert!(is_openai_text_model("gpt-5-mini"));
        assert!(!is_openai_text_model("gpt-image-1"));
    }
}
