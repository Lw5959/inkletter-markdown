use super::{
    API_VERSION, MAX_PACKAGE, Package, PluginView, Plugins, install, label, list, newer_than,
    read_package,
};
use crate::{ai::safe_endpoint, store::Store};
use reqwest::{Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    time::Duration,
};
use tauri::State;
use tokio::sync::Mutex;

const INDEX_VERSION: u32 = 1;
const MAX_INDEX: usize = 1024 * 1024;
const BUNDLED: &[&[u8]] = &[
    include_bytes!("../../../examples/plugins/trim-lines.yeyu-plugin.json"),
    include_bytes!("../../../examples/plugins/task-list.yeyu-plugin.json"),
    include_bytes!("../../../examples/plugins/heading-levels.yeyu-plugin.json"),
];

#[derive(Default)]
pub struct Market(Mutex<Option<Catalog>>);

#[derive(Clone, Deserialize, Serialize)]
struct Details {
    description: String,
    author: String,
    license: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Listing {
    api_version: u32,
    id: String,
    name: String,
    version: String,
    sha256: String,
    #[serde(flatten)]
    details: Details,
}

#[derive(Deserialize)]
struct EmbeddedPackage {
    #[serde(flatten)]
    manifest: Package,
    market: Details,
}

#[derive(Deserialize)]
struct RemoteListing {
    #[serde(flatten)]
    entry: Listing,
    download: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    schema_version: u32,
    name: String,
    plugins: Vec<RemoteListing>,
}

enum Location {
    Bundled(&'static [u8]),
    Download(Url),
}

struct Offer {
    entry: Listing,
    version: Version,
    location: Location,
}

struct Catalog {
    name: String,
    source: Option<Url>,
    offers: Vec<Offer>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Availability {
    Install,
    Update,
    Installed,
    Incompatible,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfferView {
    #[serde(flatten)]
    entry: Listing,
    availability: Availability,
    installed_version: Option<String>,
}

#[derive(Serialize)]
pub struct CatalogView {
    name: String,
    source: Option<String>,
    plugins: Vec<OfferView>,
}

#[derive(Serialize)]
pub struct InstallResult {
    installed: Vec<PluginView>,
    catalog: CatalogView,
}

fn checksum(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl Offer {
    fn new(entry: Listing, location: Location) -> Result<Self, String> {
        let description = &entry.details.description;
        if !super::identifier(&entry.id, true)
            || !label(&entry.name)
            || !label(&entry.version)
            || !label(&entry.details.author)
            || !label(&entry.details.license)
            || description.trim().is_empty()
            || description.chars().count() > 600
            || description.chars().any(char::is_control)
            || entry.sha256.len() != 64
            || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || entry.api_version == 0
        {
            return Err("市场目录包含无效的插件资料".into());
        }
        let version = Version::parse(&entry.version)
            .map_err(|_| format!("插件“{}”的版本须符合 SemVer", entry.name))?;
        Ok(Self {
            entry,
            version,
            location,
        })
    }

    fn decode(&self, bytes: &[u8]) -> Result<Package, String> {
        if !self.entry.sha256.eq_ignore_ascii_case(&checksum(bytes)) {
            return Err("插件包校验失败，请刷新市场后重试".into());
        }
        let package = read_package(bytes)?;
        if package.id != self.entry.id
            || package.name != self.entry.name
            || package.version != self.entry.version
            || package.api_version != self.entry.api_version
        {
            return Err("插件包与市场目录中的名称、身份或版本不一致".into());
        }
        Ok(package)
    }

    fn view(&self, installed: Option<&str>) -> OfferView {
        let availability = match installed {
            _ if self.entry.api_version != API_VERSION => Availability::Incompatible,
            None => Availability::Install,
            Some(current) if newer_than(&self.version, current) => Availability::Update,
            Some(_) => Availability::Installed,
        };
        OfferView {
            entry: self.entry.clone(),
            availability,
            installed_version: installed.map(str::to_owned),
        }
    }
}

impl Catalog {
    fn bundled() -> Result<Self, String> {
        let offers = BUNDLED
            .iter()
            .map(|bytes| {
                let EmbeddedPackage { manifest, market } = serde_json::from_slice(bytes)
                    .map_err(|error| format!("无法读取内置市场：{error}"))?;
                Offer::new(
                    Listing {
                        api_version: manifest.api_version,
                        id: manifest.id,
                        name: manifest.name,
                        version: manifest.version,
                        sha256: checksum(bytes),
                        details: market,
                    },
                    Location::Bundled(bytes),
                )
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            name: "页屿内置市场".into(),
            source: None,
            offers,
        })
    }

    fn remote(source: Url, bytes: &[u8]) -> Result<Self, String> {
        let index: Index =
            serde_json::from_slice(bytes).map_err(|error| format!("无法读取市场目录：{error}"))?;
        if index.schema_version != INDEX_VERSION || !label(&index.name) {
            return Err("市场目录格式不受支持，请填写版本 1 的目录地址".into());
        }
        let mut ids = BTreeSet::new();
        let mut offers = Vec::new();
        for plugin in index.plugins {
            if plugin.download.trim().is_empty() || !ids.insert(plugin.entry.id.clone()) {
                return Err("市场目录缺少下载地址或包含重复的插件 ID".into());
            }
            let url = source
                .join(&plugin.download)
                .map_err(|_| "插件下载地址无效")?;
            let url = safe_endpoint(url.as_str())?;
            // 公网目录只能指向 HTTPS，回环 HTTP 交给同一端口上的目录服务。
            if url.scheme() == "http" && url.origin() != source.origin() {
                return Err("插件的本机下载地址须与市场目录同源".into());
            }
            offers.push(Offer::new(plugin.entry, Location::Download(url))?);
        }
        Ok(Self {
            name: index.name,
            source: Some(source),
            offers,
        })
    }

    fn view(&self, plugins: &[PluginView]) -> CatalogView {
        let installed: HashMap<_, _> = plugins
            .iter()
            .map(|plugin| (plugin.id.as_str(), plugin.version.as_str()))
            .collect();
        CatalogView {
            name: self.name.clone(),
            source: self.source.as_ref().map(Url::to_string),
            plugins: self
                .offers
                .iter()
                .map(|offer| offer.view(installed.get(offer.entry.id.as_str()).copied()))
                .collect(),
        }
    }
}

async fn download(http: &Client, url: Url, limit: usize, label: &str) -> Result<Vec<u8>, String> {
    let failure = |error: reqwest::Error| format!("无法读取{label}：{}", error.without_url());
    let mut response = http
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(failure)?;
    if !response.status().is_success() {
        return Err(format!(
            "无法读取{label}（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let too_large = || format!("{label}超过 {} MiB", limit / (1024 * 1024));
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(failure)? {
        if chunk.len() > limit - bytes.len() {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn plugin_market_list(
    source: Option<String>,
    refresh: bool,
    market: State<'_, Market>,
    store: State<'_, Store>,
    plugins: State<'_, Plugins>,
    http: State<'_, Client>,
) -> Result<CatalogView, String> {
    let source = source.as_deref().map(safe_endpoint).transpose()?;
    let mut catalog = market.0.lock().await;
    if refresh
        || catalog
            .as_ref()
            .is_none_or(|loaded| loaded.source != source)
    {
        let next = match source {
            None => Catalog::bundled()?,
            Some(url) => {
                let bytes = download(&http, url.clone(), MAX_INDEX, "市场目录").await?;
                Catalog::remote(url, &bytes)?
            }
        };
        *catalog = Some(next);
    }
    let installed = list(&store, &plugins)?;
    Ok(catalog.as_ref().expect("已加载市场目录").view(&installed))
}

#[tauri::command]
pub async fn plugin_market_install(
    source: Option<String>,
    id: String,
    sha256: String,
    market: State<'_, Market>,
    store: State<'_, Store>,
    plugins: State<'_, Plugins>,
    http: State<'_, Client>,
) -> Result<InstallResult, String> {
    let source = source.as_deref().map(safe_endpoint).transpose()?;
    let snapshot = market.0.lock().await;
    let catalog = snapshot
        .as_ref()
        .filter(|catalog| catalog.source == source)
        .ok_or("市场目录已变动，请刷新后重试")?;
    // 使用用户看到的那一版目录项，避免刷新后按同一个 ID 装入其他包。
    let offer = catalog
        .offers
        .iter()
        .find(|offer| offer.entry.id == id && offer.entry.sha256 == sha256)
        .ok_or("插件目录项已变动，请刷新后重试")?;
    if offer.entry.api_version != API_VERSION {
        return Err(format!(
            "此插件需要版本 {} 的插件接口",
            offer.entry.api_version
        ));
    }
    let package = match &offer.location {
        Location::Bundled(bytes) => offer.decode(bytes)?,
        Location::Download(url) => {
            let bytes = download(&http, url.clone(), MAX_PACKAGE, "插件包").await?;
            offer.decode(&bytes)?
        }
    };
    let installed = install(&store, &plugins, package, Some(&offer.version))?;
    Ok(InstallResult {
        catalog: catalog.view(&installed),
        installed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bundles_install_and_version_checks_preserve_existing_records() {
        let catalog = Catalog::bundled().unwrap();
        assert_eq!(catalog.offers.len(), 3);
        let directory = tempfile::tempdir().unwrap();
        let store = Store(directory.path().to_path_buf());
        let registry = Plugins::default();
        for offer in &catalog.offers {
            let Location::Bundled(bytes) = offer.location else {
                unreachable!()
            };
            let package = offer.decode(bytes).unwrap();
            let mut altered = bytes.to_vec();
            altered.push(b' ');
            assert!(offer.decode(&altered).is_err());
            install(&store, &registry, package.clone(), Some(&offer.version)).unwrap();
            assert!(install(&store, &registry, package, Some(&offer.version)).is_err());
        }
        let installed = list(&store, &registry).unwrap();
        assert_eq!(installed.len(), 3);
        assert!(installed.iter().all(|plugin| !plugin.enabled));
    }

    #[test]
    fn downloaded_catalog_pins_relative_url_package_and_semver() {
        let raw = BUNDLED[0];
        let catalog = Catalog::bundled().unwrap();
        let mut listing = serde_json::to_value(&catalog.offers[0].entry).unwrap();
        listing["version"] = "1.0.1".into();
        listing["download"] = "packages/trim-lines.yeyu-plugin.json".into();
        let index = json!({ "name": "开发目录", "schemaVersion": 1, "plugins": [listing] });
        let fetched = Catalog::remote(
            Url::parse("https://example.test/market/index.json").unwrap(),
            &serde_json::to_vec(&index).unwrap(),
        )
        .unwrap();
        let offer = &fetched.offers[0];
        let Location::Download(url) = &offer.location else {
            unreachable!()
        };
        assert_eq!(
            url.as_str(),
            "https://example.test/market/packages/trim-lines.yeyu-plugin.json"
        );
        assert!(matches!(
            offer.view(Some("1.0.0")).availability,
            Availability::Update
        ));
        assert!(matches!(
            offer.view(Some("1.1.0")).availability,
            Availability::Installed
        ));
        assert!(offer.decode(raw).is_err(), "摘要相同也要核对清单里的版本");
    }
}
