package io.yeyu.markdown

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintManager
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.ActivityResult
import androidx.core.view.WindowCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

@InvokeArg
class PickDocumentArgs { var name: String? = null; var mime: String? = null; var multiple: Boolean = false }

@InvokeArg
class WorkspaceArgs { lateinit var uri: String }

@InvokeArg
class PrintArgs { lateinit var name: String; lateinit var html: String }

@InvokeArg
class DescriptorArgs { lateinit var uri: String; var write: Boolean = false }

@InvokeArg
class AppearanceArgs { var light: Boolean = true; lateinit var color: String }

@InvokeArg
class BackNavigationArgs { var enabled: Boolean = false; var animated: Boolean = false }

@InvokeArg
class UpdateArgs { lateinit var url: String }

@TauriPlugin
class MarkdownDocuments(private val activity: Activity) : Plugin(activity) {
    private val grants = ConcurrentHashMap<Uri, Int>()
    private val fileWorker = Executors.newSingleThreadExecutor()

    @Command
    fun pickDocument(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(PickDocumentArgs::class.java)
            val name = args.name
            val intent = Intent(if (name == null) Intent.ACTION_OPEN_DOCUMENT else Intent.ACTION_CREATE_DOCUMENT)
            intent.addCategory(Intent.CATEGORY_OPENABLE)
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            if (name == null) {
                // 部分文件提供方把 .md 上报为普通文本或二进制，打开时由 Rust 验证 UTF-8。
                intent.type = "*/*"
                intent.putExtra(Intent.EXTRA_MIME_TYPES, args.mime?.let { arrayOf(it, "text/plain", "application/octet-stream") }
                    ?: arrayOf("text/*", "application/octet-stream"))
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
            } else {
                intent.type = args.mime ?: "text/markdown"
                intent.putExtra(Intent.EXTRA_TITLE, name)
            }
            startActivityForResult(invoke, intent, "documentPicked")
        } catch (error: Exception) {
            invoke.reject("无法打开系统文件选择器", error)
        }
    }

    @Command
    fun pickWorkspace(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            startActivityForResult(invoke, intent, "documentPicked")
        } catch (error: Exception) {
            invoke.reject("无法打开系统文件夹选择器", error)
        }
    }

    @ActivityCallback
    fun documentPicked(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            invoke.resolve(JSObject())
            return
        }
        val uris = (data.clipData?.let { clip -> List(clip.itemCount) { clip.getItemAt(it).uri } } ?: listOf(data.data))
            .filterNotNull().filter { it.scheme == "content" }.distinct()
        if (uris.isEmpty()) {
            invoke.reject("文件提供方没有返回可访问的文档")
            return
        }
        val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        for (uri in uris) {
            grants[uri] = (grants[uri] ?: 0) or flags
            try {
                activity.contentResolver.takePersistableUriPermission(uri, flags)
            } catch (_: SecurityException) {
                // 提供方仅授予临时访问时，仍可在当前会话中打开。
            }
        }
        invoke.resolve(JSObject().put("uri", uris.first().toString()).put("uris", JSONArray(uris.map { it.toString() })))
    }

    private fun grantFlags(uri: Uri): Int {
        val saved = activity.contentResolver.persistedUriPermissions.firstOrNull { it.uri == uri }
        var flags = grants[uri] ?: 0
        if (saved?.isReadPermission == true) flags = flags or Intent.FLAG_GRANT_READ_URI_PERMISSION
        if (saved?.isWritePermission == true) flags = flags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        return flags
    }

    @Command
    fun workspace(invoke: Invoke) = fileWorker.execute {
        try {
            val tree = Uri.parse(invoke.parseArgs(WorkspaceArgs::class.java).uri)
            require(tree.scheme == "content" && DocumentsContract.isTreeUri(tree) &&
                (grantFlags(tree) and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0) { "工作区权限已失效，请重新选择文件夹" }
            val resolver = activity.contentResolver
            val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE)
            val markdownExtensions = setOf("md", "markdown", "mdown", "mkd")
            val entries = JSONArray()
            var visited = 0
            fun scan(id: String, prefix: String, depth: Int) {
                val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
                resolver.query(children, columns, null, null, null)?.use { cursor ->
                    while (cursor.moveToNext()) {
                        require(++visited <= 4096 && depth <= 24) { "目录项过多，请打开更具体的文件夹" }
                        val name = cursor.getString(1)
                        val path = prefix + name
                        if (cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) scan(cursor.getString(0), "$path/", depth + 1)
                        else if (name.contains('.') && name.substringAfterLast('.').lowercase() in markdownExtensions) {
                            val uri = DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0))
                            entries.put(JSObject().put("uri", uri.toString()).put("path", path).put("name", name))
                        }
                    }
                } ?: error("文件提供方无法列出目录")
            }
            scan(DocumentsContract.getTreeDocumentId(tree), "", 0)
            invoke.resolve(JSObject().put("entries", entries))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法读取工作区，请重新选取文件夹", error)
        }
    }

    @Command
    fun descriptor(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(DescriptorArgs::class.java)
            val uri = Uri.parse(args.uri)
            val resolver = activity.contentResolver
            val flags = if (DocumentsContract.isTreeUri(uri)) {
                val tree = DocumentsContract.buildTreeDocumentUri(requireNotNull(uri.authority), DocumentsContract.getTreeDocumentId(uri))
                grantFlags(tree) or grantFlags(uri)
            } else grantFlags(uri)
            val canRead = (flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0
            val canWrite = (flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0
            if (uri.scheme != "content" || !canRead || (args.write && !canWrite)) {
                invoke.reject("文档访问权限已失效或文件为只读，请重新打开文件或另存副本")
                return
            }
            val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            } ?: "未命名.md"
            val fd = resolver.openFileDescriptor(uri, if (args.write) "rw" else "r")?.use { it.detachFd() }
            if (fd == null) {
                invoke.reject("文件提供方没有返回本机可读的文档")
                return
            }
            invoke.resolve(JSObject().put("fd", fd).put("name", name).put("writable", canWrite))
        } catch (error: Exception) {
            invoke.reject("无法访问文档，请检查文件位置和权限", error)
        }
    }

    @Command
    fun insets(invoke: Invoke) {
        activity.runOnUiThread { invoke.resolve((activity as MainActivity).webInsets) }
    }

    @Command
    fun backNavigation(invoke: Invoke) {
        val args = invoke.parseArgs(BackNavigationArgs::class.java)
        activity.runOnUiThread {
            (activity as MainActivity).setBackNavigation(args.enabled, args.animated)
            invoke.resolve()
        }
    }

    @Command
    fun printHtml(invoke: Invoke) {
        val args = invoke.parseArgs(PrintArgs::class.java)
        activity.runOnUiThread {
            val webView = WebView(activity)
            webView.settings.blockNetworkLoads = true
            webView.settings.allowFileAccess = false
            webView.settings.allowContentAccess = false
            webView.webViewClient = object : WebViewClient() {
                private var started = false
                override fun onPageFinished(view: WebView, url: String) {
                    if (started) return
                    started = true
                    try {
                        val manager = activity.getSystemService(PrintManager::class.java)
                            ?: error("设备没有可用的打印服务")
                        val adapter = view.createPrintDocumentAdapter(args.name)
                        // 打印预览结束前保留独立 WebView，避免离开编辑页或闭合弹窗影响导出。
                        manager.print(args.name, object : PrintDocumentAdapter() {
                            override fun onStart() { adapter.onStart() }
                            override fun onLayout(old: PrintAttributes, next: PrintAttributes, signal: CancellationSignal,
                                callback: LayoutResultCallback, extras: Bundle) { adapter.onLayout(old, next, signal, callback, extras) }
                            override fun onWrite(pages: Array<out PageRange>, destination: ParcelFileDescriptor, signal: CancellationSignal,
                                callback: WriteResultCallback) { adapter.onWrite(pages, destination, signal, callback) }
                            override fun onFinish() { adapter.onFinish(); view.destroy() }
                        }, PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build())
                        invoke.resolve()
                    } catch (error: Exception) {
                        view.destroy()
                        invoke.reject("无法打开系统打印预览", error)
                    }
                }
            }
            webView.loadDataWithBaseURL(null, args.html, "text/html", "UTF-8", null)
        }
    }

    @Command
    fun appearance(invoke: Invoke) {
        val args = invoke.parseArgs(AppearanceArgs::class.java)
        activity.runOnUiThread {
            try {
                val content = activity.findViewById<android.view.View>(android.R.id.content)
                content.setBackgroundColor(Color.parseColor(args.color))
                val bars = WindowCompat.getInsetsController(activity.window, content)
                bars.isAppearanceLightStatusBars = args.light
                bars.isAppearanceLightNavigationBars = args.light
                invoke.resolve()
            } catch (error: IllegalArgumentException) {
                invoke.reject("无法应用系统栏配色", error)
            }
        }
    }

    @Command
    fun downloadUpdate(invoke: Invoke) {
        try {
            val uri = Uri.parse(invoke.parseArgs(UpdateArgs::class.java).url)
            val path = uri.path.orEmpty()
            if (uri.scheme != "https" || uri.host != "github.com" ||
                !path.startsWith("/Lw5959/yeyu/releases/download/") || !path.endsWith("_android-arm64.apk")) {
                invoke.reject("更新地址与页屿 GitHub 发布仓库不匹配")
                return
            }
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject("无法打开 GitHub APK 下载", error)
        }
    }
}
