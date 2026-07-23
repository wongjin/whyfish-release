use serde::Deserialize;
use rfd::FileDialog;

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
    let mut req = client.post(&args.url)
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

#[tauri::command]
async fn save_docx_local(args: SaveDocxArgs) -> Result<String, String> {
    let file_path = FileDialog::new()
        .add_filter("Word Document", &["docx"])
        .set_file_name(&format!("{}.docx", args.title.replace("/", "_").replace("\\", "_")))
        .save_file();

    let path = match file_path {
        Some(p) => p,
        None => return Ok("Cancelled".to_string()),
    };

    let clean_base64 = if args.base64_data.starts_with("data:") {
        if let Some(comma_idx) = args.base64_data.find(',') {
            &args.base64_data[comma_idx + 1..]
        } else {
            &args.base64_data
        }
    } else {
        &args.base64_data
    };

    use base64::{Engine as _, engine::general_purpose};
    let docx_bytes = general_purpose::STANDARD.decode(clean_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    std::fs::write(&path, docx_bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok("Success".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![proxy_call, save_docx_local])
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
