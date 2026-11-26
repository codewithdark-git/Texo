//! Opening the private history repo (`<project>/.texo/history`, bare, with
//! the project as its working folder at runtime), the per-project settings
//! file, locking, corrupt-repo recovery and packing.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::Duration;

use git2::{ErrorCode, ObjectType, Oid, Repository, RepositoryInitOptions, TreeWalkMode, TreeWalkResult};
use serde::{Deserialize, Serialize};

use super::lock;
use crate::error::{AppError, AppResult};
use crate::project::META_DIR;

pub const HISTORY_DIR: &str = "history";
/// Per-project history settings, next to (not inside) the repo so they
/// survive a corrupt repo being replaced.
pub const PREFS_FILE: &str = "history.json";
pub const NOTES_REF: &str = "refs/notes/texo";
pub const PACK_FILE: &str = "texo-pack.json";
/// Loose objects are packed after this many commits.
pub const PACK_EVERY: u32 = 200;

pub const READ_ONLY_MSG: &str =
    "This project's folder can't be written to, so Texo can't keep a history of your changes here.";

pub fn git_dir(dir: &Path) -> PathBuf {
    dir.join(META_DIR).join(HISTORY_DIR)
}

/// Turns a libgit2 error into a plain message. The technical text goes to
/// the log only.
pub fn g(e: git2::Error) -> AppError {
    eprintln!("[history] git error: {e}");
    AppError::msg("Texo couldn't read or save this project's history. Your files are not affected.")
}

/// libgit2 reads the user's global git config and checks folder ownership
/// by default. Texo's repo is private, so neither applies (an exFAT or
/// network drive would otherwise fail the ownership check).
fn init_libgit2() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        use git2::ConfigLevel::*;
        for level in [System, XDG, Global, ProgramData] {
            let _ = git2::opts::set_search_path(level, "");
        }
        let _ = git2::opts::set_verify_owner_validation(false);
    });
}

// ---------------------------------------------------------------------------
// Settings

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    #[serde(default = "yes")]
    pub enabled: bool,
    /// The user answered the "add .texo/ to .git/info/exclude" offer.
    #[serde(default)]
    pub git_exclude_answered: bool,
    /// Shown once in the History panel (for example after a broken history
    /// was set aside), then cleared by `history_status`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

fn yes() -> bool {
    true
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { enabled: true, git_exclude_answered: false, notice: None }
    }
}

