use std::collections::{BTreeMap, VecDeque};
use std::io::Cursor;

use anyhow::{Context, Result, bail};
use image::{DynamicImage, ImageFormat};
use koharu_rasterizer::{RasterOptions, Rasterizer};
use koharu_renderer::Renderer;
use koharu_scene::{
    Authored, EntityId, FontStyle, Geometry, Origin, Session, Snapshot, TextAlignment, Translation,
    Typography, WritingMode,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_EDIT_SESSIONS: usize = 12;
const LINE_HEIGHT_EXTENSION: &str = "app.manga-translate.line-height";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorRequest {
    pub segment_id: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub style: Option<EditorStyle>,
    #[serde(default)]
    pub reset_to_api: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorStyle {
    pub font_family: String,
    pub font_size: Option<f32>,
    pub auto_fit: bool,
    pub font_weight: u16,
    pub italic: bool,
    pub alignment: String,
    pub line_height: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorScene {
    pub session_id: String,
    pub width: u32,
    pub height: u32,
    pub segments: Vec<EditorSegment>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSegment {
    pub id: String,
    pub source_text: String,
    pub text: String,
    pub api_text: String,
    pub bounds: EditorBounds,
    pub style: EditorStyle,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

struct SegmentState {
    layer: EntityId,
    content: EntityId,
    source_text: String,
    api_translation: Translation,
    api_typography: Option<Typography>,
    bounds: EditorBounds,
}

pub struct EditorSession {
    session: Session,
    page: EntityId,
    width: u32,
    height: u32,
    segments: BTreeMap<String, SegmentState>,
    translation_instructions: Option<String>,
}

#[derive(Default)]
pub struct EditorStore {
    sessions: BTreeMap<String, EditorSession>,
    order: VecDeque<String>,
}

impl EditorSession {
    pub fn new(
        session: Session,
        page: EntityId,
        width: u32,
        height: u32,
        translation_instructions: Option<String>,
    ) -> Result<Self> {
        let snapshot = session.snapshot();
        let group = snapshot
            .page(page)
            .context("read translated page")?
            .text_group()
            .context("read translated text group")?
            .context("translated page has no editable text group")?;
        let mut segments = BTreeMap::new();
        for layer in group.text_layers().context("read translated text layers")? {
            let content = layer.content().context("read editable text content")?;
            let Some(source) = content.source().context("read editable source text")? else {
                continue;
            };
            let Some(translation) = content.translation().context("read editable translation")?
            else {
                continue;
            };
            let Some(geometry) = layer.frame().context("read editable text bounds")? else {
                continue;
            };
            let Some(bounds) = geometry_bounds(&geometry) else {
                continue;
            };
            let id = format!("S{}", segments.len() + 1);
            segments.insert(
                id,
                SegmentState {
                    layer: layer.id(),
                    content: content.id(),
                    source_text: source.text.value,
                    api_translation: translation,
                    api_typography: layer.typography().context("read editable typography")?,
                    bounds,
                },
            );
        }
        if segments.is_empty() {
            bail!("translated page contains no editable text segments");
        }
        drop(snapshot);
        Ok(Self {
            session,
            page,
            width,
            height,
            segments,
            translation_instructions,
        })
    }

    pub fn translation_instructions(&self) -> Option<&str> {
        self.translation_instructions.as_deref()
    }

    pub fn source_text(&self, segment_id: &str) -> Result<String> {
        self.segments
            .get(segment_id)
            .map(|segment| segment.source_text.clone())
            .with_context(|| format!("unknown editor segment {segment_id}"))
    }

    pub async fn apply(&mut self, request: &EditorRequest) -> Result<()> {
        validate_request(request)?;
        let segment = self
            .segments
            .get(&request.segment_id)
            .with_context(|| format!("unknown editor segment {}", request.segment_id))?;
        let snapshot = self.session.snapshot();
        let current_translation = snapshot
            .component::<Translation>(segment.content)?
            .context("editable segment lost its translation")?;
        let current_typography = snapshot.component::<Typography>(segment.layer)?;
        let patch = snapshot.patch(|edit| {
            if request.reset_to_api {
                edit.set(segment.content, &segment.api_translation)?;
                if let Some(typography) = &segment.api_typography {
                    edit.set(segment.layer, typography)?;
                } else if current_typography.is_some() {
                    edit.remove::<Typography>(segment.layer)?;
                }
                return Ok(());
            }
            if let Some(text) = &request.text {
                edit.set(
                    segment.content,
                    &Translation {
                        text: Authored::user(text.clone()),
                        language: current_translation.language.clone(),
                    },
                )?;
            }
            if let Some(style) = &request.style {
                edit.set(
                    segment.layer,
                    &typography_from_style(style, current_typography.clone()),
                )?;
            } else if request.text.is_some() {
                let mut typography = current_typography
                    .clone()
                    .unwrap_or_else(default_typography);
                typography.origin = Origin::User;
                typography.writing_mode = Some(WritingMode::Horizontal);
                edit.set(segment.layer, &typography)?;
            }
            Ok(())
        })?;
        self.session.commit(patch).await?;
        Ok(())
    }

    pub async fn set_retranslation(&mut self, segment_id: &str, text: String) -> Result<()> {
        self.apply(&EditorRequest {
            segment_id: segment_id.to_owned(),
            text: Some(text),
            style: None,
            reset_to_api: false,
        })
        .await
    }

    pub async fn render(&self, renderer: &Renderer, rasterizer: &Rasterizer) -> Result<Vec<u8>> {
        render_snapshot(renderer, rasterizer, &self.session.snapshot(), self.page).await
    }

    pub fn scene(&self, session_id: &str) -> Result<EditorScene> {
        let snapshot = self.session.snapshot();
        let mut segments = Vec::with_capacity(self.segments.len());
        for (id, state) in &self.segments {
            let translation = snapshot
                .component::<Translation>(state.content)?
                .context("editable segment lost its translation")?;
            let typography = snapshot.component::<Typography>(state.layer)?;
            segments.push(EditorSegment {
                id: id.clone(),
                source_text: state.source_text.clone(),
                text: translation.text.value,
                api_text: state.api_translation.text.value.clone(),
                bounds: state.bounds,
                style: style_from_typography(typography.as_ref()),
            });
        }
        Ok(EditorScene {
            session_id: session_id.to_owned(),
            width: self.width,
            height: self.height,
            segments,
        })
    }
}

impl EditorStore {
    pub fn insert(&mut self, session: EditorSession) -> Result<EditorScene> {
        while self.order.len() >= MAX_EDIT_SESSIONS {
            if let Some(expired) = self.order.pop_front() {
                self.sessions.remove(&expired);
            }
        }
        let id = Uuid::new_v4().to_string();
        let scene = session.scene(&id)?;
        self.sessions.insert(id.clone(), session);
        self.order.push_back(id);
        Ok(scene)
    }

    pub fn take(&mut self, id: &str) -> Option<EditorSession> {
        self.order.retain(|current| current != id);
        self.sessions.remove(id)
    }

    pub fn put_back(&mut self, id: String, session: EditorSession) {
        self.sessions.insert(id.clone(), session);
        self.order.push_back(id);
    }

    pub fn scene(&mut self, id: &str) -> Result<Option<EditorScene>> {
        let scene = self
            .sessions
            .get(id)
            .map(|session| session.scene(id))
            .transpose()?;
        if scene.is_some() {
            self.order.retain(|current| current != id);
            self.order.push_back(id.to_owned());
        }
        Ok(scene)
    }

    pub fn clear(&mut self) {
        self.sessions.clear();
        self.order.clear();
    }
}

pub async fn render_snapshot(
    renderer: &Renderer,
    rasterizer: &Rasterizer,
    snapshot: &Snapshot,
    page: EntityId,
) -> Result<Vec<u8>> {
    let frame = renderer
        .render(snapshot, page)
        .await
        .context("render translated scene")?;
    let raster = rasterizer
        .rasterize(&frame.raster_frame()?, RasterOptions::default())
        .context("rasterize translated scene")?;
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(raster.image)
        .write_to(&mut output, ImageFormat::Png)
        .context("encode translated PNG")?;
    Ok(output.into_inner())
}

fn validate_request(request: &EditorRequest) -> Result<()> {
    if request.segment_id.is_empty() || request.segment_id.len() > 64 {
        bail!("editor segment ID is invalid");
    }
    if let Some(text) = &request.text
        && (text.len() > 64 * 1024 || text.contains('\0'))
    {
        bail!("edited translation is too large or contains NUL");
    }
    if let Some(style) = &request.style {
        if style.font_family.len() > 256
            || style.font_family.contains('\0')
            || style
                .font_size
                .is_some_and(|size| !size.is_finite() || !(6.0..=256.0).contains(&size))
            || !(100..=900).contains(&style.font_weight)
            || !style.line_height.is_finite()
            || !(0.8..=3.0).contains(&style.line_height)
            || !["auto", "start", "center", "end", "justify"].contains(&style.alignment.as_str())
        {
            bail!("editor typography is invalid");
        }
    }
    if !request.reset_to_api && request.text.is_none() && request.style.is_none() {
        bail!("editor request contains no changes");
    }
    Ok(())
}

fn typography_from_style(style: &EditorStyle, current: Option<Typography>) -> Typography {
    let mut typography = current.unwrap_or_else(default_typography);
    typography.origin = Origin::User;
    typography.preferred_font =
        (!style.font_family.trim().is_empty()).then(|| style.font_family.trim().to_owned());
    typography.size = if style.auto_fit {
        None
    } else {
        style.font_size
    };
    typography.auto_fit = style.auto_fit;
    typography.font_weight = Some(style.font_weight);
    typography.font_style = Some(if style.italic {
        FontStyle::Italic
    } else {
        FontStyle::Normal
    });
    typography.alignment = match style.alignment.as_str() {
        "start" => Some(TextAlignment::Start),
        "center" => Some(TextAlignment::Center),
        "end" => Some(TextAlignment::End),
        "justify" => Some(TextAlignment::Justify),
        _ => None,
    };
    typography.writing_mode = Some(WritingMode::Horizontal);
    typography.extensions.insert(
        LINE_HEIGHT_EXTENSION.to_owned(),
        style.line_height.to_string(),
    );
    typography
}

fn style_from_typography(typography: Option<&Typography>) -> EditorStyle {
    EditorStyle {
        font_family: typography
            .and_then(|value| value.preferred_font.clone())
            .unwrap_or_default(),
        font_size: typography.and_then(|value| value.size),
        auto_fit: typography.is_none_or(|value| value.auto_fit),
        font_weight: typography
            .and_then(|value| value.font_weight)
            .unwrap_or(400),
        italic: typography
            .and_then(|value| value.font_style)
            .is_some_and(|style| style != FontStyle::Normal),
        alignment: match typography.and_then(|value| value.alignment) {
            Some(TextAlignment::Start) => "start",
            Some(TextAlignment::Center) => "center",
            Some(TextAlignment::End) => "end",
            Some(TextAlignment::Justify) => "justify",
            None => "auto",
        }
        .to_owned(),
        line_height: typography
            .and_then(|value| value.extensions.get(LINE_HEIGHT_EXTENSION))
            .and_then(|value| value.parse().ok())
            .filter(|value: &f32| value.is_finite() && (0.8..=3.0).contains(value))
            .unwrap_or(1.2),
    }
}

fn default_typography() -> Typography {
    Typography {
        origin: Origin::User,
        preferred_font: None,
        font_weight: None,
        font_style: None,
        size: None,
        auto_fit: true,
        color: None,
        stroke_color: None,
        stroke_width: None,
        alignment: None,
        writing_mode: None,
        extensions: BTreeMap::new(),
    }
}

fn geometry_bounds(geometry: &Geometry) -> Option<EditorBounds> {
    let min_x = geometry
        .points
        .iter()
        .map(|point| point.x)
        .reduce(f64::min)?;
    let min_y = geometry
        .points
        .iter()
        .map(|point| point.y)
        .reduce(f64::min)?;
    let max_x = geometry
        .points
        .iter()
        .map(|point| point.x)
        .reduce(f64::max)?;
    let max_y = geometry
        .points
        .iter()
        .map(|point| point.y)
        .reduce(f64::max)?;
    (max_x > min_x && max_y > min_y).then_some(EditorBounds {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use koharu_scene::{At, PageDraft, SourceText, TextLayout, TextLayoutKind};

    #[test]
    fn rejects_unsafe_typography() {
        let request = EditorRequest {
            segment_id: "S1".into(),
            text: Some("Xin chao".into()),
            style: Some(EditorStyle {
                font_family: "Arial".into(),
                font_size: Some(500.0),
                auto_fit: false,
                font_weight: 400,
                italic: false,
                alignment: "center".into(),
                line_height: 1.2,
            }),
            reset_to_api: false,
        };
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn line_height_round_trips_through_typography_extension() {
        let style = EditorStyle {
            font_family: "Arial".into(),
            font_size: Some(24.0),
            auto_fit: false,
            font_weight: 700,
            italic: true,
            alignment: "center".into(),
            line_height: 1.55,
        };
        let typography = typography_from_style(&style, None);
        assert_eq!(style_from_typography(Some(&typography)).line_height, 1.55);
    }

    #[tokio::test]
    async fn edits_and_resets_one_scene_segment_without_pipeline() {
        let mut session = Session::memory().await.unwrap();
        let mut ids = None;
        let patch = session
            .snapshot()
            .patch(|edit| {
                let page = edit.add_page(PageDraft::new("page", 400.0, 600.0), At::End)?;
                let content = edit.add_text_content(page, At::End)?;
                edit.set(
                    content,
                    &SourceText {
                        text: Authored::user("HELLO".into()),
                        language: None,
                    },
                )?;
                edit.set(
                    content,
                    &Translation {
                        text: Authored::user("Xin chao".into()),
                        language: None,
                    },
                )?;
                let layer = edit.add_text_layer(
                    page,
                    At::End,
                    content,
                    &TextLayout {
                        origin: Origin::User,
                        kind: TextLayoutKind::Paragraph,
                    },
                )?;
                edit.set(layer, &Geometry::rectangle(20.0, 30.0, 160.0, 80.0))?;
                let mut typography = default_typography();
                typography.writing_mode = Some(WritingMode::Vertical);
                edit.set(layer, &typography)?;
                ids = Some(page);
                Ok(())
            })
            .unwrap();
        session.commit(patch).await.unwrap();
        let mut editor = EditorSession::new(session, ids.unwrap(), 400, 600, None).unwrap();
        editor
            .apply(&EditorRequest {
                segment_id: "S1".into(),
                text: Some("Chao ban".into()),
                style: Some(EditorStyle {
                    font_family: "Arial".into(),
                    font_size: Some(24.0),
                    auto_fit: false,
                    font_weight: 700,
                    italic: false,
                    alignment: "center".into(),
                    line_height: 1.4,
                }),
                reset_to_api: false,
            })
            .await
            .unwrap();
        let edited = editor.scene("session").unwrap();
        assert_eq!(edited.segments[0].text, "Chao ban");
        assert_eq!(edited.segments[0].style.font_size, Some(24.0));
        let edited_mode = editor
            .session
            .snapshot()
            .component::<Typography>(editor.segments["S1"].layer)
            .unwrap()
            .unwrap()
            .writing_mode;
        assert_eq!(edited_mode, Some(WritingMode::Horizontal));

        editor
            .apply(&EditorRequest {
                segment_id: "S1".into(),
                text: None,
                style: None,
                reset_to_api: true,
            })
            .await
            .unwrap();
        let reset = editor.scene("session").unwrap();
        assert_eq!(reset.segments[0].text, "Xin chao");
        assert!(reset.segments[0].style.auto_fit);
        let reset_mode = editor
            .session
            .snapshot()
            .component::<Typography>(editor.segments["S1"].layer)
            .unwrap()
            .unwrap()
            .writing_mode;
        assert_eq!(reset_mode, Some(WritingMode::Vertical));
    }
}
