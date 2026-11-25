use super::{Command, MAX_TEXT};
use crate::store::err;
use rquickjs::{CatchResultExt, Context, Function, Module, Runtime, module::Evaluated};
use std::time::{Duration, Instant};

fn with_module<T>(
    source: &str,
    task: impl for<'js> FnOnce(&Module<'js, Evaluated>) -> rquickjs::Result<T>,
) -> Result<T, String> {
    let runtime = Runtime::new().map_err(err)?;
    runtime.set_memory_limit(32 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let deadline = Instant::now() + Duration::from_secs(2);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(err)?;
    // 独立的 QuickJS 上下文只注册语言内建对象。插件模块没有加载器或宿主 I/O 接口。
    context.with(|ctx| {
        let result = (|| {
            let (module, evaluated) =
                Module::declare(ctx.clone(), "plugin.js", source.as_bytes())?.eval()?;
            evaluated.finish::<()>()?;
            task(&module)
        })();
        result.catch(&ctx).map_err(|error| {
            if Instant::now() >= deadline {
                "JavaScript 插件执行超时".into()
            } else {
                format!("JavaScript 插件执行失败：{error}")
            }
        })
    })
}

pub(super) fn validate(source: &str, commands: &[Command]) -> Result<(), String> {
    with_module(source, |module| {
        for command in commands {
            module.get::<_, Function>(command.id.as_str())?;
        }
        Ok(())
    })
}

pub(super) fn execute(source: &str, command: &str, text: &str) -> Result<String, String> {
    let output = with_module(source, |module| {
        module
            .get::<_, Function>(command)?
            .call::<_, String>((text,))
    })?;
    if output.len() > MAX_TEXT {
        return Err("插件结果超过 4 MiB".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_modules_transform_unicode_without_host_access() {
        let script = "export function run(text) {
            if (typeof fetch !== 'undefined' || typeof process !== 'undefined'
                || typeof require !== 'undefined' || typeof __TAURI_INTERNALS__ !== 'undefined')
                throw Error('unexpected host access');
            return text + '中文';
        }";
        assert_eq!(execute(script, "run", "已处理 ").unwrap(), "已处理 中文");
        let import = "import * as os from 'os'; export function run(text) { return text; }";
        assert!(execute(import, "run", "").is_err());
        assert!(execute("export function run() { return 1 }", "run", "").is_err());
    }

    #[test]
    fn nonterminating_script_is_interrupted() {
        let result = execute("export function run() { while (true) {} }", "run", "");
        assert_eq!(result.unwrap_err(), "JavaScript 插件执行超时");
    }
}