impl Prefs {
    pub fn load(dir: &Path) -> Self {
        fs::read(dir.join(META_DIR).join(PREFS_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> AppResult<()> {
        let meta = dir.join(META_DIR);
        fs::create_dir_all(&meta)?;
        let tmp = meta.join(format!("{PREFS_FILE}.texo-tmp"));
        fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        if let Err(e) = fs::rename(&tmp, meta.join(PREFS_FILE)) {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        Ok(())
    }

    pub fn update(dir: &Path, f: impl FnOnce(&mut Prefs)) -> AppResult<Prefs> {
        let mut p = Prefs::load(dir);
        f(&mut p);
        p.save(dir)?;
        Ok(p)
    }
}

// ---------------------------------------------------------------------------
// Opening

pub fn is_read_only(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem)
        || matches!(e.raw_os_error(), Some(5) | Some(19) | Some(30))
}

fn io_open_error(e: std::io::Error) -> AppError {
    if is_read_only(&e) {
        AppError::msg(READ_ONLY_MSG)
    } else {
        AppError::from(e)
    }
}

/// An open history with both locks held.
pub struct Ctx {
    pub repo: Repository,
    pub dir: PathBuf,
    pub git_dir: PathBuf,
}

/// How long user-facing commands wait for another writer.
pub const WAIT: Duration = Duration::from_secs(10);
/// Automatic snapshots give up sooner: they must never hold up a save.
pub const AUTO_WAIT: Duration = Duration::from_secs(3);

/// Runs `f` with the project's history open and locked (in-process mutex
/// plus `texo.lock`), creating the repo on first use and replacing a broken
/// one.
pub fn with_repo<T>(dir: &Path, wait: Duration, f: impl FnOnce(&Ctx) -> AppResult<T>) -> AppResult<T> {
    init_libgit2();
    let m = lock::project_mutex(dir);
    let _guard = lock::lock_mutex(&m, wait)?;
    let gd = git_dir(dir);
    fs::create_dir_all(&gd).map_err(io_open_error)?;
    let mut file_lock = lock::acquire(&gd, wait).map_err(|e| match e {
        AppError::Io(io) => io_open_error(io),
        other => other,
    })?;
    remove_orphan_packs(&gd.join("objects").join("pack"));
    let repo = match open_or_init(dir, &gd) {
        Ok(r) => r,
        Err(OpenError::Unavailable) => return Err(unavailable()),
        Err(OpenError::Broken) => {
            drop(file_lock);
            set_aside(dir, &gd)?;
            fs::create_dir_all(&gd).map_err(io_open_error)?;
            file_lock = lock::acquire(&gd, wait)?;
            open_or_init(dir, &gd).map_err(|_| AppError::msg("Texo couldn't create a new history for this project."))?
        }
    };
    let ctx = Ctx { repo, dir: dir.to_path_buf(), git_dir: gd };
    let out = f(&ctx);
    drop(ctx);
    drop(file_lock);
    out
}

/// Why an existing repo couldn't be opened.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// Its contents are damaged: set it aside and start a new one.
    Broken,
    /// Its files can't be read right now (offline cloud files, another app
    /// or an antivirus scan holding them). The history is left alone.
    Unavailable,
}

fn unavailable() -> AppError {
    AppError::msg(
        "This project's history can't be read right now (its files may be offline or open in another app). Your files are not affected. Try again in a moment.",
    )
}

/// True for errors from reading the disk rather than from damaged contents:
/// those pass, so the history must not be set aside for them.
pub fn is_transient(e: &git2::Error) -> bool {
    matches!(e.class(), git2::ErrorClass::Os | git2::ErrorClass::Filesystem)
        && !matches!(e.code(), ErrorCode::NotFound)
}

/// Sorts an error from opening an existing repo.
fn classify(what: &str, e: &git2::Error) -> OpenError {
    eprintln!("[history] {what}: {e}");
    if is_transient(e) {
        OpenError::Unavailable
    } else {
        OpenError::Broken
    }
}

fn open_or_init(dir: &Path, gd: &Path) -> Result<Repository, OpenError> {
    let head = gd.join("HEAD");
    let repo = if head.exists() {
        // A HEAD file that can't be read at all (cloud-only, locked) says
        // nothing about whether the history is damaged.
        if let Err(e) = fs::read(&head) {
            eprintln!("[history] can't read {}: {e}", head.display());
            return Err(OpenError::Unavailable);
        }
        let r = Repository::open_bare(gd).map_err(|e| classify(&format!("can't open {}", gd.display()), &e))?;
        healthy(&r)?;
        r
    } else {
        let mut opts = RepositoryInitOptions::new();
        opts.bare(true).mkpath(true).initial_head("main").description("Texo history (private; do not edit)");
        Repository::init_opts(gd, &opts).map_err(|e| {
            eprintln!("[history] can't create {}: {e}", gd.display());
            OpenError::Broken
        })?
    };
    // Only in memory: the repo stays bare on disk and never writes a `.git`
    // file into the project.
    let _ = repo.set_workdir(dir, false);
    Ok(repo)
}

/// True when HEAD (if any) and its tree can be read.
fn healthy(r: &Repository) -> Result<(), OpenError> {
    match r.head() {
        Ok(h) => {
            let c = h.peel_to_commit().map_err(|e| classify("HEAD unreadable", &e))?;
            c.tree().map(|_| ()).map_err(|e| classify("HEAD tree unreadable", &e))
        }
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => Ok(()),
        Err(e) => Err(classify("HEAD error", &e)),
    }
}

/// Renames a broken repo to `history.broken-<ts>` and leaves a notice.
pub fn set_aside(dir: &Path, gd: &Path) -> AppResult<()> {
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = gd.with_file_name(format!("{HISTORY_DIR}.broken-{ts}"));
    eprintln!("[history] setting aside broken history at {}", gd.display());
    let mut last = None;
    for _ in 0..5 {
        match fs::rename(gd, &target) {
            Ok(()) => {
                last = None;
                break;
            }
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    if let Some(e) = last {
        eprintln!("[history] rename failed: {e}");
        return Err(AppError::msg(
            "This project's history is damaged and Texo couldn't set it aside. Close other Texo windows and try again.",
        ));
    }
    let _ = Prefs::update(dir, |p| {
        p.notice = Some(format!(
            "This project's history was damaged, so Texo started a new one from your current files. The old one was kept in .texo/{}.",
            target.file_name().unwrap_or_default().to_string_lossy()
        ))
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Trees

/// One file in a tree: blob id and file mode.
pub type Entries = BTreeMap<String, (Oid, u32)>;

pub const BLOB_MODE: u32 = 0o100644;

/// Every file (blob) in a tree by `/`-separated path.
pub fn flatten(tree: Option<&git2::Tree<'_>>) -> AppResult<Entries> {
    let mut out = Entries::new();
    let Some(tree) = tree else { return Ok(out) };
    tree.walk(TreeWalkMode::PreOrder, |root, e| {
        // Texo only ever stores Unicode names.
        if let (Some(ObjectType::Blob), Ok(name)) = (e.kind(), e.name()) {
            out.insert(format!("{root}{name}"), (e.id(), e.filemode() as u32));
        }
        TreeWalkResult::Ok
    })
    .map_err(g)?;
    Ok(out)
}

/// Writes a tree for `entries` through an in-memory index (never the repo's
/// index file).
pub fn write_tree(repo: &Repository, entries: &Entries) -> AppResult<Oid> {
    let mut index = git2::Index::new().map_err(g)?;
    for (path, (id, mode)) in entries {
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: *mode,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: *id,
            flags: (path.len().min(0xfff)) as u16,
            flags_extended: 0,
            path: path.as_bytes().to_vec(),
        };
        index.add(&entry).map_err(g)?;
    }
    index.write_tree_to(repo).map_err(g)
}

pub fn head_commit(repo: &Repository) -> AppResult<Option<git2::Commit<'_>>> {
    match repo.head() {
        Ok(h) => h.peel_to_commit().map(Some).map_err(g),
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => Ok(None),
        Err(e) => Err(g(e)),
    }
}

pub fn parse_oid(repo: &Repository, id: &str) -> AppResult<Oid> {
    let id = id.trim();
    let bad = || AppError::msg("That point in the history can't be found.");
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(bad());
    }
    repo.revparse_single(id).and_then(|o| o.peel_to_commit()).map(|c| c.id()).map_err(|_| bad())
}

// ---------------------------------------------------------------------------
// Packing

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackState {
    #[serde(default)]
    since_pack: u32,
}

/// Counts a commit and packs loose objects every [`PACK_EVERY`] commits.
pub fn count_commit(ctx: &Ctx) {
    let path = ctx.git_dir.join(PACK_FILE);
    let mut st: PackState = fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    st.since_pack += 1;
    if st.since_pack >= PACK_EVERY {
        match pack(ctx) {
            Ok(n) => {
                eprintln!("[history] packed {n} objects");
                st.since_pack = 0;
            }
            Err(e) => eprintln!("[history] packing failed: {e}"),
        }
    }
    if let Ok(json) = serde_json::to_vec(&st) {
        let _ = fs::write(&path, json);
    }
}

/// Every object reachable from any ref (commits, trees, blobs, tags, notes).
/// Any read error fails the whole walk: the old packs are deleted after
/// packing, so a missed object would be lost.
fn reachable(repo: &Repository) -> AppResult<Vec<Oid>> {
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    let mut walk = repo.revwalk().map_err(g)?;
    for r in repo.references().map_err(g)? {
        let r = r.map_err(g)?;
        let Some(target) = r.target() else { continue };
        let obj = repo.find_object(target, None).map_err(g)?;
        if obj.kind() == Some(ObjectType::Tag) && seen.insert(target) {
            order.push(target);
        }
        if let Ok(c) = obj.peel_to_commit() {
            walk.push(c.id()).map_err(g)?;
        }
    }
    for id in walk {
        let id = id.map_err(g)?;
        if !seen.insert(id) {
            continue;
        }
        order.push(id);
        let c = repo.find_commit(id).map_err(g)?;
        let tree = c.tree().map_err(g)?;
        if seen.insert(tree.id()) {
            order.push(tree.id());
        }
        tree.walk(TreeWalkMode::PreOrder, |_, e| {
            if seen.insert(e.id()) {
                order.push(e.id());
            }
            TreeWalkResult::Ok
        })
        .map_err(g)?;
    }
    Ok(order)
}

/// Writes one pack with every reachable object and removes the loose copies
/// and the older packs (the new one holds everything they did that is still
/// in the history).
pub fn pack(ctx: &Ctx) -> AppResult<usize> {
    let ids = reachable(&ctx.repo)?;
    if ids.is_empty() {
        return Ok(0);
    }
    let pack_dir = ctx.git_dir.join("objects").join("pack");
    fs::create_dir_all(&pack_dir)?;
    let mut pb = ctx.repo.packbuilder().map_err(g)?;
    for id in &ids {
        pb.insert_object(*id, None).map_err(g)?;
    }
    pb.write(&pack_dir, 0o644).map_err(g)?;
    let new_name = pb.name().map_err(g)?.map(|n| format!("pack-{n}"));
    if let Some(new_name) = &new_name {
        remove_old_packs(&pack_dir, new_name);
    }
    let packed: HashSet<Oid> = ids.into_iter().collect();
    let mut removed = 0;
    let objects = ctx.git_dir.join("objects");
    for d in fs::read_dir(&objects)?.flatten() {
        let name = d.file_name().to_string_lossy().to_string();
        if name.len() != 2 || !name.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        for f in fs::read_dir(d.path())?.flatten() {
            let rest = f.file_name().to_string_lossy().to_string();
            if let Ok(id) = Oid::from_str(&format!("{name}{rest}")) {
                if packed.contains(&id) && fs::remove_file(f.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        let _ = fs::remove_dir(d.path());
    }
    Ok(removed)
}

/// Deletes every `pack-*.{idx,pack,rev}` except `keep` (`pack-<hash>`).
/// The index goes first so a pack whose data file can't be removed yet
/// (open on Windows) is no longer used; leftovers are retried next time.
fn remove_old_packs(pack_dir: &Path, keep: &str) {
    let Ok(read) = fs::read_dir(pack_dir) else { return };
    let mut stems: Vec<String> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let stem = name.rsplit_once('.').map(|(s, _)| s.to_string())?;
            (stem.starts_with("pack-") && stem != keep).then_some(stem)
        })
        .collect();
    stems.sort();
    stems.dedup();
    for stem in stems {
        for ext in ["idx", "pack", "rev"] {
            let p = pack_dir.join(format!("{stem}.{ext}"));
            match fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => eprintln!("[history] can't remove old pack {}: {e}", p.display()),
            }
        }
    }
}

/// Finishes [`remove_old_packs`] on Windows, where an open repo keeps its
/// packs open: a pack whose index is already gone is never read again, so
/// it is deleted before the repo is opened (with the lock held).
fn remove_orphan_packs(pack_dir: &Path) {
    let Ok(read) = fs::read_dir(pack_dir) else { return };
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some((stem, ext)) = name.rsplit_once('.') else { continue };
        if stem.starts_with("pack-") && matches!(ext, "pack" | "rev") && !pack_dir.join(format!("{stem}.idx")).exists() {
            if let Err(err) = fs::remove_file(e.path()) {
                eprintln!("[history] can't remove old pack {name}: {err}");
            }
        }
    }
}

/// Total size of the repo folder in bytes.
pub fn size_on_disk(gd: &Path) -> u64 {
    walkdir::WalkDir::new(gd)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}
