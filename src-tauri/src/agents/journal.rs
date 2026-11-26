//! Run journals: `.texo/ai/runs/<run-id>.json`, one per run, rewritten
//! (through a temporary file) after every step. They keep the prompt, the
//! model, every step with capped arguments and results, the changeset and
//! the usage, so past runs show after a restart.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::project;

use super::types::{now, AgentRun, RunStatus};

pub const VERSION: u32 = 1;
/// Most journals `list` reads (newest first).
const MAX_LISTED: usize = 200;

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// `.texo/ai/runs`, created when missing (links refused).
pub fn runs_dir(dir: &Path) -> AppResult<PathBuf> {
    let ai = project::meta_subdir(dir, Some("ai"))?;
    let runs = ai.join("runs");
    if is_link(&runs) {
        return Err(AppError::msg("The AI runs folder is a link to another location, so Texo won't write to it."));
    }
    fs::create_dir_all(&runs)?;
    Ok(runs)
}

/// The journal's path relative to the project (for the history note).
pub fn rel_path(id: &str) -> String {
    format!("{}/ai/runs/{id}.json", project::META_DIR)
}

fn file(dir: &Path, id: &str) -> AppResult<PathBuf> {
    crate::history::apply::valid_run_id(id)?;
    Ok(runs_dir(dir)?.join(format!("{id}.json")))
}

pub fn save(dir: &Path, run: &AgentRun) -> AppResult<()> {
    let path = file(dir, &run.id)?;
    let tmp = path.with_extension("json.tmp");
    let mut run = run.clone();
    run.version = VERSION;
    fs::write(&tmp, serde_json::to_vec_pretty(&run)?)?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

pub fn load(dir: &Path, id: &str) -> AppResult<AgentRun> {
    let path = file(dir, id)?;
    let bytes = fs::read(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::msg("That AI run can't be found. It may have been deleted.")
        } else {
            e.into()
        }
    })?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::msg("This AI run's record is damaged and can't be read."))
}

pub fn remove(dir: &Path, id: &str) -> AppResult<()> {
    let path = file(dir, id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// All readable journals of a project, newest first. Runs that were active
/// but aren't `live` (the app closed mid-run) are marked `interrupted` and
/// saved that way.
pub fn list(dir: &Path, live: &dyn Fn(&str) -> bool) -> Vec<AgentRun> {
    let Ok(runs) = runs_dir(dir) else { return Vec::new() };
    let Ok(entries) = fs::read_dir(&runs) else { return Vec::new() };
    let mut out: Vec<AgentRun> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<AgentRun>(&fs::read(e.path()).ok()?).ok())
        .collect();
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| b.id.cmp(&a.id)));
    out.truncate(MAX_LISTED);
    for run in &mut out {
        if run.status.is_active() && !live(&run.id) {
            mark_interrupted(run);
            let _ = save(dir, run);
        }
    }
    out
}

pub fn mark_interrupted(run: &mut AgentRun) {
    run.status = RunStatus::Interrupted;
    run.finished_at.get_or_insert_with(now);
    run.awaiting = None;
    if run.error.is_none() {
        run.error = Some(if run.changeset.is_empty() {
            "Texo was closed while this run was working, so it stopped.".into()
        } else {
            "Texo was closed while this run was working. The changes it made so far can still be reviewed.".into()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::types::{ChangeEntry, Step, StepKind};

    fn run(id: &str, status: RunStatus, started: i64) -> AgentRun {
        AgentRun {
            id: id.into(),
            project: "p".into(),
            kind: "fixer".into(),
            title: "Fix".into(),
            prompt: "Fix it".into(),
            status,
            started_at: started,
            ..Default::default()
        }
    }

    #[test]
    fn journals_round_trip_and_interrupted_runs_are_marked() {
        let d = tempfile::tempdir().unwrap();
        let mut a = run("run-a", RunStatus::Done, 10);
        a.steps.push(Step {
            n: 1,
            kind: StepKind::ToolCall,
            tool: Some("read_file".into()),
            args: Some(serde_json::json!({"path": "main.tex"})),
            result_summary: "Read main.tex".into(),
            result: Some("1: x".into()),
            text: None,
            ok: true,
            ms: 3,
            at: 10,
            sub: None,
            notice: false,
        });
        a.changeset.push(ChangeEntry { file: "main.tex".into(), base_text: Some("a".into()), new_text: Some("b".into()), ..Default::default() });
        save(d.path(), &a).unwrap();
        save(d.path(), &run("run-b", RunStatus::Running, 20)).unwrap();
        save(d.path(), &run("run-c", RunStatus::AwaitingInput, 30)).unwrap();
        save(d.path(), &run("run-live", RunStatus::Running, 40)).unwrap();
        fs::write(runs_dir(d.path()).unwrap().join("junk.json"), "not json").unwrap();

        assert_eq!(load(d.path(), "run-a").unwrap(), AgentRun { version: VERSION, ..a.clone() });
        assert!(d.path().join(".texo/ai/runs/run-a.json").is_file());

        let listed = list(d.path(), &|id| id == "run-live");
        let ids: Vec<&str> = listed.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["run-live", "run-c", "run-b", "run-a"]);
        assert_eq!(listed[0].status, RunStatus::Running);
        assert_eq!(listed[1].status, RunStatus::Interrupted);
        assert_eq!(listed[2].status, RunStatus::Interrupted);
        assert!(listed[2].error.as_deref().unwrap().contains("closed"));
        assert_eq!(listed[3].status, RunStatus::Done);
        // Saved that way.
        assert_eq!(load(d.path(), "run-b").unwrap().status, RunStatus::Interrupted);

        remove(d.path(), "run-a").unwrap();
        assert!(load(d.path(), "run-a").is_err());
        remove(d.path(), "run-a").unwrap();
        assert!(load(d.path(), "../x").is_err());
    }
}
