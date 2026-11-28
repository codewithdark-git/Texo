mod agents;
mod ai;
mod archive;
mod bibinputs;
mod chat;
mod commands;
mod compile;
mod engine;
mod error;
mod fsops;
mod history;
mod library;
mod project;
mod settings;
mod symbols;
mod synctex;
mod templates;
mod texlog;
mod texpkg;
mod watcher;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    /// This process's view of `settings.json`, refreshed when another Texo
    /// process saves it. Change it only through `settings_file.update`.
    pub settings: settings::Settings,
    pub settings_file: settings::SettingsFile,
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
        // Reopens the window where the user left it (size, position, maximized).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Files dropped on the window may be attached to a chat message
        // (chat::dropped reads only paths that were really dropped).
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                chat::dropped::remember(paths);
            }
        })
        .on_webview_event(|_webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                chat::dropped::remember(paths);
            }
        })
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let tools_dir = app.path().app_data_dir()?.join("tools");
            let mut settings_file = settings::SettingsFile::new(settings_path, default_projects_root());
            let settings = settings_file.load();
            // A projects folder on a drive that isn't connected must not stop
            // Texo from starting; creating a project reports the problem.
            let _ = std::fs::create_dir_all(&settings.projects_root);
            app.manage(Mutex::new(AppState {
                settings,
                settings_file,
                watcher: None,
                tools_dir,
            }));
            app.manage(compile::Running::default());
            app.manage(commands::SyncCache::default());
            app.manage(ai::AiState::new(
                &app.path().app_config_dir()?,
                &app.path().app_data_dir()?,
            ));
            app.manage(agents::commands::runtime_for(app.handle()));
            // The paper library never stops Texo from starting: when it
            // can't be opened, its commands report why.
            app.manage(library::LibraryState::open(&app.path().app_data_dir()?.join("library")));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_projects_root,
            commands::list_projects,
            commands::create_project,
            commands::open_folder,
            commands::copy_folder_to_projects,
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
            commands::read_pdf,
            commands::synctex_forward,
            commands::synctex_inverse,
            commands::save_thumbnail,
            commands::engine_status,
            commands::prepare_engine,
            commands::inspect_archive,
            commands::import_archive,
            commands::export_project,
            commands::save_pdf_as,
            commands::read_asset,
            texpkg::install_tex_package,
            ai::commands::ai_get_settings,
            ai::commands::ai_update_settings,
            ai::commands::ai_list_providers,
            ai::commands::ai_key_status,
            ai::commands::ai_set_key,
            ai::commands::ai_clear_key,
            ai::commands::ai_list_models,
            ai::commands::ai_test_connection,
            ai::commands::ai_preview_context,
            ai::commands::ai_explain_and_fix,
            ai::commands::ai_cancel,
            ai::commands::ai_check_edits,
            ai::commands::ai_install_package,
            agents::tools::web_settings::web_tools_status,
            agents::tools::web_settings::web_tools_set_key,
            agents::tools::web_settings::web_tools_clear_key,
            agents::tools::web_settings::web_tools_update_settings,
            history::commands::history_status,
            history::commands::history_log,
            history::commands::history_changes,
            history::commands::history_diff,
            history::commands::history_restore_file,
            history::commands::history_restore_all,
            history::commands::history_undo_run,
            history::commands::history_label,
            history::commands::history_snapshot,
            history::commands::history_set_enabled,
            history::commands::history_git_exclude,
            chat::commands::ai_chat_list,
            chat::commands::ai_chat_get,
            chat::commands::ai_chat_new,
            chat::commands::ai_chat_rename,
            chat::commands::ai_chat_delete,
            chat::commands::ai_chat_send,
            chat::commands::ai_chat_cancel,
            chat::dropped::ai_chat_read_dropped,
            agents::commands::agent_start,
            agents::commands::agent_list,
            agents::commands::agent_get,
            agents::commands::agent_cancel,
            agents::commands::agent_respond,
            agents::commands::agent_changeset,
            agents::commands::agent_apply,
            agents::commands::agent_discard,
            agents::commands::agent_delete,
            agents::review::review_presets,
            agents::review::review_checklist,
            agents::profile_commands::agent_profiles_list,
            agents::profile_commands::agent_profiles_save,
            agents::profile_commands::agent_profiles_delete,
            agents::profile_commands::agent_profiles_reset,
            agents::profile_commands::agent_defaults_save,
            agents::profile_commands::memory_get,
            agents::profile_commands::memory_set,
            agents::profile_commands::memory_clear,
            agents::profile_commands::memory_add,
            agents::ui_support::agent_kind_tools,
            agents::ui_support::review_render,
            agents::ui_support::review_save_as,
            library::commands::library_status,
            library::commands::library_search,
            library::commands::library_get,
            library::commands::library_save,
            library::commands::library_unsave,
            library::commands::library_remove,
            library::commands::library_tag,
            library::commands::library_note,
            library::commands::library_project_refs,
            library::commands::library_sync_bib,
            library::commands::library_clear_cache,
            library::commands::library_backup,
            library::commands::library_export,
            library::online::library_search_online,
            library::online::library_verify,
            library::online::library_bibtex_for,
            library::online::library_related,
            library::online::library_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Texo")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(lib) = app.try_state::<library::LibraryState>() {
                    lib.close();
                }
            }
        });
}
