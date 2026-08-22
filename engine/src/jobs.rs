use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow};
use koharu_pipeline::{Progress, StopToken};
use serde::Serialize;

const MAX_RETAINED_JOBS: usize = 128;
const BASE_TOTAL_STAGES: u8 = 5;
const VISUAL_CONTEXT_TOTAL_STAGES: u8 = 6;

#[derive(Default)]
pub struct JobRegistry {
    entries: Mutex<HashMap<String, JobEntry>>,
}

struct JobEntry {
    status: JobStatus,
    stop: StopToken,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub job_id: String,
    pub state: String,
    pub stage: Option<String>,
    pub stage_state: Option<String>,
    pub model: Option<String>,
    pub completed_stages: Vec<String>,
    pub total_stages: u8,
    pub message: Option<String>,
    pub visual_context_state: Option<String>,
    pub visual_context_model: Option<String>,
    pub visual_context_cached: Option<bool>,
    pub visual_context_message: Option<String>,
    pub created_at_epoch_seconds: u64,
    pub updated_at_epoch_seconds: u64,
}

impl JobRegistry {
    pub fn create(&self, job_id: String, visual_context: bool) -> Result<StopToken> {
        let mut entries = self.lock()?;
        prune_jobs(&mut entries);
        let stop = StopToken::default();
        let now = epoch_seconds();
        entries.insert(
            job_id.clone(),
            JobEntry {
                status: JobStatus {
                    job_id,
                    state: "queued".into(),
                    stage: None,
                    stage_state: None,
                    model: None,
                    completed_stages: Vec::new(),
                    total_stages: if visual_context {
                        VISUAL_CONTEXT_TOTAL_STAGES
                    } else {
                        BASE_TOTAL_STAGES
                    },
                    message: None,
                    visual_context_state: visual_context.then(|| "queued".into()),
                    visual_context_model: visual_context
                        .then(|| crate::visual_context::MODEL_NAME.into()),
                    visual_context_cached: None,
                    visual_context_message: None,
                    created_at_epoch_seconds: now,
                    updated_at_epoch_seconds: now,
                },
                stop: stop.clone(),
            },
        );
        Ok(stop)
    }

    pub fn status(&self, job_id: &str) -> Option<JobStatus> {
        self.entries
            .lock()
            .ok()?
            .get(job_id)
            .map(|entry| entry.status.clone())
    }

    pub fn stop_token(&self, job_id: &str) -> Option<StopToken> {
        self.entries
            .lock()
            .ok()?
            .get(job_id)
            .map(|entry| entry.stop.clone())
    }

    pub fn is_cancelled(&self, job_id: &str) -> bool {
        self.stop_token(job_id).is_some_and(|stop| stop.stopped())
    }

    pub fn mark_running(&self, job_id: &str) {
        self.update(job_id, |status| {
            status.state = "running".into();
            status.message = None;
        });
    }

    pub fn mark_visual_context_loading(&self, job_id: &str) {
        self.update(job_id, |status| {
            status.state = "running".into();
            status.stage = Some("visual-context".into());
            status.stage_state = Some("loading".into());
            status.model = Some(crate::visual_context::MODEL_NAME.into());
            status.visual_context_state = Some("loading".into());
        });
    }

    pub fn mark_visual_context_completed(&self, job_id: &str, cached: bool) {
        self.update(job_id, |status| {
            status.stage = Some("visual-context".into());
            status.stage_state = Some("finished".into());
            status.model = Some(crate::visual_context::MODEL_NAME.into());
            status.visual_context_state = Some("completed".into());
            status.visual_context_cached = Some(cached);
            status.visual_context_message = None;
            push_completed(&mut status.completed_stages, "visual-context".into());
        });
    }

    pub fn mark_visual_context_fallback(&self, job_id: &str, message: impl Into<String>) {
        let message = message.into();
        self.update(job_id, |status| {
            status.stage = Some("visual-context".into());
            status.stage_state = Some("skipped".into());
            status.model = Some(crate::visual_context::MODEL_NAME.into());
            status.visual_context_state = Some("fallback".into());
            status.visual_context_cached = Some(false);
            status.visual_context_message = Some(message.chars().take(800).collect());
            push_completed(&mut status.completed_stages, "visual-context".into());
        });
    }

    pub fn progress(&self, job_id: &str, event: Progress) {
        self.update(job_id, |status| match event {
            Progress::Started { .. } => {
                status.state = "running".into();
                status.stage = Some("preparing".into());
                status.stage_state = Some("running".into());
            }
            Progress::Loading { stage, model, .. } => {
                status.state = "running".into();
                status.stage = Some(stage.to_string());
                status.stage_state = Some("loading".into());
                status.model = Some(model);
            }
            Progress::Running { stage, model, .. } => {
                status.state = "running".into();
                status.stage = Some(stage.to_string());
                status.stage_state = Some("running".into());
                status.model = Some(model);
            }
            Progress::Finished { stage, model, .. } => {
                let stage = stage.to_string();
                status.stage = Some(stage.clone());
                status.stage_state = Some("finished".into());
                status.model = Some(model);
                push_completed(&mut status.completed_stages, stage);
            }
            Progress::Skipped { stage, .. } => {
                let stage = stage.to_string();
                status.stage = Some(stage.clone());
                status.stage_state = Some("skipped".into());
                push_completed(&mut status.completed_stages, stage);
            }
        });
    }

