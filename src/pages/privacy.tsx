import React from "react";
import { Link } from "wouter";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <nav className="mb-8 text-sm">
          <Link href="/" className="text-muted-foreground hover:text-primary transition-colors">
            &larr; Back to GHS Label Maker
          </Link>
        </nav>

        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Last updated: April 14, 2026
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
              reports for processing. These files are held temporarily on our servers, sent to
              our AI processing provider for extraction, and the extracted data is returned to
              your browser and stored in your account's history for thirty (30) days. Raw
              uploaded files are not retained beyond the processing window.
            </p>

            <h3 className="text-base font-semibold mt-4 mb-2">2.3 Generated Output History</h3>
            <p>
              The structured data extracted from your uploads (chemical names, hazard statements,
              pictograms, and similar fields) is saved to your account's history for thirty days
              so that you can re-download or print prior outputs without re-processing the source
              file. History entries are deleted automatically after thirty days or when you
              request deletion.
            </p>

            <h3 className="text-base font-semibold mt-4 mb-2">2.4 Usage and IP Address</h3>
            <p>
              For fraud prevention and to enforce free-tier rate limits, the Service records the
              IP address of requests and the number of extractions performed. IP addresses are
              stored only in aggregate form linked to the pubkey or to an anonymous request
              count; they are not used for advertising or tracking across other sites.
            </p>

            <h3 className="text-base font-semibold mt-4 mb-2">2.5 Payment Information</h3>
            <p>
              Payment information differs by payment method:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>Lightning Network payments</strong> are settled directly between your
                wallet and our node. No card data, no billing address, and no personal
                information is collected. The Service records the payment amount and the
                resulting credit grant.
              </li>
              <li>
                <strong>Card or fiat payments</strong> (where available) are processed by our
                third-party Merchant of Record, Paddle.com Inc. Paddle collects and processes
                your payment information (card number, billing address, tax information) in
                accordance with its own privacy policy. We receive only a transaction identifier,
                the amount, and the purchased plan. We never see your full card number.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">3. Third Parties Who Process Your Data</h2>
            <p>The Service relies on the following third parties to operate:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>Anthropic (Claude API)</strong> — processes uploaded documents to extract
                hazard data. Anthropic does not use API traffic to train models. See Anthropic's
                privacy policy for details.
              </li>
              <li>
                <strong>api.txid.uk</strong> — provides Lightning Network authentication and
                stores the mapping between your Lightning pubkey and the Service's internal user
                record.
              </li>
              <li>
                <strong>Paddle</strong> — if you pay by card, Paddle acts as the Merchant of
                Record. Paddle's own Privacy Notice governs how it handles your payment data.
              </li>
              <li>
                <strong>Cloudflare</strong> — provides DNS, TLS termination, and DDoS protection
                for txid.uk domains. Cloudflare may log IP addresses and request metadata as part
                of its security services.
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
              <li><strong>Uploaded PDF files:</strong> deleted immediately after processing completes.</li>
              <li><strong>Generated output history:</strong> thirty (30) days.</li>
              <li><strong>Usage records and IP addresses:</strong> up to ninety (90) days, for billing and anti-abuse purposes.</li>
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
              All traffic to and from the Service is encrypted in transit using TLS. Server-side
              data is stored on hosts protected by operating-system-level access controls.
              Payment data handled by Paddle is subject to PCI-DSS requirements managed by
              Paddle, not by the operator. While we take reasonable measures to protect your
              data, no system can be guaranteed to be completely secure.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-8 mb-3">8. International Transfers</h2>
            <p>
              Because the Service uses third-party providers located outside the Republic of
              Korea (Anthropic and Cloudflare in the United States, Paddle in the United Kingdom
              and the United States), data you submit may be transferred to and processed in
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
    </div>
  );
}
