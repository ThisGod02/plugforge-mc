plugins {
    java
}

group = "{{package}}"
version = "1.0.0"

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:{{paperApi}}")

    testImplementation("io.papermc.paper:paper-api:{{paperApi}}")
    testImplementation("{{mockbukkitArtifact}}:{{mockbukkitVersion}}")
    testImplementation(platform("org.junit:junit-bom:{{junit}}"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release = 21
}

tasks.processResources {
    filesMatching("plugin.yml") {
        expand("version" to project.version)
    }
}

tasks.test {
    useJUnitPlatform()
}
