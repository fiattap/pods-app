export default function Page() {
  return (
    <main className="min-h-screen bg-black px-4 py-12 text-white sm:px-6 sm:py-16">
      <article className="mx-auto max-w-[700px] space-y-8">
        <header className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-pink-400">
            THEPODS
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Privacy Policy
          </h1>
        </header>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">What We Collect</h2>
          <p className="leading-7 text-zinc-300">
            We may collect information you provide, such as your name and email
            address, along with usage data related to your account, pod
            participation, rankings, matches, device, and interactions with the
            service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">What We Do Not Collect</h2>
          <p className="leading-7 text-zinc-300">
            The Pods does not collect or store voice recordings of pod
            conversations.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">How We Use Data</h2>
          <p className="leading-7 text-zinc-300">
            We use data to operate the service, support voice-based matching,
            maintain safety, prevent abuse, communicate with users, improve the
            product, and understand how people use The Pods.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Data Sharing</h2>
          <p className="leading-7 text-zinc-300">
            We may share limited data with service providers that help us run
            The Pods, such as Supabase for authentication, database, and
            infrastructure services. We do not sell your personal information.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Data Storage</h2>
          <p className="leading-7 text-zinc-300">
            We store account and usage data for as long as needed to provide the
            service, meet legal obligations, resolve disputes, improve safety,
            and maintain platform records.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Your Rights</h2>
          <p className="leading-7 text-zinc-300">
            You may request access to your data or ask us to delete your account
            by contacting us. Some information may be retained where required
            for safety, security, legal, or operational reasons.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Security Disclaimer</h2>
          <p className="leading-7 text-zinc-300">
            We use reasonable measures to protect personal information, but no
            online service can guarantee complete security. You use The Pods
            with that understanding.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Changes</h2>
          <p className="leading-7 text-zinc-300">
            We may update this Privacy Policy from time to time. Continued use
            of The Pods after changes are posted means you accept the updated
            policy.
          </p>
        </section>
      </article>
    </main>
  );
}
