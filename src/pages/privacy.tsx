import React from "react";
import { Link } from "wouter";

export default function Privacy() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <nav className="mb-8 text-sm">
          <Link href="/" className="text-muted-foreground hover:text-primary transition-colors">
            &larr; Back to GHS Label Maker
          </Link>
        </nav>

        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Last updated: November 14, 2026
        </p>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6 text-sm leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">1. Overview</h2>
            <p>
              This Privacy Policy explains what information GHS Label Maker (ghs.txid.uk)
              collects, how it is used, and the choices available to you. The Service is designed
              to collect as little personal information as technically possible. It does not ask
              for, and does not store, names, email addresses, phone numbers, or physical
              addresses unless you voluntarily provide them for payment or support purposes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">2. Information We Collect</h2>

            <h3 className="text-base font-semibold mt-4 mb-2">2.1 Lightning Public Key</h3>
            <p>
              When you sign in with a Lightning Network wallet, the Service receives a public key
              that identifies your wallet. This public key acts as your user identifier. It is
              not linked to your real-world identity unless you choose to associate it with one.
            </p>

            <h3 className="text-base font-semibold mt-4 mb-2">2.2 Uploaded Documents</h3>
            <p>
              You may upload PDF documents such as Safety Data Sheets (SDS/MSDS) or battery test
              reports for processing. These files are held only in the server's memory while
              they are processed and are never written to disk. The server extracts the text of
              each file and sends up to the first 15,000 characters of it to the AI model
              described in section 3. The extracted data is returned to your browser and, if you
              are signed in, stored in your account's history for thirty (30) days.
            </p>

            <h3 className="text-base font-semibold mt-4 mb-2">2.3 Generated Output History</h3>
            <p>
              The structured data extracted from your uploads (chemical names, hazard statements,
              pictograms, and similar fields) is saved to your account's history for thirty days
              so that you can re-download or print prior outputs without re-processing the source
              file. History entries are deleted automatically after thirty days. You can also
              delete any entry yourself from the history list on the main page, or ask us to
              delete it.
            </p>

            <h3 className="text-base font-semibold mt-4 mb-2">2.4 Usage and IP Address</h3>
            <p>
              To enforce the free-tier limit and prevent abuse, the Service keeps a record of
              each successful extraction: the time, your pubkey if you are signed in, and the
              IP address of the request. If you are signed in, the IP address in these records
              is deleted after ninety (90) days. If you are not signed in, the IP address is the
              only key for the lifetime free-tier limit, so after ninety days it is replaced with
              a pseudonym — a keyed hash that cannot be turned back into the address — which is
              used only for that count. IP addresses are not used for advertising or for tracking
              across other sites.
            </p>

            <h3 className="text-base font-semibold mt-4 mb-2">2.5 Payment Information</h3>
            <p>
              Payments are made over the Bitcoin Lightning Network and are settled directly
              between your wallet and our node. No card data, no billing address, and no
              personal information is collected. The Service records the payment amount and the
              resulting credit grant.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">3. Third Parties Who Process Your Data</h2>
            <p>The Service relies on the following third parties to operate:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>AI extraction</strong> — the extracted document text is normally
                processed by a language model running on a machine operated by the Service's
                operator; in that case it is not sent to any third party. Only if that model is
                unavailable is the text sent to <strong>Anthropic (Claude API)</strong> instead.
                Anthropic does not use API traffic to train models. See Anthropic's privacy
                policy for details.
              </li>
              <li>
                <strong>api.txid.uk</strong> — provides Lightning Network authentication and
                stores the mapping between your Lightning pubkey and the Service's internal user
                record.
              </li>
            </ul>
            <p>
              We do not sell or rent your data to any third party. We do not share your data
              except as necessary to provide the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">4. Cookies and Local Storage</h2>
            <p>
              The Service uses browser cookies and local storage for:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Authentication (the shared txid.uk session cookie issued by api.txid.uk)</li>
              <li>Dark mode preference</li>
              <li>A transient CSRF token for secure API calls</li>
            </ul>
            <p>
              We do not use advertising cookies or cross-site tracking pixels.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">5. Data Retention</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Uploaded PDF files:</strong> held in memory only; discarded when processing completes.</li>
              <li><strong>Generated output history:</strong> thirty (30) days, or until you delete the entry.</li>
              <li><strong>Usage records (time and pubkey):</strong> kept for free-tier and billing accounting.</li>
              <li><strong>IP addresses in usage records:</strong> deleted after ninety (90) days if you were signed in; replaced with an irreversible pseudonym after ninety (90) days if you were not.</li>
              <li><strong>Payment records:</strong> retained for the period required by applicable tax and accounting law (typically five years in the Republic of Korea).</li>
              <li><strong>Lightning pubkey and credit balance:</strong> retained for as long as your account is active. On account deletion, the record is anonymised.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">6. Your Rights</h2>
            <p>
              Subject to applicable privacy law, you have the right to request access to,
              correction of, or deletion of the personal information associated with your
              account. Because most of the account identifier is a Lightning public key rather
              than a real-world identifier, the operator may ask you to prove control of the
              wallet before acting on such a request.
            </p>
            <p>
              Users in the European Economic Area, the United Kingdom, and the Republic of Korea
              additionally have the rights granted by GDPR, UK GDPR, and the Korean Personal
              Information Protection Act (PIPA), respectively. To exercise any of these rights,
              email{" "}
              <a href="mailto:admin@txid.uk" className="text-primary underline">
                admin@txid.uk
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">7. Data Security</h2>
            <p>
              All traffic to and from the Service is encrypted in transit using TLS, which is
              terminated on the Service's own server (no CDN or proxy sits in between). Server-side
              data is stored on hosts protected by operating-system-level access controls.
              While we take reasonable measures to protect your
              data, no system can be guaranteed to be completely secure.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">8. International Transfers</h2>
            <p>
              Because the Service uses third-party providers located outside the Republic of
              Korea (Anthropic in the United States, only when the fallback model is used), data you submit may be transferred to and processed in
              countries with different data protection rules than your own. We rely on the
              standard contractual clauses and other safeguards offered by these providers.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">9. Children's Privacy</h2>
            <p>
              The Service is not directed to individuals under the age of 14 and we do not
              knowingly collect personal information from children. If you believe we have
              received information from a child, please contact us and we will promptly delete
              it.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">10. Changes to this Policy</h2>
            <p>
              The operator may update this Privacy Policy from time to time. The "Last updated"
              date at the top of this page reflects the most recent revision. Material changes
              will be announced on the Service's home page for at least thirty days.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">11. Contact</h2>
            <p>
              Questions about this Privacy Policy or requests to exercise your rights can be
              sent to{" "}
              <a href="mailto:admin@txid.uk" className="text-primary underline">
                admin@txid.uk
              </a>.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-6 border-t text-xs text-muted-foreground flex gap-4">
          <Link href="/" className="hover:text-primary transition-colors">Home</Link>
          <Link href="/terms" className="hover:text-primary transition-colors">Terms of Service</Link>
        </div>
      </div>
    </main>
  );
}
