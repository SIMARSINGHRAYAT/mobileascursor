import Link from "next/link";

export default function WelcomePage() {
  return (
    <main className="futuristic-bg relative grid min-h-screen place-items-center px-6 py-10">
      <section className="glass-card gradient-border relative w-full max-w-4xl rounded-3xl px-8 py-14 text-center sm:px-12">
        <p className="mb-5 text-xs uppercase tracking-[0.28em] text-cyan-200/80">Wireless Desktop Control</p>
        <h1 className="bg-gradient-to-r from-violet-400 via-cyan-300 to-pink-400 bg-clip-text text-[clamp(2rem,6vw,4.5rem)] font-black leading-[1.06] text-transparent">
          Mobile as Cursor
        </h1>
        <p className="mx-auto mt-5 max-w-3xl text-[clamp(0.95rem,2.4vw,1.3rem)] italic text-slate-100/90">
          Turn Your Smartphone Into a Wireless Mouse — Control Your Computer With Just a Touch.
        </p>

        <div className="mt-10 flex justify-center">
          <Link
            href="/dashboard"
            className="glossy-button gradient-border rounded-full bg-white/10 px-8 py-3 text-base font-semibold text-white transition duration-200 hover:scale-[1.02] hover:bg-white/15 active:scale-[0.98]"
          >
            Get Started
          </Link>
        </div>
      </section>
    </main>
  );
}
