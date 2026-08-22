use std::sync::{
    Arc, LazyLock,
    atomic::{AtomicU64, Ordering},
};

use anyhow::{Context, Result, ensure};
use futures::TryStreamExt;
use reqwest::{StatusCode, header};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::broadcast,
    task::JoinSet,
};

use crate::network::{DownloadClient, download_client};

const EVENT_CAPACITY: usize = 256;
const MIN_PART_SIZE: u64 = 8 * 1024 * 1024;
const MAX_PART_SIZE: u64 = 64 * 1024 * 1024;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static EVENTS: LazyLock<broadcast::Sender<Event>> =
    LazyLock::new(|| broadcast::channel(EVENT_CAPACITY).0);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Event {
    Started {
        id: u64,
        name: String,
    },
    Progress {
        id: u64,
        name: String,
        completed: u64,
        total: u64,
    },
    Finished {
        id: u64,
    },
    Failed {
        id: u64,
        name: String,
        error: String,
    },
}

#[must_use]
pub fn subscribe() -> broadcast::Receiver<Event> {
    EVENTS.subscribe()
}

pub(crate) struct Transfer {
    client: DownloadClient,
}

impl Transfer {
    pub(crate) fn new() -> Result<Self> {
        Ok(Self {
            client: download_client()?,
        })
    }

    pub(crate) fn get(&self, url: &str) -> reqwest_middleware::RequestBuilder {
        self.client.get(url)
    }

    pub(crate) async fn fetch(&self, url: &str, destination: &std::path::Path) -> Result<()> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let name = display_name(url);
        publish(Event::Started {
            id,
            name: name.clone(),
        });

        let result = self.fetch_inner(id, &name, url, destination).await;
        match result {
            Ok(()) => {
                publish(Event::Finished { id });
                Ok(())
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(destination).await;
                publish(Event::Failed {
                    id,
                    name,
                    error: error.to_string(),
                });
                Err(error)
            }
        }
    }

    async fn fetch_inner(
        &self,
        id: u64,
        name: &str,
        url: &str,
        destination: &std::path::Path,
    ) -> Result<()> {
        let probe = self
            .client
            .head(url)
            .header(header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .with_context(|| format!("failed to inspect {url}"))?
            .error_for_status()
            .with_context(|| format!("failed to inspect {url}"))?;
        let total = probe.content_length();
        let ranged = probe
            .headers()
            .get(header::ACCEPT_RANGES)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("bytes"));

        if let Some(total) = total
            && total > 0
            && ranged
        {
            self.fetch_parts(id, name, url, destination, total).await
        } else if let Some(total) = self.probe_range_total(url).await? {
            self.fetch_parts(id, name, url, destination, total).await
        } else {
            self.fetch_stream(id, name, url, destination, total).await
        }
    }

    async fn probe_range_total(&self, url: &str) -> Result<Option<u64>> {
        let response = self
            .client
            .get(url)
            .header(header::RANGE, "bytes=0-0")
            .header(header::ACCEPT_ENCODING, "identity")
            .send()
            .await?;
        if response.status() != StatusCode::PARTIAL_CONTENT {
            return Ok(None);
        }
        let Some(content_range) = response.headers().get(header::CONTENT_RANGE) else {
            return Ok(None);
        };
        Ok(content_range
            .to_str()
            .ok()
            .and_then(total_from_probe_content_range))
    }

    async fn fetch_stream(
        &self,
        id: u64,
        name: &str,
        url: &str,
        destination: &std::path::Path,
        total: Option<u64>,
    ) -> Result<()> {
        let response = self
            .client
            .get(url)
            .header(header::ACCEPT_ENCODING, "identity")
            .send()
            .await?
            .error_for_status()?;
        let total = total.or(response.content_length()).unwrap_or(0);
        let mut file = tokio::fs::File::create(destination).await?;
        let mut completed = 0;
        let mut body = response.bytes_stream();
        loop {
            match body.try_next().await {
                Ok(Some(bytes)) => {
                    file.write_all(&bytes).await?;
                    completed += bytes.len() as u64;
                    publish(Event::Progress {
                        id,
                        name: name.to_owned(),
                        completed,
                        total,
                    });
                    ensure!(
                        total == 0 || completed <= total,
                        "{url} returned more than the declared {total} bytes"
                    );
                    if stream_is_complete(completed, total) {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) if stream_is_complete(completed, total) => {
                    tracing::warn!(
                        %error,
                        completed,
                        total,
                        "download stream closed with an error after all declared bytes arrived"
                    );
                    break;
                }
                Err(error) => return Err(error.into()),
            }
        }
        file.flush().await?;
        if total > 0 {
            ensure!(
                completed == total,
                "{url} ended after {completed} of {total} bytes"
            );
        }
        Ok(())
    }

    async fn fetch_parts(
        &self,
        id: u64,
        name: &str,
        url: &str,
        destination: &std::path::Path,
        total: u64,
    ) -> Result<()> {
        tokio::fs::File::create(destination)
            .await?
            .set_len(total)
            .await?;

        let concurrency = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(8)
            .clamp(4, 32);
        let part_size = total
            .div_ceil((concurrency * 4) as u64)
            .clamp(MIN_PART_SIZE, MAX_PART_SIZE);
        let completed = Arc::new(AtomicU64::new(0));
        let mut tasks = JoinSet::new();

        for start in (0..total).step_by(part_size as usize) {
            while tasks.len() >= concurrency {
                let task = tasks
                    .join_next()
                    .await
                    .context("download task disappeared")?;
                task.context("download task failed")??;
            }
            let end = (start + part_size).min(total) - 1;
            tasks.spawn(fetch_part(
                self.client.clone(),
                url.to_owned(),
                destination.to_owned(),
                start,
                end,
                total,
                completed.clone(),
                id,
                name.to_owned(),
            ));
        }
        while let Some(result) = tasks.join_next().await {
            result.context("download task failed")??;
        }
        ensure!(
            completed.load(Ordering::Relaxed) == total,
            "{url} download was incomplete"
        );
        Ok(())
    }
}

