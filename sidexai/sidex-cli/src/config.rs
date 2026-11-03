use std::path::PathBuf;

pub struct Config {
    pub server_url: String,
    pub cwd: PathBuf,
}

impl Config {
    pub fn http_url(&self) -> String {
        self.server_url
            .replace("ws://", "http://")
            .replace("wss://", "https://")
    }

    pub fn ws_url(&self, path: &str) -> String {
        let base = if self.server_url.starts_with("http") {
            self.server_url
                .replace("http://", "ws://")
                .replace("https://", "wss://")
        } else {
            self.server_url.clone()
        };
        format!("{}{}", base, path)
    }
}
