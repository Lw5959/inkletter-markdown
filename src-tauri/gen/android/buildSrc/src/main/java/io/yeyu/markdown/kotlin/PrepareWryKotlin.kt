import javax.inject.Inject
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

abstract class PrepareWryKotlin : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceDirectory: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @get:Inject
    abstract val files: FileSystemOperations

    @TaskAction
    fun prepare() {
        files.sync {
            from(sourceDirectory)
            include("*.kt")
            into(outputDirectory)
            // Web SQL 开关已废弃，DOM storage 由独立的设置管理。
            filesMatching("RustWebView.kt") {
                filter { line: String -> if (line.trim() == "settings.databaseEnabled = true") "" else line }
            }
            filesMatching("WryActivity.kt") {
                filter { line: String ->
                    line.replace(
                        "this@WryActivity.onBackPressed()",
                        "this@WryActivity.onBackPressedDispatcher.onBackPressed()",
                    )
                }
            }
        }
    }
}
