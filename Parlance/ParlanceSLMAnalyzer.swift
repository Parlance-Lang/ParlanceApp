import Foundation

/// Parlance Coach: on-device MLX inference (Spanish / French / English). Optional Mac dev server via UserDefaults.
enum ParlanceSLMAnalyzer {

    private static let devServerKey = "parlance_slm_dev_server"
    private static let supportedLanguages = LanguageRegistry.onDeviceSupportedCodes

    /// When true, routes to `http://127.0.0.1:8765` (training/parlance_slm_server.py) for development.
    static var useDevServer: Bool {
        get { UserDefaults.standard.bool(forKey: devServerKey) }
        set { UserDefaults.standard.set(newValue, forKey: devServerKey) }
    }

    static var serverURL: URL {
        let raw = UserDefaults.standard.string(forKey: "parlance_slm_server_url")
            ?? "http://127.0.0.1:8765"
        return URL(string: raw) ?? URL(string: "http://127.0.0.1:8765")!
    }

    static func isOnDeviceModelAvailable(language: String) -> Bool {
        ParlanceSLMModelLocator.resolvedModelDirectory(language: language) != nil
    }

    /// True if any bundled coach language is present.
    static var isOnDeviceModelAvailable: Bool {
        supportedLanguages.contains { isOnDeviceModelAvailable(language: $0) }
    }

    static func availableCoachLanguages() -> [String] {
        supportedLanguages.filter { isOnDeviceModelAvailable(language: $0) }
    }

    static func isAvailable(language: String) async -> Bool {
        if useDevServer { return await isServerReachable() }
        return isOnDeviceModelAvailable(language: language)
    }

    static func isAvailable() async -> Bool {
        if useDevServer { return await isServerReachable() }
        return isOnDeviceModelAvailable
    }

    static func isServerReachable() async -> Bool {
        let health = serverURL.appendingPathComponent("health")
        var request = URLRequest(url: health)
        request.timeoutInterval = 2
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    static func analyze(
        sentence: String,
        language: String,
        level: String,
        ragContext: String = ""
    ) async throws -> [String: Any] {
        if useDevServer {
            return try await analyzeViaDevServer(
                sentence: sentence, language: language, level: level, ragContext: ragContext
            )
        }
        return try await ParlanceSLMEngine.shared.analyze(
            sentence: sentence, language: language, level: level, ragContext: ragContext
        )
    }

    private static func analyzeViaDevServer(
        sentence: String,
        language: String,
        level: String,
        ragContext: String = ""
    ) async throws -> [String: Any] {
        guard await isServerReachable() else { throw ParlanceSLMError.serverOffline }

        var request = URLRequest(url: serverURL.appendingPathComponent("analyze"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 300

        let payload: [String: Any] = [
            "sentence": sentence,
            "language": language,
            "level": level,
            "ragContext": ragContext,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ParlanceSLMError.invalidResponse
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ParlanceSLMError.parseError
        }

        if http.statusCode != 200 {
            let msg = json["error"] as? String ?? "HTTP \(http.statusCode)"
            throw ParlanceSLMError.serverError(msg)
        }

        guard let feedback = json["feedback"] as? [String: Any] else {
            throw ParlanceSLMError.parseError
        }
        return feedback
    }
}

enum ParlanceSLMError: LocalizedError {
    case invalidResponse
    case parseError
    case serverError(String)
    case serverOffline
    case modelMissing
    case unsupportedLanguage

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from Parlance SLM server"
        case .parseError:
            return "Could not parse SLM response"
        case .serverError(let msg):
            return msg
        case .serverOffline:
            return """
            Parlance Coach dev server is not running. On your Mac, run:
            python3 training/parlance_slm_server.py
            Or disable dev server mode in the app.
            """
        case .modelMissing:
            return "Parlance Coach could not find its language model on this iPhone. Reinstall Parlance to restore it."
        case .unsupportedLanguage:
            return "Parlance Coach does not cover this Write language yet."
        }
    }
}
