import SwiftUI

/// Native privacy sheet — English content must match `Parlance/web/privacy.html`
/// (canonical source of truth). Mirror: `docs/privacy.html`. Web modal fetches
/// the same HTML. When editing the policy: update privacy.html, copy to docs/,
/// then sync these sections. Swift UI i18n is deferred (issue #25 follow-up).
struct PrivacyPolicyView: View {
    @Binding var isPresented: Bool
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private let intro =
        "Parlance: Interpreter Journal (\"Parlance\", \"we\", \"our\") is built for interpreters and language learners. This policy explains what data we collect, how we use it, and your rights."

    private let sections: [(title: String, body: String)] = [
        (
            "1. On-Device Analysis (Parlance Coach)",
            "When you use Parlance Coach, your sentences are analyzed entirely on your device using a locally stored language model. No sentence text is ever sent to our servers or any third party. This feature works without an internet connection."
        ),
        (
            "2. Cloud AI Analysis",
            "On the iPhone and Android apps, analysis runs on the device with Parlance Coach. Cloud AI is optional on the web app only. If you add an API key there, your sentence goes directly to the provider you chose (such as Groq, Gemini, or OpenAI). We do not proxy that request through our servers. Third-party providers process your input under their own privacy policies."
        ),
        (
            "3. Authentication",
            "The iPhone and Android apps do not require an account. Purchases use your App Store or Google Play account. Optional Sign in with Apple or Google may still appear on the web app. Review Apple's and Google's privacy policies for how they handle sign-in."
        ),
        (
            "4. Feedback Counter",
            "On the phones, the number of Coach analyses you have used is stored only on your device. The first 15 analyses are free. After that you can buy more analyses or subscribe to Parlance Plus. This count is not sent to our servers and is not used for advertising."
        ),
        (
            "5. In-App Purchases and Parlance Plus",
            "Parlance Plus and analysis packs are processed by Apple on iPhone and by Google Play on Android. After a successful purchase, the store keeps the receipt on your device. We do not receive or store your payment information.\n\nParlance Plus is an auto-renewing monthly subscription. On the phones it unlocks unlimited Coach analyses and the medical and legal interpreting guides. Billing, renewal, and cancellation are handled by Apple in your Apple Account settings, or by Google Play in your Google account subscriptions. We never receive your payment information."
        ),
        (
            "6. Journal Entries",
            "Journal entries (titles and sentences) are stored locally on your device. They are not uploaded to our servers."
        ),
        (
            "7. Analytics and Crash Reporting",
            "We do not use third-party analytics SDKs or crash reporting services that collect personal data."
        ),
        (
            "8. Data Retention and Deletion",
            "Journal entries and the on-device analysis count stay on your device. You can delete journal entries from Past Entries.\n\nIf you signed in on the web, you can delete that account from AI settings. That removes the sign-in account. It cannot be undone. If you subscribed to Parlance Plus, cancel the subscription separately in your Apple Account settings or Google Play subscriptions so billing stops.\n\nIf you cannot access the app, you can also contact us at the address below and we will remove any leftover account records within 30 days."
        ),
        (
            "9. Children",
            "Parlance is not directed at children under 13. We do not knowingly collect information from children under 13."
        ),
        (
            "10. Changes to This Policy",
            "We may update this policy. The \"Last updated\" date at the top will reflect any changes. Continued use of the app after changes constitutes acceptance."
        ),
        (
            "11. Contact",
            "Questions or deletion requests: email parlance.lang@gmail.com. You can also open an issue at github.com/Parlance-Lang/ParlanceApp/issues."
        ),
    ]

    var body: some View {
        ZStack {
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            VStack(spacing: 0) {
                HStack {
                    Text("Privacy Policy")
                        .font(.title2.weight(.semibold))
                    Spacer()
                    Button { isPresented = false } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityLabel("Close")
                }
                .padding()

                Divider()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Last updated: August 16, 2026")
                            .font(.footnote)
                            .foregroundColor(Color("Muted"))

                        Text(intro)
                            .font(.body)
                            .foregroundColor(Color("Ink"))
                            .fixedSize(horizontal: false, vertical: true)

                        ForEach(sections, id: \.title) { section in
                            policySection(title: section.title, body: section.body)
                        }
                    }
                    .padding()
                }
            }
            .background(Color("Paper"))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .shadow(radius: 20)
            .frame(maxWidth: horizontalSizeClass == .regular ? 640 : 520)
            .padding(horizontalSizeClass == .regular ? 40 : 24)
        }
        .transition(.opacity)
    }

    private func policySection(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
                .foregroundColor(Color("Ink"))
            Text(body)
                .font(.body)
                .foregroundColor(Color("Ink"))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
