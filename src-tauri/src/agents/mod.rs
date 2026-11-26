//! AI agents (v1.2): background runs, their tools and kinds. See
//! `internal/v1.2-agents-spec.md`.

pub mod attach;
pub mod changeset;
pub mod commands;
pub mod journal;
pub mod kinds;
pub mod overlay;
pub mod profile_commands;
pub mod profiles;
pub mod review;
pub mod run_loop;
pub mod runtime;
pub mod safety;
pub mod tools;
pub mod types;
pub mod ui_support;

#[cfg(test)]
mod kind_tests;
#[cfg(test)]
mod tests;
