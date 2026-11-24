use crate::store::{canonical, err, file_name};
use regex::RegexBuilder;
use serde::Serialize;
use std::{fs, path::{Component, Path, PathBuf}};

#[derive(Serialize)]
pub struct Entry {
    pub path: PathBuf,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Entry>>,
}

#[derive(Serialize)]
pub struct Match {
    path: PathBuf,
    name: String,
    line: usize,
    preview: String,
}

pub fn markdown(path: &Path) -> bool {
    path.extension().and_then(|x| x.to_str()).is_some_and(|x| {
        ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt", "mdtext", "text", "txt", "rmd", "qmd", "mdx"].iter().any(|ext| x.eq_ignore_ascii_case(ext))
    })
}

pub fn inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let checked = canonical(&if path.is_absolute() { path.to_owned() } else { root.join(path) }).map_err(err)?;
    if !checked.starts_with(root) {
        return Err("路径超出当前工作区".into());
    }
    Ok(checked)
}

fn listed(name: &str, include_hidden: bool) -> bool {
    !matches!(name, ".git" | "node_modules" | "target" | ".DS_Store") && (include_hidden || !name.starts_with('.'))
}

fn read_tree(root: &Path, hidden: bool, all: bool) -> Result<Vec<Entry>, String> {
    let mut output = Vec::new();
    for entry in fs::read_dir(root).map_err(err)?.flatten() {
        let path = entry.path();
        let name = file_name(&path);
        let Ok(kind) = entry.file_type() else { continue };
        if !listed(&name, hidden) || kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if let Ok(children) = read_tree(&path, hidden, all) {
                output.push(Entry { path, name, children: Some(children) });
            }
        } else if kind.is_file() && (all || markdown(&path)) {
            output.push(Entry { path, name, children: None });
        }
    }
    output.sort_by(|a, b| b.children.is_some().cmp(&a.children.is_some()).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(output)
}

pub fn search(root: &Path, query: &str, regex: bool, include_hidden: bool) -> Result<Vec<Match>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = if regex { query.to_owned() } else { regex::escape(query) };
    let matcher = RegexBuilder::new(&pattern).case_insensitive(true).build().map_err(err)?;
    let mut matches = Vec::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false).into_iter()
        .filter_entry(|entry| entry.depth() == 0 || listed(&entry.file_name().to_string_lossy(), include_hidden))
        .flatten() {
        let path = entry.path();
        if !entry.file_type().is_file() || !markdown(path) {
            continue;
        }
        let Ok(content) = fs::read_to_string(path) else { continue };
        for (index, line) in content.lines().enumerate() {
            if let Some(matched) = matcher.find(line) {
                let start = line[..matched.start()].char_indices().rev().nth(55).map_or(0, |(i, _)| i);
                let preview: String = line[start..].chars().take(180).collect();
                matches.push(Match { path: path.to_owned(), name: file_name(path), line: index + 1, preview });
                if matches.len() == 1000 {
                    return Ok(matches);
                }
            }
        }
    }
    Ok(matches)
}

fn name_component(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let mut parts = Path::new(name).components();
    if name.contains(['/', '\\', '\0']) || !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
        return Err("请输入一个有效的文件名".into());
    }
    Ok(name)
}

#[tauri::command]
pub async fn workspace_tree(root: PathBuf, hidden: bool, all: bool) -> Result<Vec<Entry>, String> {
    read_tree(&canonical(&root).map_err(err)?, hidden, all)
}

#[tauri::command]
pub async fn workspace_search(root: PathBuf, text: String, regex: bool, hidden: bool) -> Result<Vec<Match>, String> {
    search(&canonical(&root).map_err(err)?, &text, regex, hidden)
}

#[tauri::command]
pub async fn workspace_create(root: PathBuf, parent: PathBuf, name: String, folder: bool) -> Result<PathBuf, String> {
    let root = canonical(&root).map_err(err)?;
    let path = inside(&root, &parent)?.join(name_component(&name)?);
    if folder {
        fs::create_dir(&path).map_err(err)?;
    } else {
        fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(err)?;
    }
    Ok(path)
}

#[tauri::command]
pub async fn workspace_rename(root: PathBuf, path: PathBuf, name: String) -> Result<PathBuf, String> {
    let root = canonical(&root).map_err(err)?;
    let path = inside(&root, &path)?;
    if path == root {
        return Err("无法重命名工作区根目录".into());
    }
    let dest = path.with_file_name(name_component(&name)?);
    if dest == path {
        return Ok(path);
    }
    if dest.symlink_metadata().is_ok() {
        return Err("目标名称已存在".into());
    }
    fs::rename(&path, &dest).map_err(err)?;
    Ok(dest)
}

#[tauri::command]
pub async fn workspace_trash(root: PathBuf, path: PathBuf) -> Result<(), String> {
    let root = canonical(&root).map_err(err)?;
    let path = inside(&root, &path)?;
    if root == path {
        return Err("无法移除工作区根目录".into());
    }
    trash::delete(path).map_err(err)
}
