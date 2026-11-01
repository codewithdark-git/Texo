mod commands;
mod error;
mod project;
mod settings;
mod templates;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    pub settings: settings::Settings,
    pub settings_path: PathBuf,
}

fn default_projects_root() -> PathBuf {
    dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Texo")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let settings = settings::Settings::load(&settings_path, default_projects_root());
            std::fs::create_dir_all(&settings.projects_root)?;
            app.manage(Mutex::new(AppState {
                settings,
                settings_path,
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_projects_root,
            commands::list_projects,
            commands::create_project,
            commands::open_folder,
            commands::rename_project,
            commands::duplicate_project,
            commands::delete_project,
            commands::forget_project,
            commands::list_project_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Texo");
}
