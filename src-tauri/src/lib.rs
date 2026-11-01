mod commands;
mod compile;
mod error;
mod fsops;
mod project;
mod settings;
mod symbols;
mod templates;
mod texlog;
mod watcher;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    pub settings: settings::Settings,
    pub settings_path: PathBuf,
    /// Watches the project open in the workspace, if any.
    pub watcher: Option<watcher::ProjectWatcher>,
    /// Where Texo keeps tools it downloads, such as Tectonic.
    pub tools_dir: PathBuf,
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
            let tools_dir = app.path().app_data_dir()?.join("tools");
            let settings = settings::Settings::load(&settings_path, default_projects_root());
            std::fs::create_dir_all(&settings.projects_root)?;
            app.manage(Mutex::new(AppState {
                settings,
                settings_path,
                watcher: None,
                tools_dir,
            }));
            app.manage(compile::Running::default());
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
            commands::set_main_document,
            commands::read_file,
            commands::write_file,
            commands::create_file,
            commands::create_folder,
            commands::rename_path,
            commands::delete_path,
            commands::import_files,
            commands::project_symbols,
            commands::watch_project,
            commands::unwatch_project,
            commands::detect_toolchains,
            commands::set_compiler,
            commands::set_engine,
            commands::compile_project,
            commands::abort_compile,
            commands::trust_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Texo");
}