fn stream_is_complete(completed: u64, total: u64) -> bool {
    total > 0 && completed == total
}

fn total_from_probe_content_range(value: &str) -> Option<u64> {
    value
        .strip_prefix("bytes 0-0/")?
        .parse::<u64>()
        .ok()
        .filter(|total| *total > 0)
}

#[allow(clippy::too_many_arguments)]
async fn fetch_part(
    client: DownloadClient,
    url: String,
    destination: std::path::PathBuf,
    start: u64,
    end: u64,
    total: u64,
    completed: Arc<AtomicU64>,
    id: u64,
    name: String,
) -> Result<()> {
    let response = client
        .get(&url)
        .header(header::RANGE, format!("bytes={start}-{end}"))
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await?;
    ensure!(
        response.status() == StatusCode::PARTIAL_CONTENT,
        "{url} did not honor byte range {start}-{end}"
    );
    let actual_range = response
        .headers()
        .get(header::CONTENT_RANGE)
        .context("partial response omitted Content-Range")?
        .to_str()?;
    let expected_range = format!("bytes {start}-{end}/{total}");
    ensure!(
        actual_range == expected_range,
        "{url} returned Content-Range {actual_range}, expected {expected_range}"
    );
    let expected = end - start + 1;
    let bytes = response.bytes().await?;
    ensure!(
        bytes.len() as u64 == expected,
        "{url} returned {} bytes for a {expected}-byte range",
        bytes.len()
    );

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(destination)
        .await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    file.write_all(&bytes).await?;
    file.flush().await?;
    let completed = completed.fetch_add(expected, Ordering::Relaxed) + expected;
    publish(Event::Progress {
        id,
        name,
        completed,
        total,
    });
    Ok(())
}

fn publish(event: Event) {
    let _ = EVENTS.send(event);
}

fn display_name(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back())
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "download".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_downloads_from_the_url_path() {
        assert_eq!(
            display_name("https://example.test/a/model.bin?q=1"),
            "model.bin"
        );
        assert_eq!(display_name("https://example.test/"), "download");
    }

    #[test]
    fn subscribers_observe_events() {
        let mut receiver = subscribe();
        let event = Event::Finished { id: 42 };
        publish(event.clone());
        assert_eq!(receiver.try_recv().unwrap(), event);
    }

    #[test]
    fn terminal_stream_error_is_accepted_only_after_all_bytes_arrive() {
        assert!(stream_is_complete(529_101_504, 529_101_504));
        assert!(!stream_is_complete(529_101_503, 529_101_504));
        assert!(!stream_is_complete(0, 0));
    }

    #[test]
    fn parses_total_size_from_range_probe() {
        assert_eq!(
            total_from_probe_content_range("bytes 0-0/529101504"),
            Some(529_101_504)
        );
        assert_eq!(total_from_probe_content_range("bytes 1-1/10"), None);
        assert_eq!(total_from_probe_content_range("bytes 0-0/*"), None);
    }
}
