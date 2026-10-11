import Foundation

/// Resolves bundled (or cached) MLX weights for Parlance Coach.
enum ParlanceSLMModelLocator {

    private static let markerFile = "config.json"
    private static let fullWeightsFile = "model.safetensors"
    /// Tensors identical across every language's Gemma Coach live here once, so the app
    /// stays under the App Store thinned-size limit (see training/split_coach_weights.py).
    private static let sharedFolder = "parlance-coach-shared"
    private static let sharedWeightsFile = "model-shared.safetensors"
    private static let linkLock = NSLock()

    static func folderName(for language: String) -> String? {
        LanguageRegistry.onDeviceModelFolder(for: language)
    }

    /// Directory containing MLX `config.json` and all weights, if present.
    static func resolvedModelDirectory(language: String) -> URL? {
        guard let folder = folderName(for: language) else { return nil }
        if let bundled = bundledModelDirectory(folderName: folder) {
            if hasFile(fullWeightsFile, in: bundled) { return bundled }
            if let linked = linkedModelDirectory(folderName: folder, bundled: bundled) { return linked }
        }
        return applicationSupportDirectory(folderName: folder)
    }

    static func isModelBundled(language: String) -> Bool {
        guard let folder = folderName(for: language) else { return false }
        return bundledModelDirectory(folderName: folder) != nil
    }

    private static func bundledModelDirectory(folderName: String) -> URL? {
        guard let base = Bundle.main.resourceURL else { return nil }
        let dir = base.appendingPathComponent(folderName, isDirectory: true)
        return directoryIfValid(dir)
    }

    private static func applicationSupportDirectory(folderName: String) -> URL? {
        guard let base = parlanceSupportDirectory() else { return nil }
        return directoryIfValid(base.appendingPathComponent(folderName, isDirectory: true))
    }

    private static func parlanceSupportDirectory() -> URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("Parlance", isDirectory: true)
    }

    /// MLX loads every `*.safetensors` in one directory, so build a directory of symlinks:
    /// the language folder's files plus the shared weights. The bundle path changes on every
    /// app update, so links are rebuilt whenever they no longer point at the current bundle.
    private static func linkedModelDirectory(folderName: String, bundled: URL) -> URL? {
        guard let base = Bundle.main.resourceURL,
              let support = parlanceSupportDirectory() else { return nil }
        let shared = base
            .appendingPathComponent(sharedFolder, isDirectory: true)
            .appendingPathComponent(sharedWeightsFile)
        guard FileManager.default.fileExists(atPath: shared.path) else { return nil }

        let linked = support
            .appendingPathComponent("linked", isDirectory: true)
            .appendingPathComponent(folderName, isDirectory: true)

        linkLock.lock()
        defer { linkLock.unlock() }

        let fm = FileManager.default
        let sharedLink = linked.appendingPathComponent(sharedWeightsFile)
        if (try? fm.destinationOfSymbolicLink(atPath: sharedLink.path)) == shared.path,
           let current = directoryIfValid(linked),
           (try? fm.destinationOfSymbolicLink(atPath: current.appendingPathComponent(markerFile).path))
               == bundled.appendingPathComponent(markerFile).path {
            return current
        }

        do {
            try? fm.removeItem(at: linked)
            try fm.createDirectory(at: linked, withIntermediateDirectories: true)
            for name in try fm.contentsOfDirectory(atPath: bundled.path) {
                try fm.createSymbolicLink(
                    at: linked.appendingPathComponent(name),
                    withDestinationURL: bundled.appendingPathComponent(name)
                )
            }
            try fm.createSymbolicLink(at: sharedLink, withDestinationURL: shared)
        } catch {
            print("[Parlance] Coach weight links failed:", error)
            try? fm.removeItem(at: linked)
            return nil
        }
        return directoryIfValid(linked)
    }

    private static func hasFile(_ name: String, in dir: URL) -> Bool {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path)
    }

    private static func directoryIfValid(_ dir: URL) -> URL? {
        let marker = dir.appendingPathComponent(markerFile)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: marker.path, isDirectory: &isDir),
              !isDir.boolValue else { return nil }
        return dir
    }
}
