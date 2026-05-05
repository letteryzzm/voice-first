use eframe::egui::{self, Align2, Color32, FontId, Frame, RichText, Sense, Stroke, Vec2};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([760.0, 620.0])
            .with_min_inner_size([420.0, 360.0]),
        ..Default::default()
    };

    eframe::run_native(
        "Voice First Desktop",
        options,
        Box::new(|_cc| Box::<VoiceFirstApp>::default()),
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Role {
    User,
    Assistant,
    System,
}

impl Role {
    fn label(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
        }
    }

    fn accent(self) -> Color32 {
        match self {
            Role::User => Color32::from_rgb(64, 110, 255),
            Role::Assistant => Color32::from_rgb(28, 145, 105),
            Role::System => Color32::from_rgb(128, 128, 128),
        }
    }
}

#[derive(Debug)]
struct Message {
    role: Role,
    content: String,
}

impl Message {
    fn new(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VoiceState {
    Idle,
    Recording,
    Thinking,
    Speaking,
    Error,
}

impl VoiceState {
    fn from_engine(value: &str) -> Option<Self> {
        match value {
            "idle" => Some(Self::Idle),
            "recording" => Some(Self::Recording),
            "thinking" => Some(Self::Thinking),
            "speaking" => Some(Self::Speaking),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    fn button_label(self) -> &'static str {
        match self {
            VoiceState::Idle => "REC",
            VoiceState::Recording => "STOP",
            VoiceState::Thinking | VoiceState::Speaking => "INT",
            VoiceState::Error => "RESET",
        }
    }

    fn status(self) -> &'static str {
        match self {
            VoiceState::Idle => "Idle",
            VoiceState::Recording => "Recording",
            VoiceState::Thinking => "Thinking",
            VoiceState::Speaking => "Speaking",
            VoiceState::Error => "Error",
        }
    }

    fn fill(self) -> Color32 {
        match self {
            VoiceState::Idle => Color32::from_rgb(36, 120, 255),
            VoiceState::Recording => Color32::from_rgb(220, 58, 52),
            VoiceState::Thinking => Color32::from_rgb(238, 160, 48),
            VoiceState::Speaking => Color32::from_rgb(32, 163, 118),
            VoiceState::Error => Color32::from_rgb(130, 130, 130),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum EngineCommand {
    #[serde(rename = "start_recording")]
    StartRecording,
    #[serde(rename = "stop_recording")]
    StopRecording,
    #[serde(rename = "interrupt")]
    Interrupt,
    #[serde(rename = "send_text")]
    SendText { text: String },
    #[serde(rename = "shutdown")]
    Shutdown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum EngineEvent {
    #[serde(rename = "ready")]
    Ready { state: String },
    #[serde(rename = "state")]
    State { state: String },
    #[serde(rename = "user_text")]
    UserText { text: String },
    #[serde(rename = "assistant_text")]
    AssistantText { text: String },
    #[serde(rename = "assistant_delta")]
    AssistantDelta { delta: String },
    #[serde(rename = "tool_start")]
    ToolStart { name: String },
    #[serde(rename = "tool_end")]
    ToolEnd { name: String },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "done")]
    Done,
}

trait EngineClient {
    fn send_command(&mut self, command: EngineCommand) -> Result<(), String>;
    fn drain_events(&mut self) -> Vec<EngineEvent>;
}

struct JsonLinesEngineClient {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<EngineEvent>,
}

impl JsonLinesEngineClient {
    fn spawn() -> Result<Self, String> {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Could not resolve repository root".to_owned())?;

        let mut child = Command::new("npm")
            .args(["run", "--silent", "desktop:engine"])
            .current_dir(repo_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start TS engine: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "TS engine stdin unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "TS engine stdout unavailable".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "TS engine stderr unavailable".to_owned())?;

        let (tx, rx) = mpsc::channel();
        let out_tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<EngineEvent>(&line) {
                    Ok(event) => {
                        let _ = out_tx.send(event);
                    }
                    Err(error) => {
                        let _ = out_tx.send(EngineEvent::Error {
                            message: format!("Invalid engine event: {error}: {line}"),
                        });
                    }
                }
            }
        });

        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                if !line.trim().is_empty() {
                    let _ = tx.send(EngineEvent::Error { message: line });
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            events: rx,
        })
    }
}

impl EngineClient for JsonLinesEngineClient {
    fn send_command(&mut self, command: EngineCommand) -> Result<(), String> {
        let line = serde_json::to_string(&command).map_err(|error| error.to_string())?;
        writeln!(self.stdin, "{line}").map_err(|error| format!("Failed to write engine command: {error}"))?;
        self.stdin.flush().map_err(|error| format!("Failed to flush engine command: {error}"))
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        self.events.try_iter().collect()
    }
}

impl Drop for JsonLinesEngineClient {
    fn drop(&mut self) {
        let _ = self.send_command(EngineCommand::Shutdown);
        let _ = self.child.kill();
    }
}

struct DisconnectedEngineClient {
    pending: Vec<EngineEvent>,
}

impl DisconnectedEngineClient {
    fn new(message: String) -> Self {
        Self {
            pending: vec![EngineEvent::Error { message }],
        }
    }
}

impl EngineClient for DisconnectedEngineClient {
    fn send_command(&mut self, _command: EngineCommand) -> Result<(), String> {
        Err("TS engine is not connected".to_owned())
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        self.pending.drain(..).collect()
    }
}

struct VoiceFirstApp {
    messages: Vec<Message>,
    input: String,
    voice_state: VoiceState,
    engine: Box<dyn EngineClient>,
    partial_assistant: String,
}

impl Default for VoiceFirstApp {
    fn default() -> Self {
        let (engine, initial_message): (Box<dyn EngineClient>, String) = match JsonLinesEngineClient::spawn() {
            Ok(client) => (
                Box::new(client),
                "Connected to local TypeScript voice engine.".to_owned(),
            ),
            Err(error) => (
                Box::new(DisconnectedEngineClient::new(error.clone())),
                format!("Engine failed to start: {error}"),
            ),
        };

        Self {
            messages: vec![Message::new(Role::System, initial_message)],
            input: String::new(),
            voice_state: VoiceState::Idle,
            engine,
            partial_assistant: String::new(),
        }
    }
}

impl VoiceFirstApp {
    fn send_text(&mut self) {
        let text = self.input.trim().to_owned();
        if text.is_empty() {
            return;
        }
        self.input.clear();
        self.partial_assistant.clear();
        self.voice_state = VoiceState::Thinking;
        self.send_engine_command(EngineCommand::SendText { text });
    }

