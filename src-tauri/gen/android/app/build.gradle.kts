import java.util.Properties
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
plugins {
    id("com.android.application")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "io.yeyu.markdown"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "io.yeyu.markdown"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

val prepareWryKotlin = tasks.register<PrepareWryKotlin>("prepareWryKotlin") {
    sourceDirectory.set(layout.projectDirectory.dir("src/main/java/io/yeyu/markdown/generated"))
    outputDirectory.set(layout.buildDirectory.dir("generated/yeyu-wry"))
}
extensions.configure<ApplicationAndroidComponentsExtension>("androidComponents") {
    finalizeDsl { dsl ->
        dsl.sourceSets.named("main") {
            // Wry 的原始文件由 Tauri 生成，编译时使用 Gradle 准备的副本。
            java.directories.clear()
            kotlin.directories.clear()
            kotlin.directories.add("src/main/kotlin")
        }
    }
    onVariants { variant ->
        variant.sources.kotlin?.addGeneratedSourceDirectory(prepareWryKotlin, PrepareWryKotlin::outputDirectory)
    }
}
