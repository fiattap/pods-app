export default function Page() {
  return (
    <main className="min-h-screen bg-black px-4 py-12 text-white sm:px-6 sm:py-16">
      <article className="mx-auto max-w-[700px] space-y-8">
        <header className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-pink-400">
            THEPODS
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Terms of Service
          </h1>
        </header>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Overview</h2>
          <p className="leading-7 text-zinc-300">
            These Terms of Service govern your use of The Pods. By creating an
            account or joining a pod, you agree to follow these terms and use
            the platform responsibly.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Eligibility</h2>
          <p className="leading-7 text-zinc-300">
            You must be at least 18 years old to use The Pods. By using the
            service, you confirm that you meet this requirement.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">How Pods Works</h2>
          <p className="leading-7 text-zinc-300">
            The Pods offers voice-based matching experiences where users may
            join audio rooms, meet other participants, and indicate interest in
            connections. We do not guarantee matches, compatibility,
            relationships, attendance, or any specific outcome.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">User Conduct</h2>
          <p className="leading-7 text-zinc-300">
            You agree not to harass, threaten, abuse, impersonate, exploit, or
            harm other users. You may not record, capture, distribute, or share
            pod conversations without permission. Abuse of the platform may
            result in account restriction or removal.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Safety Disclaimer</h2>
          <p className="leading-7 text-zinc-300">
            We do not verify every user&apos;s identity, background, age, or
            intentions. You are responsible for exercising caution and judgment
            when interacting with others on or off the platform.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Content</h2>
          <p className="leading-7 text-zinc-300">
            Pod conversations are not recorded by The Pods. You are responsible
            for what you say, share, and communicate while using the service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Termination</h2>
          <p className="leading-7 text-zinc-300">
            We may suspend or terminate access to The Pods if we believe a user
            has violated these terms, created safety concerns, or misused the
            service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Liability</h2>
          <p className="leading-7 text-zinc-300">
            The platform is provided &quot;as is&quot; without warranties of
            any kind. To the fullest extent permitted by law, The Pods is not
            liable for user conduct, missed connections, personal interactions,
            or outcomes arising from use of the service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Changes</h2>
          <p className="leading-7 text-zinc-300">
            We may update these terms from time to time. Continued use of The
            Pods after changes are posted means you accept the updated terms.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Contact</h2>
          <p className="leading-7 text-zinc-300">
            Questions about these terms can be sent to hello@thepods.com.
          </p>
        </section>
      </article>
    </main>
  );
}