    fn handle_voice_button(&mut self) {
        match self.voice_state {
            VoiceState::Idle => {
                self.send_engine_command(EngineCommand::StartRecording);
            }
            VoiceState::Recording => {
                self.send_engine_command(EngineCommand::StopRecording);
            }
            VoiceState::Thinking | VoiceState::Speaking | VoiceState::Error => {
                self.send_engine_command(EngineCommand::Interrupt);
            }
        }
    }

    fn send_engine_command(&mut self, command: EngineCommand) {
        if let Err(error) = self.engine.send_command(command) {
            self.messages.push(Message::new(Role::System, format!("Engine error: {error}")));
            self.voice_state = VoiceState::Error;
        }
    }

    fn drain_engine_events(&mut self) {
        for event in self.engine.drain_events() {
            match event {
                EngineEvent::Ready { state } | EngineEvent::State { state } => {
                    if let Some(state) = VoiceState::from_engine(&state) {
                        self.voice_state = state;
                    }
                }
                EngineEvent::UserText { text } => {
                    self.messages.push(Message::new(Role::User, text));
                    self.partial_assistant.clear();
                }
                EngineEvent::AssistantDelta { delta } => {
                    self.partial_assistant.push_str(&delta);
                }
                EngineEvent::AssistantText { text } => {
                    self.partial_assistant.clear();
                    self.messages.push(Message::new(Role::Assistant, text));
                }
                EngineEvent::ToolStart { name } => {
                    self.messages.push(Message::new(Role::System, format!("tool start: {name}")));
                }
                EngineEvent::ToolEnd { name } => {
                    self.messages.push(Message::new(Role::System, format!("tool end: {name}")));
                }
                EngineEvent::Error { message } => {
                    self.voice_state = VoiceState::Error;
                    self.messages.push(Message::new(Role::System, format!("error: {message}")));
                }
                EngineEvent::Done => {}
            }
        }
    }

    fn show_message(ui: &mut egui::Ui, message: &Message) {
        let tint = message.role.accent();
        Frame::none()
            .fill(Color32::from_rgb(248, 248, 246))
            .stroke(Stroke::new(1.0, Color32::from_gray(225)))
            .rounding(egui::Rounding::same(10.0))
            .inner_margin(egui::Margin::symmetric(12.0, 8.0))
            .show(ui, |ui| {
                ui.label(RichText::new(message.role.label()).color(tint).strong());
                ui.add_space(3.0);
                ui.label(&message.content);
            });
    }

    fn show_round_button(ui: &mut egui::Ui, state: VoiceState) -> egui::Response {
        let size = Vec2::splat(50.0);
        let (rect, response) = ui.allocate_exact_size(size, Sense::click());

        if ui.is_rect_visible(rect) {
            let visuals = ui.style().interact(&response);
            let radius = rect.width().min(rect.height()) / 2.0;
            let fill = if response.hovered() {
                state.fill().linear_multiply(1.12)
            } else {
                state.fill()
            };

            ui.painter().circle_filled(rect.center(), radius, fill);
            ui.painter().circle_stroke(
                rect.center(),
                radius,
                Stroke::new(1.0, visuals.bg_stroke.color),
            );
            ui.painter().text(
                rect.center(),
                Align2::CENTER_CENTER,
                state.button_label(),
                FontId::proportional(12.0),
                Color32::WHITE,
            );
        }

        response
    }
}

impl eframe::App for VoiceFirstApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_engine_events();
        ctx.request_repaint_after(std::time::Duration::from_millis(80));

        egui::TopBottomPanel::top("top_bar").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("Voice First Desktop");
                ui.separator();
                ui.label(format!("State: {}", self.voice_state.status()));
            });
        });

        egui::TopBottomPanel::bottom("composer").show(ctx, |ui| {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                let edit_width = (ui.available_width() - 58.0).max(80.0);
                let input_response = ui.add_sized(
                    [edit_width, 42.0],
                    egui::TextEdit::singleline(&mut self.input)
                        .hint_text("Type a message, then press Enter"),
                );

                if Self::show_round_button(ui, self.voice_state).clicked() {
                    self.handle_voice_button();
                }

                if input_response.has_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                    self.send_text();
                }
            });
            ui.add_space(8.0);
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::vertical()
                .auto_shrink([false, false])
                .stick_to_bottom(true)
                .show(ui, |ui| {
                    for message in &self.messages {
                        Self::show_message(ui, message);
                        ui.add_space(8.0);
                    }
                    if !self.partial_assistant.is_empty() {
                        Self::show_message(
                            ui,
                            &Message::new(Role::Assistant, self.partial_assistant.clone()),
                        );
                    }
                });
        });
    }
}