    pub fn mark_rendering(&self, job_id: &str) {
        self.update(job_id, |status| {
            status.state = "running".into();
            status.stage = Some("rendering".into());
            status.stage_state = Some("running".into());
            status.model = None;
        });
    }

    pub fn complete(&self, job_id: &str) {
        self.update(job_id, |status| {
            push_completed(&mut status.completed_stages, "rendering".into());
            status.state = "completed".into();
            status.stage = Some("rendering".into());
            status.stage_state = Some("finished".into());
            status.model = None;
            status.message = None;
        });
    }

    pub fn fail(&self, job_id: &str, message: impl Into<String>) {
        let message = message.into();
        self.update(job_id, |status| {
            status.state = "failed".into();
            status.stage_state = Some("failed".into());
            status.message = Some(message.chars().take(800).collect());
        });
    }

    pub fn mark_cancelled(&self, job_id: &str) {
        self.update(job_id, |status| {
            status.state = "cancelled".into();
            status.stage_state = Some("cancelled".into());
            status.message = Some("Tác vụ đã bị hủy".into());
        });
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let Some(entry) = entries.get_mut(job_id) else {
            return false;
        };
        if matches!(
            entry.status.state.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            return false;
        }
        entry.stop.stop();
        entry.status.state = "cancelling".into();
        entry.status.stage_state = Some("cancelling".into());
        entry.status.message = Some("Đang dừng ở ranh giới pipeline an toàn".into());
        entry.status.updated_at_epoch_seconds = epoch_seconds();
        true
    }

    fn update(&self, job_id: &str, update: impl FnOnce(&mut JobStatus)) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let Some(entry) = entries.get_mut(job_id) else {
            return;
        };
        update(&mut entry.status);
        entry.status.updated_at_epoch_seconds = epoch_seconds();
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, JobEntry>>> {
        self.entries
            .lock()
            .map_err(|_| anyhow!("translation job registry lock poisoned"))
    }
}

fn push_completed(stages: &mut Vec<String>, stage: String) {
    if !stages.contains(&stage) {
        stages.push(stage);
    }
}

fn prune_jobs(entries: &mut HashMap<String, JobEntry>) {
    while entries.len() >= MAX_RETAINED_JOBS {
        let candidate = entries
            .iter()
            .filter(|(_, entry)| {
                matches!(
                    entry.status.state.as_str(),
                    "completed" | "failed" | "cancelled"
                )
            })
            .min_by_key(|(_, entry)| entry.status.updated_at_epoch_seconds)
            .or_else(|| {
                entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.status.created_at_epoch_seconds)
            })
            .map(|(job_id, _)| job_id.clone());
        let Some(job_id) = candidate else {
            break;
        };
        entries.remove(&job_id);
    }
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use koharu_pipeline::{Progress, Stage};
    use koharu_scene::EntityId;

    #[test]
    fn tracks_progress_and_cancellation_without_payload_data() {
        let registry = JobRegistry::default();
        let stop = registry.create("job-1".into(), false).expect("create job");
        registry.mark_running("job-1");
        registry.progress(
            "job-1",
            Progress::Running {
                page: EntityId::new(),
                stage: Stage::Ocr,
                model: "ocr-test".into(),
            },
        );
        let status = registry.status("job-1").expect("job status");
        assert_eq!(status.state, "running");
        assert_eq!(status.stage.as_deref(), Some("ocr"));
        assert_eq!(status.model.as_deref(), Some("ocr-test"));

        assert!(registry.cancel("job-1"));
        assert!(stop.stopped());
        assert_eq!(registry.status("job-1").unwrap().state, "cancelling");
        registry.mark_cancelled("job-1");
        assert_eq!(registry.status("job-1").unwrap().state, "cancelled");
    }

    #[test]
    fn visual_context_progress_records_cache_and_fallback_state() {
        let registry = JobRegistry::default();
        registry.create("context-ok".into(), true).unwrap();
        registry.mark_visual_context_loading("context-ok");
        registry.mark_visual_context_completed("context-ok", true);
        let completed = registry.status("context-ok").unwrap();
        assert_eq!(completed.total_stages, VISUAL_CONTEXT_TOTAL_STAGES);
        assert_eq!(completed.visual_context_state.as_deref(), Some("completed"));
        assert_eq!(completed.visual_context_cached, Some(true));

        registry.create("context-fallback".into(), true).unwrap();
        registry.mark_visual_context_fallback("context-fallback", "model unavailable");
        let fallback = registry.status("context-fallback").unwrap();
        assert_eq!(fallback.visual_context_state.as_deref(), Some("fallback"));
        assert_eq!(
            fallback.visual_context_message.as_deref(),
            Some("model unavailable")
        );
    }
}
