use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Deserialize)]
struct ProxyArgs {
    url: String,
    body: String,
    authorization: Option<String>,
    x_api_key: Option<String>,
    anthropic_version: Option<String>,
}

#[tauri::command]
async fn proxy_call(args: ProxyArgs) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Client build failed: {}", e))?;
    let mut req = client
        .post(&args.url)
        .header("Content-Type", "application/json")
        .body(args.body);

    if let Some(auth) = args.authorization {
        req = req.header("Authorization", auth);
    }
    if let Some(key) = args.x_api_key {
        req = req.header("x-api-key", key);
    }
    if let Some(ver) = args.anthropic_version {
        req = req.header("anthropic-version", ver);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("API {}: {}", status.as_u16(), body));
    }

    Ok(body)
}

#[derive(Deserialize)]
struct SaveDocxArgs {
    title: String,
    base64_data: String,
}

#[derive(Deserialize)]
struct SaveFileArgs {
    filename: String,
    base64_data: String,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
}

#[derive(Default, Deserialize, Serialize)]
struct ExportPreferences {
    last_directory: Option<PathBuf>,
}

fn export_preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("export-preferences.json"))
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))
}

fn load_export_preferences(app: &tauri::AppHandle) -> ExportPreferences {
    let Ok(path) = export_preferences_path(app) else {
        return ExportPreferences::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return ExportPreferences::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn remember_export_directory(app: &tauri::AppHandle, directory: &Path) {
    let Ok(path) = export_preferences_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::warn!("Failed to create export preferences directory: {error}");
            return;
        }
    }
    let preferences = ExportPreferences {
        last_directory: Some(directory.to_path_buf()),
    };
    match serde_json::to_vec_pretty(&preferences) {
        Ok(raw) => {
            if let Err(error) = std::fs::write(path, raw) {
                log::warn!("Failed to save export preferences: {error}");
            }
        }
        Err(error) => log::warn!("Failed to serialize export preferences: {error}"),
    }
}

fn decode_base64_data(base64_data: &str) -> Result<Vec<u8>, String> {
    let encoded = if base64_data.starts_with("data:") {
        base64_data
            .split_once(',')
            .map(|(_, payload)| payload)
            .unwrap_or(base64_data)
    } else {
        base64_data
    };

    use base64::{engine::general_purpose, Engine as _};
    general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Failed to decode exported file: {e}"))
}

fn safe_export_filename(filename: &str) -> String {
    Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("WhyFish-export")
        .to_string()
}

fn save_export_file(app: &tauri::AppHandle, args: SaveFileArgs) -> Result<String, String> {
    let bytes = decode_base64_data(&args.base64_data)?;
    let preferences = load_export_preferences(app);
    let mut dialog = FileDialog::new().set_file_name(safe_export_filename(&args.filename));

    if let Some(directory) = preferences.last_directory.filter(|path| path.is_dir()) {
        dialog = dialog.set_directory(directory);
    }

    if let Some(extensions) = args.extensions.filter(|items| !items.is_empty()) {
        dialog = dialog.add_filter(
            args.filter_name.as_deref().unwrap_or("WhyFish 文件"),
            &extensions,
        );
    }

    let Some(path) = dialog.save_file() else {
        return Ok("Cancelled".to_string());
    };

    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write file: {e}"))?;
    if let Some(directory) = path.parent() {
        remember_export_directory(app, directory);
    }

    Ok("Success".to_string())
}

#[tauri::command]
fn save_file_local(app: tauri::AppHandle, args: SaveFileArgs) -> Result<String, String> {
    save_export_file(&app, args)
}

#[tauri::command]
fn save_docx_local(app: tauri::AppHandle, args: SaveDocxArgs) -> Result<String, String> {
    save_export_file(
        &app,
        SaveFileArgs {
            filename: format!("{}.docx", args.title.replace("/", "_").replace("\\", "_")),
            base64_data: args.base64_data,
            filter_name: Some("Word 文档".to_string()),
            extensions: Some(vec!["docx".to_string()]),
        },
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            proxy_call,
            save_file_local,
            save_docx_local
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{decode_base64_data, safe_export_filename};

    #[test]
    fn decodes_data_urls_for_native_exports() {
        let decoded = decode_base64_data("data:text/plain;base64,5rWL6K+V").unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "测试");
    }

    #[test]
    fn strips_directories_from_export_filenames() {
        assert_eq!(safe_export_filename("../../report.md"), "report.md");
        assert_eq!(safe_export_filename(""), "WhyFish-export");
    }
}
