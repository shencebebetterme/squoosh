use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderImage {
    name: String,
    relative_path: String,
    mime: String,
    bytes: Vec<u8>,
}

#[tauri::command]
fn read_image_folder(folder_path: String) -> Result<Vec<FolderImage>, String> {
    let root = PathBuf::from(folder_path);
    if !root.is_dir() {
        return Err("Selected path is not a folder".into());
    }

    let mut images = Vec::new();
    collect_images(&root, &root, &mut images)?;

    if images.is_empty() {
        return Err("No supported images found in that folder".into());
    }

    Ok(images)
}

#[tauri::command]
fn write_zip_file(zip_path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(&zip_path, bytes).map_err(|error| format!("Failed to save {zip_path}: {error}"))
}

fn collect_images(
    root: &Path,
    current: &Path,
    images: &mut Vec<FolderImage>,
) -> Result<(), String> {
    for entry in fs::read_dir(current)
        .map_err(|error| format!("Failed to read {}: {error}", current.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;

        if file_type.is_dir() {
            collect_images(root, &path, images)?;
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        let Some(mime) = image_mime(&path) else {
            continue;
        };

        let bytes = fs::read(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image")
            .to_string();
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        images.push(FolderImage {
            name,
            relative_path,
            mime: mime.to_string(),
            bytes,
        });
    }

    Ok(())
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "avif" => Some("image/avif"),
        "jxl" => Some("image/jxl"),
        "svg" => Some("image/svg+xml"),
        "qoi" => Some("image/qoi"),
        "tif" | "tiff" => Some("image/tiff"),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_image_folder, write_zip_file])
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
